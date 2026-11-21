/**
 * Тренд отказов гейтов (C9.3): счётчик по гейтам за период. Источники —
 * локальный журнал (tools/denial-journal.ts) и выгрузки CI рядом
 * (reports/denials*.jsonl — артефакты gate-integrity). В записях только
 * факты: дата, гейт, категория причины — содержимого кода и команд нет.
 *
 * Использование: pnpm denial:report [--days 30] [--no-local]
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { journalPath, readDenials } from './hooks/lib.ts';

const args = process.argv.slice(2);
const daysIdx = args.indexOf('--days');
const days = daysIdx >= 0 ? Number(args[daysIdx + 1]) || 30 : 30;
const since = Date.now() - days * 86_400_000;

const paths = new Set<string>();
if (existsSync('reports')) {
  for (const file of readdirSync('reports')) {
    if (file.startsWith('denials') && file.endsWith('.jsonl')) paths.add(join('reports', file));
  }
}
if (!args.includes('--no-local')) paths.add(journalPath());

const counts = new Map<string, number>();
let total = 0;
for (const path of paths) {
  for (const record of readDenials(path)) {
    const timestamp = Date.parse(record.date);
    if (Number.isFinite(timestamp) && timestamp >= since) {
      counts.set(record.gate, (counts.get(record.gate) ?? 0) + 1);
      total += 1;
    }
  }
}

if (total === 0) {
  console.log(`denial-trend: отказов за ${days} дн. нет (${paths.size} журнал(ов) просмотрено)`);
} else {
  console.log(`denial-trend: ${total} отказ(ов) за ${days} дн., по гейтам:`);
  for (const [gate, count] of [...counts.entries()].toSorted((a, b) => b[1] - a[1])) {
    console.log(`  ${gate}: ${count}`);
  }
}
