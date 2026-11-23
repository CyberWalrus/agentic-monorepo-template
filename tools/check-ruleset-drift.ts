/**
 * Ночной чек дрейфа (a11): живой ruleset GitHub против снимка в
 * .github/rulesets/*.json. Снимок применяет человек в интерфейсе — живое
 * правило могут изменить или выключить в любой момент, а снимок продолжит
 * утверждать защиту, которой нет (находка security-ревью A9).
 *
 * Реестр пар «id → снимок» — docs/template-state.md, раздел «Реестр живых
 * правил» (парсируется отсюда, machine-readable таблица).
 *
 * Сравнение: проекция живого ответа на форму снимка {name, target, enforcement,
 * conditions, bypass_actors, rules} (снимок может нести не-апишные ключи вроде
 * $comment — они вырезаются рекурсивно). Лишние поля API игнорируются, массивы —
 * нет: массив обходится по более длинной стороне, поэтому элемент, добавленный
 * в живом ruleset сверх снимка (правило, обходчик), — дрейф (e35: раньше не был
 * виден).
 *
 * Три исхода на пару (e35):
 *   - дрейф — ответ получен, доступная токену часть расходится со снимком:
 *     exit 1, сообщение называет пути расхождений (--create-issue → issue с
 *     label nightly-failure, дедуп по заголовку); 404 — ruleset удалён;
 *   - граница проверки — ключ снимка отсутствует в ответе, потому что GitHub
 *     отдаёт его только при write-доступе (TOKEN_HIDDEN_KEYS): джоба зелёная,
 *     непроверенное названо поимённо (предупреждение, аннотация, сводка шага);
 *   - отказ API — сравнивать не с чем (403, сеть, битый JSON): exit 2 с кодом и
 *     телом, в сообщении прямо сказано, что это не дрейф.
 *
 * Fail-loud (З11): gh api недоступен/ошибся, реестр не парсится, снимок не
 * найден — exit 2 с причиной, а не «дрейфа нет».
 * Тест-режим: --fixture-api <dir> читает <dir>/<id>.json вместо gh api.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Ключи ответа rulesets/<id>, которые GitHub отдаёт только при write-доступе
 * к ruleset (REST, «Get a repository ruleset»: «To prevent leaking sensitive
 * information, the bypass_actors property is only returned if the user making
 * the API request has write access to the ruleset»). У токена ночной джобы
 * доступ read: ключа в ответе нет. Отсутствие такого ключа — граница проверки,
 * а не дрейф (e35: джоба красила обе пары фантомным дрейфом с рождения).
 * Любой другой отсутствующий ключ снимка — по-прежнему дрейф.
 */
const TOKEN_HIDDEN_KEYS = new Set(['bypass_actors']);

const LOCAL_CHECK =
  'сверь локально токеном администратора — node tools/check-ruleset-drift.ts (docs/architecture.md, 3.4)';

/** Предел строк расхождений на один ruleset: красный объясняет себя, не тонет. */
const MAX_DIFF_LINES = 12;

interface RegistryPair {
  id: string;
  snapshot: string;
}

function parseRegistry(markdownPath: string): RegistryPair[] {
  const text = readFileSync(markdownPath, 'utf8');
  const sectionMatch = text.match(/### Реестр живых правил[\s\S]*?(?=\n### |\n## |$)/);
  const scope = sectionMatch?.[0] ?? '';
  const pairs: RegistryPair[] = [];
  const row = /^\|\s*(\d+)\s*\|\s*([^|\s][^|]*?\.json)\s*\|/gm;
  let match: RegExpExecArray | null;
  while ((match = row.exec(scope)) !== null) {
    pairs.push({ id: match[1] ?? '', snapshot: (match[2] ?? '').trim() });
  }
  return pairs;
}

function stripRecord(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === '$comment' || key === '$schema') continue;
    out[key] = stripNonApi(item);
  }
  return out;
}

function stripNonApi(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNonApi);
  if (!isRecord(value)) return value;
  return stripRecord(value);
}

/**
 * Проекция live на форму снимка: лишние поля API игнорируются. Массив
 * обходится по более длинной из сторон (e35): элемент живого сверх снимка
 * попадает в проекцию и расходится со снимком, а не отбрасывается. Ключи
 * снимка, которых нет в живом ответе, в проекцию не входят — их пути (от корня
 * снимка) пишутся в missing: дальше они делятся на скрытые токену и дрейф.
 */
