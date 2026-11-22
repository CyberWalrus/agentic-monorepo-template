/**
 * Учёт флаков (b4.4): разбор JSON-отчёта Playwright повтора `--repeat-each=N`,
 * расчёт flaky rate (цель G4 < 1 % из vision) и карантин.
 *
 * Flaky — тест, у которого повторы одного прогона дали разные исходы
 * (passed/failed не mix). Карантин — tools/flaky-quarantine.json (защищённый
 * файл): тест исполняется, но его падение не блокирует; запись = {test, until,
 * issue}; максимум 3, `@critical` запрещён, срок 14 дней без продления,
 * истёкшая запись красит. Повторный карантин того же теста — новый issue
 * (поле issue хранит ссылку, дедупом не считается).
 *
 * Режимы:
 *   --report <file> --quarantine <file> [--repeat N] [--rate-out <file>]
 *   --validate-quarantine --quarantine <file>   (только валидация файла)
 *
 * --rate-out (c9.4): вычисленный rate пишется JSON-файлом — единственный
 * источник семантики для тренд-отчёта телеметрии (tools/telemetry-report.*),
 * чтобы тот не пересчитывал rate сам и не разошёлся с гейтом.
 *
 * Выход: 0 — блокирующих нарушений нет; 1 — красный (лист причин в stderr).
 *
 * Отсутствующий или нечитаемый --report — exit 1 с названной причиной, без
 * стека (З11): отсутствие данных не успех (З4) — e31, ночь 21.11 красила
 * каскадом «ENOENT ... flake.json» без объяснения.
 */
import { readFileSync, writeFileSync } from 'node:fs';

interface QuarantineEntry {
  test: string;
  until: string;
  issue: string;
}

interface PlaywrightTestCase {
  title?: string;
  file?: string;
  results: Array<{ status: string }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRecordArray(value: unknown): value is Array<Record<string, unknown>> {
  return Array.isArray(value) && value.every((item) => isRecord(item));
}

/** Плоский список листьев suites: {file, title, results[].status}. */
function collectTests(suite: unknown, fileFallback: string, out: PlaywrightTestCase[]): void {
  if (!isRecord(suite)) return;
  const file = typeof suite['file'] === 'string' ? suite['file'] : fileFallback;
  if (isRecordArray(suite['specs'])) {
    for (const spec of suite['specs']) {
      if (isRecordArray(spec['tests'])) {
        for (const test of spec['tests']) {
          const title = typeof test['title'] === 'string' ? test['title'] : '';
          const results = isRecordArray(test['results'])
            ? test['results'].map((r) => ({
                status: typeof r['status'] === 'string' ? r['status'] : '',
              }))
            : [];
          out.push({ file, title, results });
        }
      }
    }
  }
  if (isRecordArray(suite['suites'])) {
    for (const inner of suite['suites']) collectTests(inner, file, out);
  }
}

function parseQuarantine(raw: string, problems: string[]): QuarantineEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ''));
  } catch {
    problems.push('quarantine: файл не разбирается как JSON');
    return [];
  }
  if (!isRecord(parsed) || !Array.isArray(parsed['quarantine'])) {
    problems.push('quarantine: нет массива quarantine');
    return [];
  }
  const entriesRaw = parsed['quarantine'];
  if (entriesRaw.length > 3) {
    problems.push(`quarantine: записей ${entriesRaw.length}, максимум 3 (b4.4)`);
  }
  const seen = new Set<string>();
  const entries: QuarantineEntry[] = [];
  for (const item of entriesRaw) {
    if (!isRecord(item)) {
      problems.push('quarantine: запись не объект');
      continue;
    }
    const test = typeof item['test'] === 'string' ? item['test'] : '';
    const until = typeof item['until'] === 'string' ? item['until'] : '';
    const issue = typeof item['issue'] === 'string' ? item['issue'] : '';
    if (test === '' || until === '' || issue === '') {
      problems.push(`quarantine: запись без test/until/issue: ${test || '(пусто)'}`);
      continue;
    }
    if (test.includes('@critical')) {
      problems.push(`quarantine: @critical в карантин запрещён: ${test}`);
    }
    const timestamp = Date.parse(until);
    if (!Number.isFinite(timestamp)) {
      problems.push(`quarantine: until не ISO-дата: ${test}`);
    } else if (timestamp < Date.now()) {
      problems.push(`quarantine: срок истёк ${until} — продли PR-ом или удали: ${test}`);
    }
    if (seen.has(test)) {
      problems.push(`quarantine: дублирующая запись: ${test}`);
    }
    seen.add(test);
    entries.push({ test, until, issue });
  }
  return entries;
}

/**
 * Причина непрочитанного отчёта — одной строкой, без стека (З11). Различает
 * «файла нет» (playwright-шаг не записал отчёт) и «файл не JSON» (прогон
 * оборвался при записи или файл испорчен); системное сообщение сохраняется.
 */
