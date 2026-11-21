/**
 * Аудит зависимостей с порогом (b6): красный только для high/critical в
 * production-зависимостях; low/moderate видны в выводе CI, но не блокируют
 * (порог поднимает человек отдельным PR, З7 / ADR 0009 «Пороги»).
 * `pnpm audit --audit-level` не подходит: он фильтрует вывод, но падает
 * на любой находке — поэтому свой чекер с разбором JSON.
 */
import { spawnSync } from 'node:child_process';

interface Advisory {
  module_name?: string;
  severity?: string;
}

const run = spawnSync('pnpm', ['audit', '--prod', '--json'], {
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
});

let parsed: unknown;
try {
  parsed = JSON.parse(run.stdout);
} catch {
  console.error(
    `audit: не удалось разобрать вывод pnpm audit (exit ${run.status}). ` +
      `Хвост stderr: ${run.stderr.slice(-400)}`,
  );
  // Fail-closed (З4): нет данных — красный, а не «тихо зелёный».
  process.exit(2);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

const advisoryList: Advisory[] = (() => {
  if (!isRecord(parsed)) return [];
  const advisories = parsed['advisories'];
  if (!isRecord(advisories)) return [];
  return Object.values(advisories).filter(
    (item): item is Advisory => isRecord(item) && typeof item['severity'] === 'string',
  );
})();

const over = advisoryList.filter((a) => a.severity === 'high' || a.severity === 'critical');
const moderate = advisoryList.filter((a) => a.severity === 'moderate' || a.severity === 'low');

if (over.length > 0) {
  console.error(
    `audit: ${over.length} high/critical уязвимостей в production-зависимостях (порог b6):\n- ` +
      over.map((a) => `${a.module_name ?? '?'} [${a.severity ?? '?'}]`).join('\n- ') +
      '\nОбнови зависимость (Renovate) или подними порог отдельным PR с обоснованием (З7).',
  );
  process.exit(1);
}
console.log(`audit: high/critical нет; low/moderate: ${moderate.length} (не блокируют, порог b6)`);
