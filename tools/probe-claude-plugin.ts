/**
 * Проба плагина Claude Code в стороннем репозитории-потребителе (c10.2; ADR 0008 —
 * «Плагин Claude Code … дополняет решение, а не заменяет»).
 *
 * Что делает: собирает чистый репозиторий-потребитель (скелет из шаблонных tools/:
 * hooks-CLI, protected-paths, analyze-command, snapshot — ровно то, что копирует
 * copier; своей .claude/ нет), подключает плагин `agent-harness` project-скоупом
 * (user-конфиг не трогается) и проверяет критерии приёмки c10.2:
 *   1. инвентарь: скилы и ревьюеры плагина установлены в кэш — 1:1 с .claude/;
 *   2. проводка: hooks.json плагина повторяет hooks из .claude/settings.json 1:1
 *      (события, matcher'ы, таймауты; команды отличаются только префиксом пути —
 *      CLI резолвится относительно репозитория-потребителя, c10.1);
 *   3. хук блокирует ослабление гейта: guard-bash запрещает `--no-verify`,
 *      protect-paths запрещает запись в защищённый файл, benign-вызовы проходят;
 *   4. скил вызывается: headless `claude -p` в потребителе вызывает Skill
 *      `agent-harness:feature-workflow` (нужны `claude` CLI и авторизация;
 *      детерминированные проверки 1–3 работают без неё — `--skip-llm`).
 *
 * Не гейт: гоняется вручную и как доказательство в PR; артефакты в
 * reports/plugin-probe/ (вне git).
 *
 *   pnpm probe:plugin [--skip-llm]
 */
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const repoRoot = join(import.meta.dirname, '..');
const probeDir = join(repoRoot, 'reports', 'plugin-probe');
const consumerDir = join(probeDir, 'consumer');
const marketplaceName = 'agentic-monorepo-template';
const pluginName = 'agent-harness';
const pluginRef = `${pluginName}@${marketplaceName}`;

interface HookCommand {
  type: string;
  command: string;
  timeout?: number;
}
interface HookMatcherGroup {
  /** У SessionStart/Stop групп matcher нет — отсутствие эквивалентно «» */
  matcher?: string;
  hooks: HookCommand[];
}
type HookEventMap = Record<string, HookMatcherGroup[]>;

class ProbeFailure extends Error {}