function project(shape: unknown, live: unknown, path: string, missing: string[]): unknown {
  if (Array.isArray(shape)) {
    if (!Array.isArray(live)) return live;
    const size = Math.max(shape.length, live.length);
    return Array.from({ length: size }, (_, index) =>
      project(shape[index], live[index], `${path}[${index}]`, missing),
    );
  }
  if (!isRecord(shape) || !isRecord(live)) return live;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(shape)) {
    const keyPath = path === '' ? key : `${path}.${key}`;
    if (!(key in live)) {
      missing.push(keyPath);
      continue;
    }
    out[key] = project(shape[key], live[key], keyPath, missing);
  }
  return out;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
  }
  if (isRecord(a)) {
    if (!isRecord(b)) return false;
    const keysA = Object.keys(a).toSorted();
    const keysB = Object.keys(b).toSorted();
    return (
      keysA.length === keysB.length &&
      keysA.every((key, i) => key === keysB[i] && deepEqual(a[key], b[key]))
    );
  }
  return a === b;
}

function canonical(value: unknown): string {
  const projected = stripNonApi(value);
  return JSON.stringify(projected, Object.keys(isRecord(projected) ? projected : {}).toSorted());
}

function sortedJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function show(value: unknown): string {
  return value === undefined ? '<нет>' : JSON.stringify(value);
}

/** Пути расхождений живого и снимка: красный называет конкретное поле (З11). */
function diffPaths(live: unknown, snapshot: unknown, path = ''): string[] {
  if (deepEqual(live, snapshot)) return [];
  if (Array.isArray(live) && Array.isArray(snapshot)) {
    const size = Math.max(live.length, snapshot.length);
    return Array.from({ length: size }, (_, index) =>
      diffPaths(live[index], snapshot[index], `${path}[${index}]`),
    ).flat();
  }
  if (isRecord(live) && isRecord(snapshot)) {
    return [...new Set([...Object.keys(live), ...Object.keys(snapshot)])]
      .toSorted()
      .flatMap((key) => diffPaths(live[key], snapshot[key], path === '' ? key : `${path}.${key}`));
  }
  return [`${path}: живое ${show(live)}, снимок ${show(snapshot)}`];
}

/** 0 — ответ получен; HTTP-код — API отказал (404: ruleset удалён); -1 — не дошёл до API. */
interface LiveResponse {
  status: number;
  body: unknown;
}

/** gh api при HTTP-ошибке пишет тело в stdout, «gh: <message> (HTTP <код>)» — в stderr. */
function httpStatus(stderr: string): number {
  const code = /\(HTTP (\d{3})\)/.exec(stderr)?.[1];
  return code === undefined ? -1 : Number(code);
}

