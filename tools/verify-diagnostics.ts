/**
 * Компактная диагностика упавшего шага verify (задача b9): вместо хвоста сырого
 * вывода — список «файл, строка, сообщение» из машиночитаемых источников,
 * которые шаги и так производят: jest-совместимый JSON Vitest
 * (reports/vitest.json пакетов, reports/vitest-hooks.json корня), строки
 * `file(line,col): error TS…` у tsc (typecheck), формат `agent` у oxlint
 * (lint — passthrough строк, без перепарсивания ошибок).
 *
 * Контракт вывода verify (ревью плана b9): поле `output` шага в `--json` НЕ
 * меняется — остаётся сырым хвостом, по нему матчат канарейки гейтов
 * (tools/run-gate-canaries.ts) и потребители (stop-verify). Диагностика —
 * отдельное опциональное поле `steps[].diagnostics`. Список вместо хвоста
 * подставляется только в текстовом выводе verify и в reason блока Stop
 * (tools/hooks/stop-verify.ts), который предпочитает diagnostics и падает
 * назад на хвост.
 *
 * Fail-open к хвосту (в духе fail-closed check-test-report: пустой список при
 * красном шаге хуже хвоста): у известного шага отчёт может отсутствовать (краш
 * раннера до записи, известный класс — убийство vitest сигналом), быть
 * устаревшим (остатки прошлого зелёного прогона; reports/ вне git) или не
 * содержать фейлов (ошибка компиляции, конфиг-ошибка). Во всех этих случаях
 * diagnoseStep возвращает null — потребители показывают хвост output.
 *
 * Без зависимостей от node_modules: модуль импортирует verify и хук
 * stop-verify (З4).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

import { clean, isVitestReport } from './report-shape.ts';
import type { Step } from './verify-steps.ts';

export interface Diagnostic {
  file: string;
  line?: number;
  message: string;
}

export interface StepDiagnostics {
  /** Откуда список: `vitest-json`, `tsc-stdout` или `oxlint-agent`. */
  source: string;
  findings: Diagnostic[];
}

/** Список режется, чтобы не вернуть простыню: хвост адреснее миллиона строк. */
export const MAX_FINDINGS = 60;
/**
 * Отчёт, записанный раньше старта шага больше чем на slack, — остаток прошлого
 * прогона: диагностики по нему нет (дереградация к хвосту), иначе verify
 * врал бы агенту «свежим» списком. Slack — на рассинхрон часов и lazy-запись.
 */
const FRESHNESS_SLACK_MS = 1500;
/** Длина одного сообщения: суть ошибки, не весь стек. */
const MAX_MESSAGE = 240;

/** Диагностика по имени шага; неизвестный шаг — null (хвост как раньше). */
export function diagnoseStep(
  step: Step,
  fullOutput: string,
  startedMs: number,
  root: string,
): StepDiagnostics | null {
  switch (step.name) {
    case 'test':
    case 'test:hooks':
      return fromVitestReports(step.name, startedMs, root);
    case 'typecheck':
    case 'typecheck:tools':
      return fromTscOutput(fullOutput, root);
    case 'lint':
      return fromOxlintAgent(fullOutput, root);
    default:
      return null;
  }
}

/**
 * Формат строки для агента: `файл:строка: сообщение`; строка без числа, если
 * источник её не даёт (vitest-отчёт без стека). Ограничен MAX_FINDINGS.
 */
export function formatFindings(diagnostics: StepDiagnostics): string {
  const { findings } = diagnostics;
  const shown = findings.slice(0, MAX_FINDINGS);
  const lines = shown.map((finding) => {
    const at = finding.line === undefined ? '' : `:${finding.line}`;
    return `${finding.file}${at}: ${finding.message}`;
  });
  if (findings.length > MAX_FINDINGS) {
    lines.push(`… and ${findings.length - MAX_FINDINGS} more (source: ${diagnostics.source})`);
  }
  return lines.join('\n');
}

// --- Vitest JSON -------------------------------------------------------------------