function run(
  command: string[],
  cwd: string,
  options: { input?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): { status: number; stdout: string; stderr: string } {
  const [file, ...args] = command;
  if (file === undefined) {
    throw new ProbeFailure('empty command');
  }
  // Хуки и claude не наследуют CLAUDE_* этой сессии: CLAUDE_PROJECT_DIR внутри
  // потребителя — путь потребителя, сессионные id — не их (чек-лист c10.1 п.4).
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('CLAUDE_') || key === 'CLAUDE_CONFIG_DIR') {
      env[key] = value;
    }
  }
  Object.assign(env, options.env);
  const result = spawnSync(file, args, {
    encoding: 'utf8',
    cwd,
    env,
    input: options.input ?? '',
    timeout: options.timeoutMs ?? 60_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error !== undefined) {
    return { status: -1, stdout: '', stderr: String(result.error) };
  }
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

function readJson(path: string): unknown {
  if (!existsSync(path)) {
    throw new ProbeFailure(`файл не найден: ${path}`);
  }
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function hookCommand(value: unknown, source: string, event: string): HookCommand {
  if (!isRecord(value) || typeof value['command'] !== 'string') {
    throw new ProbeFailure(`${source}: ${event} — команда хука без command`);
  }
  const timeout = value['timeout'];
  const command: HookCommand = {
    type: typeof value['type'] === 'string' ? value['type'] : 'command',
    command: value['command'],
  };
  if (typeof timeout === 'number') {
    command.timeout = timeout;
  }
  return command;
}

function hookEventMap(value: unknown, source: string): HookEventMap {
  if (!isRecord(value)) {
    throw new ProbeFailure(`${source}: ожидается объект`);
  }
  const map: HookEventMap = {};
  for (const [event, groups] of Object.entries(value)) {
    if (!Array.isArray(groups)) {
      throw new ProbeFailure(`${source}: ${event} — ожидается массив групп`);
    }
    map[event] = groups.map((group) => {
      if (!isRecord(group) || !Array.isArray(group['hooks'])) {
        throw new ProbeFailure(`${source}: группа ${event} без массива hooks`);
      }
      const mapped: HookMatcherGroup = {
        hooks: group['hooks'].map((hook) => hookCommand(hook, source, event)),
      };
      if (typeof group['matcher'] === 'string') {
        mapped.matcher = group['matcher'];
      }
      return mapped;
    });
  }
  return map;
}

function settingsHooks(): HookEventMap {
  const raw = readJson(join(repoRoot, '.claude', 'settings.json'));
  if (!isRecord(raw)) {
    throw new ProbeFailure('.claude/settings.json: ожидается объект');
  }
  return hookEventMap(raw['hooks'], '.claude/settings.json');
}

function pluginHooksFile(path: string, source: string): HookEventMap {
  const raw = readJson(path);
  if (!isRecord(raw) || !('hooks' in raw)) {
    throw new ProbeFailure(`${source}: ожидается объект с ключом "hooks"`);
  }
  return hookEventMap(raw['hooks'], source);
}

function pluginManifestVersion(): string {
  const manifest = readJson(join(repoRoot, '.claude', '.claude-plugin', 'plugin.json'));
  if (!isRecord(manifest)) {
    throw new ProbeFailure('plugin.json: ожидается объект');
  }
  const version = manifest['version'];
  if (typeof version !== 'string') {
    throw new ProbeFailure('plugin.json: нет версии');
  }
  return version;
}

/** Потребитель: скелет из шаблонных tools/, как после `copier copy` (без .claude/). */
function buildConsumer(): void {
  rmSync(probeDir, { recursive: true, force: true });
  mkdirSync(consumerDir, { recursive: true });
  cpSync(join(repoRoot, 'tools', 'hooks'), join(consumerDir, 'tools', 'hooks'), {
    recursive: true,
  });
  for (const file of [
    'protected-paths.ts',
    'protected-paths.json',
    'analyze-command.ts',
    'snapshot.ts',
  ]) {
    cpSync(join(repoRoot, 'tools', file), join(consumerDir, 'tools', file));
  }
  writeFileSync(
    join(consumerDir, 'package.json'),
    '{"name":"probe-consumer","private":true,"type":"module"}\n',
  );
  writeFileSync(join(consumerDir, '.gitignore'), '.claude/\nreports/\n');
  for (const command of [
    ['init', '-q', '.'],
    ['add', '-A'],
    [
      '-c',
      'user.email=probe@local',
      '-c',
      'user.name=probe',
      'commit',
      '-qm',
      'consumer skeleton: template tools',
    ],
  ]) {
    const result = run(['git', ...command], consumerDir);
    if (result.status !== 0) {
      throw new ProbeFailure(`потребитель не собрался (git ${command[0]}): ${result.stderr}`);
    }
  }
}

function installPlugin(): void {
  // Свежая установка: без этого install переиспользует кэш той же версии,
  // и проба проверила бы старые файлы, а не то, что уедет потребителю.
  const configDir = process.env['CLAUDE_CONFIG_DIR'] ?? join(homedir(), '.claude');
  for (const part of ['cache', 'marketplaces']) {
    rmSync(join(configDir, 'plugins', part, marketplaceName), { recursive: true, force: true });
  }
  const add = run(
    ['claude', 'plugin', 'marketplace', 'add', repoRoot, '--scope', 'project'],
    consumerDir,
  );
  if (add.status !== 0) {
    throw new ProbeFailure(`marketplace add не удался: ${add.stderr || add.stdout}`);
  }
  const install = run(
    ['claude', 'plugin', 'install', pluginRef, '--scope', 'project'],
    consumerDir,
  );
  if (install.status !== 0) {
    throw new ProbeFailure(`plugin install не удался: ${install.stderr || install.stdout}`);
  }
}

/** Кэш установленного плагина: то, что Claude Code реально исполняет. */
function installedPluginRoot(version: string): string {
  const configDir = process.env['CLAUDE_CONFIG_DIR'] ?? join(homedir(), '.claude');
  const root = join(configDir, 'plugins', 'cache', marketplaceName, pluginName, version);
  if (!existsSync(root)) {
    throw new ProbeFailure(`кэш плагина не найден: ${root}`);
  }
  return root;
}

function checkInventory(pluginRoot: string): void {
  const skillsDir = join(pluginRoot, 'skills');
  if (!statSync(skillsDir, { throwIfNoEntry: false })) {
    throw new ProbeFailure('в кэше плагина нет skills/');
  }
  const skills = readdirSync(skillsDir).filter((name) =>
    existsSync(join(skillsDir, name, 'SKILL.md')),
  );
  const expectedSkills = readdirSync(join(repoRoot, '.claude', 'skills')).filter((name) =>
    existsSync(join(repoRoot, '.claude', 'skills', name, 'SKILL.md')),
  );
  if (skills.length !== expectedSkills.length) {
    throw new ProbeFailure(
      `скилов в плагине ${skills.length}, в .claude/skills — ${expectedSkills.length}`,
    );
  }
  const agentsDir = join(pluginRoot, 'agents');
  const agents = statSync(agentsDir, { throwIfNoEntry: false })
    ? readdirSync(agentsDir).filter((name) => name.endsWith('.md'))
    : [];
  const expectedAgents = readdirSync(join(repoRoot, '.claude', 'agents')).filter((name) =>
    name.endsWith('.md'),
  );
  if (agents.length !== expectedAgents.length) {
    throw new ProbeFailure(
      `ревьюеров в плагине ${agents.length}, в .claude/agents — ${expectedAgents.length}`,
    );
  }
  console.log(`  ✓ инвентарь: скилы [${skills.join(', ')}], ревьюеры (${agents.length})`);
}

/**
 * Защитные хуки c10.1 (fail-closed обёртки в адаптерах): в плагине адаптеров нет,
 * эквивалент — `|| exit 2` в команде; session-start и lint-changed-file — прямые,
 * как их адаптеры.
 */
const PROTECTIVE_HOOKS = [
  'guard-bash.ts',
  'protect-paths.ts',
  'protect-result.ts',
  'stop-verify.ts',
];

function expectedPluginCommand(settingsCommand: string): string {
  const command = settingsCommand.replace('.claude/hooks/', 'tools/hooks/');
  return PROTECTIVE_HOOKS.some((name) => command.includes(name)) ? `${command} || exit 2` : command;
}

/** Проводка: hooks.json плагина = hooks из settings.json с путём CLI потребителя. */
function checkWiring(): void {
  const settings = settingsHooks();
  const plugin = pluginHooksFile(
    join(repoRoot, '.claude', '.claude-plugin', 'hooks.json'),
    '.claude/.claude-plugin/hooks.json',
  );
  for (const [event, groups] of Object.entries(settings)) {
    const mirror = plugin[event];
    if (mirror === undefined) {
      throw new ProbeFailure(`hooks.json плагина потерял событие ${event}`);
    }
    if (mirror.length !== groups.length) {
      throw new ProbeFailure(
        `hooks.json плагина: ${event} — групп ${mirror.length}, в settings.json — ${groups.length}`,
      );
    }
    groups.forEach((group, index) => {
      const twin = mirror[index];
      if (
        twin === undefined ||
        (twin.matcher ?? '') !== (group.matcher ?? '') ||
        twin.hooks.length !== group.hooks.length
      ) {
        throw new ProbeFailure(`hooks.json плагина: ${event}[${index}] расходится с settings.json`);
      }
      group.hooks.forEach((hook, hookIndex) => {
        const twinHook = twin.hooks[hookIndex];
        const expectedCommand = expectedPluginCommand(hook.command);
        if (
          twinHook === undefined ||
          twinHook.command !== expectedCommand ||
          twinHook.timeout !== hook.timeout
        ) {
          throw new ProbeFailure(
            `hooks.json плагина: ${event}[${index}] команда/таймаут расходятся с settings.json (ожидалось: ${expectedCommand})`,
          );
        }
      });
    });
  }
  console.log(
    `  ✓ проводка: ${Object.keys(settings).join(', ')} — 1:1 с settings.json, CLI относительно потребителя, защитные с || exit 2`,
  );
}

function denyDecision(stdout: string): boolean {
  if (stdout.trim() === '') {
    return false;
  }
  const parsed: unknown = JSON.parse(stdout);
  if (!isRecord(parsed) || !isRecord(parsed['hookSpecificOutput'])) {
    return false;
  }
  return parsed['hookSpecificOutput']['permissionDecision'] === 'deny';
}

function runHook(
  command: string,
  payload: object,
): { deny: boolean; output: string; status: number } {
  const result = run(['sh', '-c', command], consumerDir, {
    input: JSON.stringify(payload),
    timeoutMs: 30_000,
    // Claude Code экспортирует CLAUDE_PROJECT_DIR в процесс хука — повторяем.
    env: { CLAUDE_PROJECT_DIR: consumerDir },
  });
  if (result.status !== 0 && result.status !== 2) {
    throw new ProbeFailure(
      `хук упал неожиданно (exit ${result.status}): ${result.stderr || result.stdout}`,
    );
  }
  return { deny: denyDecision(result.stdout), output: result.stdout, status: result.status };
}

/** Критерий «хук блокирует ослабление гейта» — детерминированно, без модели. */
function checkHookBlocking(pluginRoot: string): void {
  const events = pluginHooksFile(
    join(pluginRoot, '.claude-plugin', 'hooks.json'),
    'установленный hooks.json',
  );
  const commandOf = (event: string, matcher: string): string | undefined =>
    (events[event] ?? [])
      .filter((group) => group.matcher === matcher)
      .flatMap((group) => group.hooks.map((hook) => hook.command))[0];
  const guardBash = commandOf('PreToolUse', 'Bash');
  const protectPaths = commandOf('PreToolUse', 'Edit|Write|MultiEdit|NotebookEdit');
  if (guardBash === undefined || protectPaths === undefined) {
    throw new ProbeFailure(
      'в установленном hooks.json нет PreToolUse-команд guard-bash/protect-paths',
    );
  }

  const blocked = runHook(guardBash, {
    tool_name: 'Bash',
    tool_input: { command: 'git commit --no-verify -m bypass' },
  });
  if (!blocked.deny) {
    throw new ProbeFailure(`guard-bash пропустил --no-verify: ${blocked.output}`);
  }
  const allowed = runHook(guardBash, { tool_name: 'Bash', tool_input: { command: 'pnpm verify' } });
  if (allowed.deny) {
    throw new ProbeFailure(`guard-bash запретил безобидную команду: ${allowed.output}`);
  }
  const protectedWrite = runHook(protectPaths, {
    tool_name: 'Write',
    tool_input: { file_path: join(consumerDir, 'perf-budgets.json'), content: '{}' },
  });
  if (!protectedWrite.deny) {
    throw new ProbeFailure(
      `protect-paths пропустил запись в perf-budgets.json: ${protectedWrite.output}`,
    );
  }
  const regularWrite = runHook(protectPaths, {
    tool_name: 'Write',
    tool_input: { file_path: join(consumerDir, 'README.md'), content: '# probe' },
  });
  if (regularWrite.deny) {
    throw new ProbeFailure(`protect-paths запретил запись в README.md: ${regularWrite.output}`);
  }
  // З4 (fail-closed): потребитель без tools/ (нет CLI) — protective-команда с
  // `|| exit 2` обязана блокировать, а не выйти с кодом 1 (не блокирует).
  const missingCli = run(['sh', '-c', guardBash], consumerDir, {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'pnpm verify' } }),
    env: { CLAUDE_PROJECT_DIR: probeDir },
  });
  if (missingCli.status !== 2) {
    throw new ProbeFailure(
      `без tools/hooks хук вышел с кодом ${missingCli.status} (не блокирует, З4), ожидается 2`,
    );
  }
  console.log(
    '  ✓ хуки: --no-verify и запись в perf-budgets.json запрещены, benign-вызовы проходят, без tools/hooks — exit 2',
  );
}