function fetchLive(id: string, fixtureDir: string): LiveResponse {
  if (fixtureDir !== '') {
    const path = join(fixtureDir, `${id}.json`);
    if (!existsSync(path)) {
      // В тест-режиме отсутствие фикстуры — громкая ошибка окружения (З11),
      // а не «ruleset удалён»: 404-семантика только у настоящего gh api.
      throw new Error(`fixture missing: ${path}`);
    }
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    // Фикстура {"__httpStatus__": 404} = «API ответил 404» (удалённый ruleset),
    // {"__httpStatus__": 403, "__body__": …} — отказ API с кодом и телом.
    if (isRecord(parsed) && typeof parsed['__httpStatus__'] === 'number') {
      return { status: parsed['__httpStatus__'], body: parsed['__body__'] ?? null };
    }
    return { status: 0, body: parsed };
  }
  const run = spawnSync('gh', ['api', `repos/:owner/:repo/rulesets/${id}`], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (run.status !== 0 || run.error !== undefined) {
    const stderr = run.error === undefined ? run.stderr : String(run.error);
    const status = httpStatus(stderr);
    const body = status === -1 ? stderr.trim() : `${run.stdout.trim()}\n${stderr.trim()}`;
    return { status, body };
  }
  return { status: 0, body: JSON.parse(run.stdout) };
}

function refusalReason(status: number): string {
  if (status === -1) return 'gh api не дошёл до API (сеть или gh не установлен)';
  if (status === 401 || status === 403) {
    return 'у токена нет прав на rulesets — проверь permissions джобы';
  }
  if (status >= 500) return 'ошибка на стороне GitHub';
  return 'неожиданный ответ API';
}

/** Текст в workflow-команду ::warning:: (экранирование %, CR, LF). */
function commandText(text: string): string {
  return text.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
}

function main(): void {
  const args = process.argv.slice(2);
  const flag = (name: string): string => {
    const idx = args.indexOf(name);
    return idx >= 0 ? (args[idx + 1] ?? '') : '';
  };
  const registryPath = flag('--registry') || 'docs/template-state.md';
  const fixtureDir = flag('--fixture-api');
  const createIssue = args.includes('--create-issue');
  const runUrl = flag('--run-url');

  // Снимок живого ruleset — dev-документ шаблона: в проект из копии он не едет
  // (copier _exclude, ADR 0008). Дрейф там не применим в принципе — живого
  // контракта ruleset у копии нет. Отсутствие реестра в копии — не дрейф и не
  // ошибка: тихий exit 0 (проверка применима только в шаблонном репозитории).
  // РЕЕСТР НА МЕСТЕ, но битый/пустой — по-прежнему fail-loud (ниже).
  if (!existsSync(registryPath)) {
    console.log(
      `ruleset-drift: ${registryPath} отсутствует — это копия шаблона, дрейф ruleset не применим.`,
    );
    process.exit(0);
  }
  const pairs = parseRegistry(registryPath);
  if (pairs.length === 0) {
    console.error(
      `ruleset-drift: в ${registryPath} не нашлось ни одной пары «id → снимок» (fail-loud, З11)`,
    );
    process.exit(2);
  }

  const drifts: string[] = [];
  const boundaries: string[] = [];
  for (const pair of pairs) {
    if (!existsSync(pair.snapshot)) {
      drifts.push(`снимок не найден: ${pair.snapshot} (ruleset ${pair.id})`);
      continue;
    }
    let live: unknown;
    let snapshot: Record<string, unknown>;
    try {
      const fetched = fetchLive(pair.id, fixtureDir);
      if (fetched.status === 404) {
        drifts.push(
          `живой ruleset ${pair.id} удалён (API ответил 404), а снимок ${pair.snapshot} существует`,
        );
        continue;
      }
      if (fetched.status !== 0) {
        // Отказ API — не дрейф (e35): сравнение не состоялось, и красный обязан
        // назвать причину, а не приписывать живому правилу расхождение.
        console.error(
          `ruleset-drift: отказ API для ${pair.id} — это не дрейф, сравнение не состоялось. ` +
            `${refusalReason(fetched.status)}; код ${fetched.status}; тело: ${show(fetched.body).slice(0, 500)}` +
            ' — fail-loud (З11)',
        );
        process.exit(2);
      }
      live = fetched.body;
      if (!isRecord(live)) {
        throw new Error(`ответ API для ${pair.id} — не объект ruleset`);
      }
      const parsed: unknown = JSON.parse(readFileSync(pair.snapshot, 'utf8'));
      if (!isRecord(parsed)) {
        throw new Error(`снимок ${pair.snapshot} — не объект JSON`);
      }
      snapshot = parsed;
    } catch (error) {
      console.error(
        `ruleset-drift: не удалось разобрать ответ или снимок для ${pair.id} — fail-loud (З11): ${String(error)}`,
      );
      process.exit(2);
    }

    // Проба прав токена (e35): по списку ключей видно, что токен реально видит.
    const liveKeys = Object.keys(live);
    console.log(
      `ruleset-drift: ${pair.id} — ключи живого ответа (${liveKeys.length}): ${liveKeys.join(', ')}`,
    );

    const stripped = stripRecord(snapshot);
    const missing: string[] = [];
    const liveProjected = project(stripped, live, '', missing);
    const hidden = missing.filter((key) => TOKEN_HIDDEN_KEYS.has(key));
    // Сравнивается всё, что токен видит: скрытый ключ исключается с обеих сторон.
    const comparable: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(stripped)) {
      if (!hidden.includes(key)) comparable[key] = value;
    }
    if (
      canonical(liveProjected) !== canonical(comparable) ||
      !deepEqual(liveProjected, comparable)
    ) {
      const lost = missing.filter((key) => !TOKEN_HIDDEN_KEYS.has(key));
      const paths = diffPaths(liveProjected, comparable);
      const shown = paths.slice(0, MAX_DIFF_LINES);
      if (paths.length > shown.length)
        shown.push(`… ещё ${paths.length - shown.length} расхождений`);
      if (lost.length > 0) {
        shown.push(
          `в живом ответе нет ключа(ей) снимка: ${lost.join(', ')} — вне TOKEN_HIDDEN_KEYS это дрейф`,
        );
      }
      drifts.push(
        `дрейф: живой ruleset ${pair.id} ≠ снимок ${pair.snapshot}\n  ${shown.join('\n  ')}`,
      );
      continue;
    }
    if (hidden.length > 0) {
      boundaries.push(
        `ruleset ${pair.id} (снимок ${pair.snapshot}): ${hidden
          .map((key) => `${key} не возвращён API токену джобы (в снимке ${show(stripped[key])})`)
          .join('; ')} — не проверено; ${LOCAL_CHECK}.`,
      );
    }
  }

  if (drifts.length > 0) {
    const title = '[ruleset-drift] живые rulesets разошлись со снимками';
    console.error(`ruleset-drift:\n- ${drifts.join('\n- ')}`);
    if (createIssue) {
      const repo = process.env['GITHUB_REPOSITORY'] ?? '';
      const found = spawnSync(
        'gh',
        [
          'issue',
          'list',
          '--repo',
          repo,
          '--state',
          'open',
          '--search',
          `${title} in:title`,
          '--limit',
          '1',
          '--json',
          'number',
          '--jq',
          '.[0].number',
        ],
        { encoding: 'utf8' },
      );
      const existing = found.stdout.trim();
      const body = `${drifts.join('\n\n')}\n\nПрогон: ${runUrl}`;
      if (existing !== '') {
        spawnSync('gh', ['issue', 'comment', existing, '--repo', repo, '--body', body], {
          encoding: 'utf8',
        });
        console.log(`ruleset-drift: существующий issue #${existing} дополнен`);
      } else {
        const created = spawnSync(
          'gh',
          [
            'issue',
            'create',
            '--repo',
            repo,
            '--title',
            title,
            '--label',
            'nightly-failure',
            '--body',
            body,
          ],
          { encoding: 'utf8' },
        );
        console.log(`ruleset-drift: создан issue ${(created.stdout ?? '').trim()}`);
      }
    }
    process.exit(1);
  }

  // Граница проверки (e35): зелёный здесь означает «доступное токену совпадает»,
  // а не «живое равно снимку». Непроверенное называется поимённо — в логе,
  // аннотации прогона и сводке шага: тихоgreenеть монитор не имеет права.
  if (boundaries.length > 0) {
    const text = [
      'ruleset-drift: ГРАНИЦА ПРОВЕРКИ — совпадает только доступная токену джобы часть; перечисленное НЕ проверено ночью:',
      ...boundaries.map((line) => `- ${line}`),
    ].join('\n');
    console.warn(text);
    console.log(`::warning title=ruleset-drift — граница проверки::${commandText(text)}`);
    const stepSummary = process.env['GITHUB_STEP_SUMMARY'];
    if (stepSummary !== undefined) {
      appendFileSync(
        stepSummary,
        `## ⚠️ ruleset drift (a11): проверка неполная\n\n${boundaries.map((line) => `- ${line}`).join('\n')}\n\n`,
      );
    }
  }
  console.log(
    `ruleset-drift: живые rulesets соответствуют снимкам (${pairs.length} пар)` +
      (boundaries.length > 0
        ? `; граница проверки — у ${boundaries.length} из них, см. предупреждение выше`
        : ''),
  );

  // Снимок текущего живого состояния — для ручной сверки человеком (d8.5-прецедент).
  const dump = flag('--dump-live');
  if (dump !== '') {
    const pairsDump = pairs.map((pair) => ({
      id: pair.id,
      live: fetchLive(pair.id, fixtureDir).body,
    }));
    writeFileSync(resolve(dump), sortedJson(pairsDump));
  }
}

main();