function vitestReportPaths(stepName: string, root: string): string[] {
  if (stepName === 'test:hooks') {
    return [resolve(root, 'reports/vitest-hooks.json')];
  }
  const paths: string[] = [];
  for (const top of ['apps', 'packages']) {
    const topDir = resolve(root, top);
    if (!existsSync(topDir)) {
      continue;
    }
    for (const entry of readdirSync(topDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const candidate = resolve(root, top, entry.name, 'reports', 'vitest.json');
      if (existsSync(candidate)) {
        paths.push(candidate);
      }
    }
  }
  return paths;
}

function fromVitestReports(
  stepName: string,
  startedMs: number,
  root: string,
): StepDiagnostics | null {
  const findings: Diagnostic[] = [];
  for (const reportPath of vitestReportPaths(stepName, root)) {
    let writtenMs: number;
    try {
      writtenMs = statSync(reportPath).mtimeMs;
    } catch {
      continue;
    }
    if (writtenMs < startedMs - FRESHNESS_SLACK_MS) {
      continue;
    }
    let report: unknown;
    try {
      report = JSON.parse(readFileSync(reportPath, 'utf8')) as unknown;
    } catch {
      continue;
    }
    if (!isRecord(report) || !isVitestReport(report)) {
      continue;
    }
    collectVitestFindings(report, root, findings);
  }
  if (findings.length === 0) {
    return null;
  }
  return { source: 'vitest-json', findings };
}

function collectVitestFindings(
  report: Record<string, unknown>,
  root: string,
  findings: Diagnostic[],
): void {
  const testResults = report['testResults'];
  if (!Array.isArray(testResults)) {
    return;
  }
  for (const fileResult of testResults) {
    if (!isRecord(fileResult)) {
      continue;
    }
    const fileName = typeof fileResult['name'] === 'string' ? fileResult['name'] : '(unknown file)';
    const file = isAbsolute(fileName) ? relative(root, fileName) : fileName;
    const assertions = fileResult['assertionResults'];
    if (!Array.isArray(assertions)) {
      continue;
    }
    for (const raw of assertions) {
      if (!isRecord(raw)) {
        continue;
      }
      const status = typeof raw['status'] === 'string' ? raw['status'] : '';
      if (status !== 'failed') {
        continue;
      }
      const fullName = typeof raw['fullName'] === 'string' ? clean(raw['fullName']) : '(unnamed)';
      const messages = raw['failureMessages'];
      const firstMessage =
        Array.isArray(messages) && typeof messages[0] === 'string' ? firstLine(messages[0]) : '';
      const line =
        Array.isArray(messages) && typeof messages[0] === 'string'
          ? stackLineOf(messages[0], fileName)
          : undefined;
      const message = firstMessage === '' ? fullName : truncate(`${fullName}: ${firstMessage}`);
      // exactOptionalPropertyTypes: line без числа не пишется вовсе.
      findings.push(line === undefined ? { file, message } : { file, line, message });
    }
  }
}

/** Первая строка сообщения об ошибке, очищенная от управляющих символов. */
function firstLine(message: string): string {
  const raw = message.split('\n').find((line) => line.trim() !== '') ?? '';
  return clean(raw.trim());
}

/** Строка стека с этим файлом → номер строки; стек пишет абсолютный путь. */
function stackLineOf(message: string, fileName: string): number | undefined {
  if (!isAbsolute(fileName)) {
    return undefined;
  }
  const marker = `${fileName}:`;
  for (const line of message.split('\n')) {
    const index = line.indexOf(marker);
    if (index < 0) {
      continue;
    }
    const rest = line.slice(index + marker.length);
    const match = /^(\d+):/.exec(rest);
    if (match !== null) {
      return Number(match[1]);
    }
  }
  return undefined;
}

function truncate(message: string): string {
  return message.length > MAX_MESSAGE ? `${message.slice(0, MAX_MESSAGE)}…` : message;
}

// --- tsc (typecheck) ---------------------------------------------------------------

const TSC_ERROR = /^\s*([^\s(:]+)\((\d+),(\d+)\):\s*error\s+(\S+):\s*(.*)$/;

function fromTscOutput(fullOutput: string, root: string): StepDiagnostics | null {
  const findings: Diagnostic[] = [];
  for (const textLine of fullOutput.split('\n')) {
    const match = TSC_ERROR.exec(textLine);
    if (match === null) {
      continue;
    }
    const [, rawFile, rawLine, , code, text] = match;
    const file = rawFile === undefined ? '(unknown file)' : relOrSelf(rawFile, root);
    const message = code === undefined ? (text ?? '') : `${code}: ${text ?? ''}`;
    const line = rawLine === undefined ? undefined : Number(rawLine);
    findings.push(
      line === undefined
        ? { file, message: truncate(clean(message.trim())) }
        : { file, line, message: truncate(clean(message.trim())) },
    );
  }
  if (findings.length === 0) {
    return null;
  }
  return { source: 'tsc-stdout', findings };
}

// --- oxlint agent (lint) -----------------------------------------------------------

const AGENT_LINE = /^\s*([^\s:][^:]*?):(\d+):(\d+):\s*(.*)$/;

/**
 * Формат `agent` oxlint уже адресный (`файл:строка:колонка: сообщение`) —
 * строки пропускаются как есть, без перепарсивания ошибок; file/line
 * выписываются из префикса, если он там есть.
 */
function fromOxlintAgent(fullOutput: string, root: string): StepDiagnostics | null {
  const findings: Diagnostic[] = [];
  for (const textLine of fullOutput.split('\n')) {
    if (textLine.trim() === '') {
      continue;
    }
    const match = AGENT_LINE.exec(textLine);
    if (match === null) {
      findings.push({ file: '(oxlint)', message: truncate(clean(textLine.trim())) });
      continue;
    }
    const [, rawFile, rawLine, , text] = match;
    const file = rawFile === undefined ? '(oxlint)' : relOrSelf(rawFile, root);
    const message = truncate(clean((text ?? '').trim()));
    const line = rawLine === undefined ? undefined : Number(rawLine);
    findings.push(line === undefined ? { file, message } : { file, line, message });
  }
  if (findings.length === 0) {
    return null;
  }
  return { source: 'oxlint-agent', findings };
}

function relOrSelf(path: string, root: string): string {
  return isAbsolute(path) ? relative(root, path) : path.replace(/^\.\//, '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
