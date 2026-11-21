/**
 * Ночной чек дрейфа (a11): живой ruleset GitHub против снимка в
 * .github/rulesets/*.json. Снимок применяет человек в интерфейсе — живое
 * правило могут изменить или выключить в любой момент, а снимок продолжит
 * утверждать защиту, которой нет (находка security-ревью A9).
 *
 * Реестр пар «id → снимок» — docs/template-state.md, раздел «Реестр живых
 * правил» (парсится отсюда, machine-readable таблица).
 *
 * Сравнение: каноническая проекция {name, target, enforcement, conditions,
 * bypass_actors, rules} обеих сторон (снимок может нести не-апишные ключи
 * вроде $comment — они вырезаются рекурсивно).
 *
 * Fail-loud (З11): gh api недоступен/ошибся, реестр не парсится, снимок не
 * найден — exit 2 с причиной, а не «дрейфа нет». Дрейф/удалённый ruleset —
 * exit 1 (--create-issue → issue с label nightly-failure, дедуп по заголовку).
 * Тест-режим: --fixture-api <dir> читает <dir>/<id>.json вместо gh api.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

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

function stripNonApi(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNonApi);
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === '$comment' || key === '$schema') continue;
    out[key] = stripNonApi(item);
  }
  return out;
}

/** Проекция live на форму снимка: снимок ⊆ живое, лишние поля API игнорируются. */
function project(shape: unknown, live: unknown): unknown {
  if (Array.isArray(shape)) {
    if (!Array.isArray(live)) return live;
    return shape.map((item, index) => project(item, live[index]));
  }
  if (!isRecord(shape)) return live;
  if (!isRecord(live)) return live;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(shape)) {
    if (key in live) out[key] = project(shape[key], live[key]);
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

function fetchLive(id: string, fixtureDir: string): { status: number; body: unknown } {
  if (fixtureDir !== '') {
    const path = join(fixtureDir, `${id}.json`);
    if (!existsSync(path)) {
      // В тест-режиме отсутствие фикстуры — громкая ошибка окружения (З11),
      // а не «ruleset удалён»: 404-семантика только у настоящего gh api.
      throw new Error(`fixture missing: ${path}`);
    }
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    // Фикстура {"__httpStatus__": 404} = «API ответил 404» (удалённый ruleset).
    if (isRecord(parsed) && typeof parsed['__httpStatus__'] === 'number') {
      return { status: parsed['__httpStatus__'], body: null };
    }
    return { status: 0, body: parsed };
  }
  const run = spawnSync('gh', ['api', `repos/:owner/:repo/rulesets/${id}`], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (run.status !== 0) {
    return { status: run.status ?? -1, body: run.stderr };
  }
  return { status: 0, body: JSON.parse(run.stdout) };
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
  for (const pair of pairs) {
    if (!existsSync(pair.snapshot)) {
      drifts.push(`снимок не найден: ${pair.snapshot} (ruleset ${pair.id})`);
      continue;
    }
    let live: unknown;
    try {
      const fetched = fetchLive(pair.id, fixtureDir);
      if (fetched.status === 404) {
        drifts.push(`живой ruleset ${pair.id} удалён, а снимок ${pair.snapshot} существует`);
        continue;
      }
      if (fetched.status !== 0) {
        console.error(
          `ruleset-drift: gh api для ${pair.id} не ответил (exit ${fetched.status}) — fail-loud (З11): ` +
            String(fetched.body).slice(-300),
        );
        process.exit(2);
      }
      live = fetched.body;
    } catch (error) {
      console.error(
        `ruleset-drift: не удалось разобрать ответ для ${pair.id} — fail-loud (З11): ${String(error)}`,
      );
      process.exit(2);
    }
    const snapshot: unknown = JSON.parse(readFileSync(pair.snapshot, 'utf8'));
    const liveProjected = project(stripNonApi(snapshot), project(snapshot, live));
    const snapshotProjected = stripNonApi(snapshot);
    if (
      canonical(liveProjected) !== canonical(snapshotProjected) ||
      !deepEqual(liveProjected, snapshotProjected)
    ) {
      drifts.push(
        `дрейф: живой ruleset ${pair.id} ≠ снимок ${pair.snapshot}\n  живой: ${sortedJson(stripNonApi(live)).slice(0, 400)}\n  снимок: ${sortedJson(stripNonApi(snapshot)).slice(0, 400)}`,
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
  console.log(`ruleset-drift: живые rulesets соответствуют снимкам (${pairs.length} пар)`);

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