interface StreamEvent {
  type: string;
  message?: { content?: Array<{ type: string; name?: string; input?: unknown }> };
  result?: string;
}

/** Минимальная валидация события stream-json вместо небезопасного утверждения. */
function streamEvent(item: unknown): StreamEvent | null {
  if (!isRecord(item) || typeof item['type'] !== 'string') {
    return null;
  }
  const event: StreamEvent = { type: item['type'] };
  const message = item['message'];
  if (isRecord(message) && Array.isArray(message['content'])) {
    event.message = {
      content: message['content'].map((block) => {
        if (!isRecord(block) || typeof block['type'] !== 'string') {
          return { type: 'unknown' };
        }
        const shaped: { type: string; name?: string; input?: unknown } = { type: block['type'] };
        if (typeof block['name'] === 'string') {
          shaped.name = block['name'];
        }
        shaped.input = block['input'];
        return shaped;
      }),
    };
  }
  if (typeof item['result'] === 'string') {
    event.result = item['result'];
  }
  return event;
}

/** Критерий «скил вызывается»: headless-сессия в потребителе вызывает Skill плагина. */
function checkSkillInvocation(): void {
  const prompt =
    'Не исследуй репозиторий. Вызови скил feature-workflow инструментом Skill и ответь одной строкой: ' +
    'что по скилу делается в разделе 1 до кода?';
  const result = run(
    ['claude', '-p', prompt, '--max-turns', '15', '--output-format', 'json'],
    consumerDir,
    {
      timeoutMs: 300_000,
    },
  );
  if (result.status !== 0 && result.stdout.trim() === '') {
    throw new ProbeFailure(
      `claude -p не выполнился (exit ${result.status}): ${result.stderr || 'нет вывода'}. ` +
        'Нужны claude CLI и авторизация; детерминированную часть можно гонять с --skip-llm.',
    );
  }
  const parsed: unknown = JSON.parse(result.stdout);
  if (!Array.isArray(parsed)) {
    throw new ProbeFailure('claude -p: ожидается массив событий в stdout');
  }
  const events: StreamEvent[] = parsed
    .map((item) => streamEvent(item))
    .filter((event): event is StreamEvent => event !== null);
  const skillCall = events.some((event) =>
    (event.message?.content ?? []).some(
      (block) =>
        block.type === 'tool_use' &&
        block.name === 'Skill' &&
        isRecord(block.input) &&
        String(block.input['skill']).includes('feature-workflow'),
    ),
  );
  if (!skillCall) {
    throw new ProbeFailure(
      'модель не вызвала Skill agent-harness:feature-workflow в headless-сессии',
    );
  }
  console.log(
    '  ✓ скил: Skill agent-harness:feature-workflow вызван в headless-сессии потребителя',
  );
  const summary = events.find((event) => event.type === 'result');
  if (typeof summary?.result === 'string') {
    console.log(`    ответ модели: ${summary.result.slice(0, 160)}`);
  }
}

function main(): void {
  const skipLlm = process.argv.includes('--skip-llm');
  console.log(`Проба плагина ${pluginRef}; потребитель: ${consumerDir}`);
  buildConsumer();
  installPlugin();
  const pluginRoot = installedPluginRoot(pluginManifestVersion());
  checkInventory(pluginRoot);
  checkWiring();
  checkHookBlocking(pluginRoot);
  if (skipLlm) {
    console.log('  - скил: LLM-часть пропущена (--skip-llm)');
  } else {
    checkSkillInvocation();
  }
  console.log(
    'Проба пройдена: в чистом репозитории-потребителе скил вызывается, хуки блокируют ослабление гейта.',
  );
}

main();