function reportProblem(reportPath: string, error: unknown): string {
  if (reportPath === '') {
    return 'флаг --report не передан — путь к отчёту обязателен: --report e2e/reports/flake.json';
  }
  const code =
    typeof error === 'object' && error !== null && 'code' in error ? String(error['code']) : '';
  const system = error instanceof Error ? error.message : String(error);
  if (code === 'ENOENT') {
    return (
      `отчёт ${reportPath} отсутствует — playwright-шаг не записал flake.json ` +
      '(прогон не запустился или упал до записи отчёта). flaky rate не вычислен: ' +
      'отсутствие данных — не успех (З4), см. лог playwright-шага выше'
    );
  }
  return (
    `отчёт ${reportPath} не разбирается как JSON: ${system} — прогон оборвался во время ` +
    'записи отчёта или файл испорчен. flaky rate не вычислен: отсутствие данных — ' +
    'не успех (З4), см. лог playwright-шага выше'
  );
}

function main(): void {
  const args = process.argv.slice(2);
  const flag = (name: string): string => {
    const idx = args.indexOf(name);
    return idx >= 0 ? (args[idx + 1] ?? '') : '';
  };
  const problems: string[] = [];
  const quarantinePath = flag('--quarantine');
  const quarantine = quarantinePath
    ? parseQuarantine(readFileSync(quarantinePath, 'utf8'), problems)
    : [];

  if (args.includes('--validate-quarantine')) {
    if (problems.length > 0) {
      console.error(`flaky-quarantine:\n- ${problems.join('\n- ')}`);
      process.exit(1);
    }
    console.log(`flaky-quarantine: валидно, записей ${quarantine.length}`);
    return;
  }

  const flakyOut = flag('--flaky-out');
  const reportPath = flag('--report');
  const repeat = Number(flag('--repeat')) || 5;
  // З11: отсутствие/битость отчёта — не стек, а названная причина; З4: exit 1 —
  // отсутствие данных не успех (ночь 21.11: ENOENT каскадом после падения
  // playwright-шага). До этой правки readFileSync/JSON.parse падали стеком.
  let report: unknown;
  try {
    report = JSON.parse(readFileSync(reportPath, 'utf8'));
  } catch (error: unknown) {
    console.error(`flaky:\n- ${reportProblem(reportPath, error)}`);
    process.exit(1);
  }
  const tests: PlaywrightTestCase[] = [];
  // JSON-репорт Playwright: корень держит МАССИВ suites (не объект).
  const suites: unknown = isRecord(report) ? report['suites'] : undefined;
  if (isRecordArray(suites)) {
    for (const suite of suites) collectTests(suite, '', tests);
  } else if (isRecord(suites)) {
    collectTests(suites, '', tests);
  }

  // Группировка по file+title: repeat-each создаёт отдельные записи на повтор.
  const grouped = new Map<string, string[]>();
  for (const test of tests) {
    if (test.file === undefined || test.title === undefined) continue;
    const key = `${test.file} :: ${test.title}`;
    const statuses = grouped.get(key) ?? [];
    for (const result of test.results) {
      if (result.status !== '') statuses.push(result.status);
    }
    grouped.set(key, statuses);
  }

  let flaky = 0;
  let broken = 0;
  const flakyTitles: string[] = [];
  const brokenTitles: string[] = [];
  for (const [key, statuses] of grouped) {
    const outcomes = statuses.filter((status) => status !== 'skipped');
    if (outcomes.length === 0) continue;
    const quarantined = quarantine.some(
      (entry) => key.includes(entry.test) || entry.test.includes(key),
    );
    if (outcomes.some((status) => status !== 'passed')) {
      if (quarantined) continue; // исполняется, не блокирует (b4.4)
      broken += 1;
      brokenTitles.push(key);
    }
    const passed = outcomes.filter((status) => status === 'passed').length;
    if (passed > 0 && passed < outcomes.length) {
      flaky += 1;
      flakyTitles.push(key);
    }
  }

  const total = grouped.size;
  const rate = total > 0 ? (flaky / total) * 100 : 0;
  const rateOut = flag('--rate-out');
  if (rateOut !== '') {
    writeFileSync(
      rateOut,
      `${JSON.stringify({
        ratePct: Number(rate.toFixed(2)),
        flaky,
        total,
        repeat,
        quarantine: quarantine.length,
      })}\n`,
    );
  }
  const summary = [
    `flaky rate: ${rate.toFixed(2)}% (${flaky} из ${total} тестов, порог < 1%, повторов ${repeat})`,
    ...flakyTitles.slice(0, 20).map((title) => `  flaky: ${title}`),
    `неблокирующих падений в карантине: ${quarantine.length}`,
  ];
  console.log(summary.join('\n'));

  if (flakyOut !== '') writeFileSync(flakyOut, flakyTitles.join('\n'));
  const blockers: string[] = [...problems];
  if (rate >= 1) {
    blockers.push(
      `flaky rate ${rate.toFixed(2)}% >= 1% (G4): ${flakyTitles.slice(0, 10).join('; ')}`,
    );
  }
  if (broken > 0) {
    blockers.push(`падений вне карантина: ${broken} — ${brokenTitles.slice(0, 10).join('; ')}`);
  }
  if (blockers.length > 0) {
    console.error(`flaky:\n- ${blockers.join('\n- ')}`);
    process.exit(1);
  }
}

main();
