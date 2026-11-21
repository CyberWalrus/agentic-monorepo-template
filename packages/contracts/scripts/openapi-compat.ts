/**
 * Гейт несовместимых изменений контракта (C6): закоммиченный openapi.json
 * сравнивается с его версией на базе ветвления. Несовместимые изменения
 * (удаление процедуры или поля, новое обязательное поле входа, сужение типа)
 * красят шаг verify `openapi`; одобряет их человек через ревью PR — тот же
 * механизм, что у bundle-delta (ADR 0013). Ручная процедура — скил
 * api-contract-change, раздел «Breaking changes»; гейт держит её
 * детерминированную часть (З1).
 *
 * Правила (база → текущая):
 *  - удаление процедуры (path+method), status-code ответа, параметра;
 *  - удаление поля во входе и в ответе (переименование ловится как удаление);
 *  - новое обязательное поле входа; новое обязательное поле ответа (новое
 *    свойство, сразу required); обязательное поле ответа стало опциональным;
 *  - сужение входа: type/enum/const/format/pattern/границы — старые валидные
 *    запросы становятся невалидными;
 *  - расширение выхода: type/enum/const/format/pattern/границы — сервер может
 *    отдать значения, которые старый клиент не разберёт.
 * Добавления (процедура, опциональное поле, новый error-код, вариант union,
 * расширение входа) проходят.
 *
 * Чекер покрывает словарь ключей, который выпускает генератор
 * (scripts/openapi-spec.ts), плюс типовые ключи JSON Schema впрок; неизвестные
 * ключи не сравниваются. Сравнение — свой структурный обход без внешних
 * зависимостей: словарь мал и стабилен, npm-инструменты тянут supply-chain.
 *
 * База: --base <ref> → TURBO_SCM_BASE (CI, ci.yml) → git merge-base HEAD
 * origin/main (локально). openapi.json на базе отсутствует → база пустая,
 * все изменения — добавления. Нет merge-base или битая спека — красный
 * с причиной (fail-closed, как tools/check-bundle-delta.ts).
 *
 *   node scripts/openapi-compat.ts [--base <ref>]
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Направление сравнения: input — сужается ли принимаемое, output — ширится ли отдаваемое. */
export type Direction = 'request' | 'output';

/** Несовместимое изменение: kind — машинный класс, where — место в API, message — для человека. */
export interface Finding {
  kind: string;
  where: string;
  message: string;
}

/** Подмножество JSON Schema 3.1, выпускаемое генератором; неизвестные ключи игнорируются. */
export interface SchemaNode {
  type?: string | string[];
  format?: string;
  enum?: unknown[];
  const?: unknown;
  properties?: Record<string, SchemaNode>;
  required?: string[];
  items?: SchemaNode;
  oneOf?: SchemaNode[];
  anyOf?: SchemaNode[];
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  pattern?: string;
  minItems?: number;
  maxItems?: number;
}

interface ParameterNode {
  name?: string;
  in?: string;
  required?: boolean;
  schema?: SchemaNode;
}

interface ContentNode {
  schema?: SchemaNode;
}

interface OperationNode {
  parameters?: ParameterNode[];
  requestBody?: { required?: boolean; content?: Record<string, ContentNode> };
  responses?: Record<string, { content?: Record<string, ContentNode> }>;
}

export interface SpecDocument {
  paths?: Record<string, Record<string, OperationNode>>;
}

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Разбор JSON-текста спецификации; null — текст не является объектом. */
export function parseSpec(text: string): SpecDocument | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  return isRecord(parsed) ? parsed : null;
}

const EMPTY_SPEC: SpecDocument = {};

// --- Покрытие множеств токенов ----------------------------------------------------

/** integer покрывается number: значения integer парсятся как number. */
function tokenCovers(cover: string, covered: string): boolean {
  return cover === covered || (cover === 'number' && covered === 'integer');
}

/** Каждый токен A покрывается хоть одним токеном B (A ⊆ B). */
function tokensCovered(set: string[], by: string[]): boolean {
  return set.every((token) => by.some((candidate) => tokenCovers(candidate, token)));
}

function typeTokens(schema: SchemaNode): string[] | null {
  if (schema.type === undefined) {
    return null;
  }
  return Array.isArray(schema.type) ? schema.type : [schema.type];
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => valuesEqual(item, b[index]));
  }
  if (isRecord(a) && isRecord(b)) {
    const aKeys = Object.keys(a).toSorted();
    const bKeys = Object.keys(b).toSorted();
    return (
      aKeys.length === bKeys.length && aKeys.every((key) => key in b && valuesEqual(a[key], b[key]))
    );
  }
  return false;
}

// --- Ядро: сравнение схем -----------------------------------------------------------

/**
 * Направленно-чувствительные правила. request: нарушение — когда принимаемое
 * множество сузилось (старый валидный запрос отвергнут); output: — когда
 * отдаваемое расширилось (старый клиент получает непарсируемое).
 */
export function diffSchema(
  base: SchemaNode,
  current: SchemaNode,
  dir: Direction,
  where: string,
): Finding[] {
  const findings: Finding[] = [];
  const report = (kind: string, message: string): void => {
    findings.push({ kind, where, message });
  };

  // 1. Union (oneOf/anyOf): каждый вариант базы обязан остаться совместимым
  //    хотя бы с одним вариантом текущей. Совместимость — «нет находок» того
  //    же сравнения; добавленные варианты — добавления, проходят.
  const baseUnion = base.oneOf ?? base.anyOf;
  const currentUnion = current.oneOf ?? current.anyOf;
  if (baseUnion !== undefined || currentUnion !== undefined) {
    for (const variant of baseUnion ?? []) {
      const matched =
        currentUnion === undefined
          ? diffSchema(variant, current, dir, where).length === 0
          : currentUnion.some(
              (candidate) => diffSchema(variant, candidate, dir, where).length === 0,
            );
      if (!matched) {
        report('union-option-removed', 'вариант union удалён или изменился несовместимо');
      }
    }
    if (baseUnion === undefined && currentUnion !== undefined) {
      // Одиночная схема стала union: вход должен принимать прежнюю форму,
      // выход — отдавать её; иначе старые потребители ломаются.
      const stillCompatible = currentUnion.some(
        (candidate) => diffSchema(base, candidate, dir, where).length === 0,
      );
      if (!stillCompatible) {
        report('type-changed', 'схема изменилась несовместимо со старой формой');
      }
    }
    return findings;
  }

  // 2. type: request — все токены базы должны покрываться текущими; output —
  //    все текущие должны покрываться базовыми.
  const baseType = typeTokens(base);
  const currentType = typeTokens(current);
  if (baseType === null && currentType !== null) {
    if (dir === 'request') {
      report(
        'type-narrowed',
        `появился type ${JSON.stringify(currentType)}: принимаемое множество сузилось`,
      );
    }
  } else if (baseType !== null && currentType === null) {
    if (dir === 'output') {
      report('type-widened', 'type снят: сервер может отдать значение произвольного типа');
    }
  } else if (baseType !== null && currentType !== null) {
    const covered =
      dir === 'request'
        ? tokensCovered(baseType, currentType)
        : tokensCovered(currentType, baseType);
    if (!covered) {
      report('type-changed', `type ${JSON.stringify(baseType)} → ${JSON.stringify(currentType)}`);
    }
  }

  // 3. format: как type — ограничение принимаемого/отдаваемого множества.
  if (base.format !== undefined && current.format === undefined) {
    if (dir === 'output') {
      report('format-removed', `format ${base.format} снят`);
    }
  } else if (base.format === undefined && current.format !== undefined) {
    if (dir === 'request') {
      report('format-narrowed', `появился format ${current.format}`);
    }
  } else if (base.format !== current.format) {
    report('format-changed', `format ${String(base.format)} → ${String(current.format)}`);
  }

  // 4. enum и const — те же множества значений.
  if (base.enum !== undefined || current.enum !== undefined) {
    const baseValues = base.enum;
    const currentValues = current.enum;
    if (baseValues !== undefined && currentValues === undefined) {
      if (dir === 'output') {
        report('enum-widened', 'enum снят: значение может быть любым');
      }
    } else if (baseValues === undefined && currentValues !== undefined) {
      if (dir === 'request') {
        report('enum-narrowed', `появился enum ${JSON.stringify(currentValues)}`);
      }
    } else if (baseValues !== undefined && currentValues !== undefined) {
      const covered =
        dir === 'request'
          ? baseValues.every((value) =>
              currentValues.some((candidate) => valuesEqual(candidate, value)),
            )
          : currentValues.every((value) =>
              baseValues.some((candidate) => valuesEqual(candidate, value)),
            );
      if (!covered) {
        report(
          'enum-changed',
          `enum ${JSON.stringify(baseValues)} → ${JSON.stringify(currentValues)}`,
        );
      }
    }
  }
  if (base.const !== undefined || current.const !== undefined) {
    if (base.const !== undefined && current.const === undefined) {
      if (dir === 'output') {
        report('const-removed', 'const снят: значение может отличаться от прежнего');
      }
    } else if (base.const === undefined && current.const !== undefined) {
      if (dir === 'request') {
        report('const-narrowed', `появился const ${JSON.stringify(current.const)}`);
      }
    } else if (!valuesEqual(base.const, current.const)) {
      report(
        'const-changed',
        `const ${JSON.stringify(base.const)} → ${JSON.stringify(current.const)}`,
      );
    }
  }

  // 5. Свойства объекта: удаление — нарушение в обе стороны (скил
  //    api-contract-change: «удаление поля … breaking», переименование —
  //    оно же). Новое обязательное свойство: вход — нарушение всегда, выход —
  //    только если свойство новое (существующее стало обязательным — сервер
  //    лишь перестал его пропускать). Обязательное свойство ответа стало
  //    опциональным — нарушение: обещание присутствия ослаблено.
  const baseProperties = base.properties ?? {};
  const currentProperties = current.properties ?? {};
  const baseRequired = new Set(base.required ?? []);
  const currentRequired = new Set(current.required ?? []);
  for (const name of Object.keys(baseProperties)) {
    const next = currentProperties[name];
    if (next === undefined) {
      const side = dir === 'request' ? 'request-field-removed' : 'response-field-removed';
      findings.push({
        kind: side,
        where: `${where}.properties.${name}`,
        message: `поле «${name}» удалено`,
      });
      continue;
    }
    findings.push(
      ...diffSchema(baseProperties[name] ?? {}, next, dir, `${where}.properties.${name}`),
    );
  }
  for (const name of Object.keys(currentProperties)) {
    if (name in baseProperties) {
      continue;
    }
    if (currentRequired.has(name)) {
      if (dir === 'request') {
        report('required-field-added', `поле «${name}» добавлено как обязательное`);
      } else {
        report('required-response-field-added', `поле «${name}» добавлено как обязательное`);
      }
    }
  }
  // Существовавшее свойство стало обязательным: ломает только вход (старые
  // запросы без него отвергнутся). В ответе сервер лишь перестал пропускать
  // поле — потребителям, которые его уже читают, безразлично.
  for (const name of currentRequired) {
    if (dir !== 'request' || baseRequired.has(name) || !(name in baseProperties)) {
      continue;
    }
    report('required-field-added', `поле «${name}» стало обязательным`);
  }
  for (const name of baseRequired) {
    if (!currentRequired.has(name) && dir === 'output' && name in currentProperties) {
      report('required-response-field-weakened', `обязательное поле «${name}» стало опциональным`);
    }
  }

  // 6. Элементы массива — то же сравнение, что и сама схема.
  if (base.items !== undefined && current.items !== undefined) {
    findings.push(...diffSchema(base.items, current.items, dir, `${where}.items`));
  } else if (base.items === undefined && current.items !== undefined) {
    if (dir === 'request') {
      report('items-narrowed', 'элементам массива добавлена схема: принимаемое множество сузилось');
    }
  } else if (base.items !== undefined && current.items === undefined) {
    if (dir === 'output') {
      report('items-widened', 'схема элементов массива снята');
    }
  }

  // 7. Границы: request — ужесточение, output — ослабление; направление
  //    нарушения симметрично type/enum.
  const bound = (
    keyword:
      | 'minLength'
      | 'maxLength'
      | 'minimum'
      | 'maximum'
      | 'exclusiveMinimum'
      | 'exclusiveMaximum'
      | 'minItems'
      | 'maxItems',
    breaksRequest: (baseValue: number, currentValue: number) => boolean,
  ): void => {
    const from = base[keyword];
    const to = current[keyword];
    if (typeof from !== 'number' || typeof to !== 'number' || from === to) {
      return;
    }
    if (breaksRequest(from, to) === (dir === 'request')) {
      report(
        'bound-changed',
        `${keyword} ${String(from)} → ${String(to)} (${dir === 'request' ? 'приём сужен' : 'выдача расширена'})`,
      );
    }
  };
  bound('minLength', (from, to) => to > from);
  bound('maxLength', (from, to) => to < from);
  bound('minimum', (from, to) => to > from);
  bound('maximum', (from, to) => to < from);
  bound('exclusiveMinimum', (from, to) => to > from);
  bound('exclusiveMaximum', (from, to) => to < from);
  bound('minItems', (from, to) => to > from);
  bound('maxItems', (from, to) => to < from);

  // 8. pattern — множество совпадений меняется непредсказуемо: появление
  //    сужает приём, снятие расширяет выдачу, замена — нарушение в обе стороны.
  if (base.pattern !== undefined && current.pattern === undefined) {
    if (dir === 'output') {
      report('pattern-widened', 'pattern снят');
    }
  } else if (base.pattern === undefined && current.pattern !== undefined) {
    if (dir === 'request') {
      report('pattern-narrowed', `появился pattern ${current.pattern}`);
    }
  } else if (base.pattern !== current.pattern) {
    report('pattern-changed', `pattern ${String(base.pattern)} → ${String(current.pattern)}`);
  }

  return findings;
}

// --- Сравнение операций --------------------------------------------------------------

function mediaTypes(content: Record<string, ContentNode> | undefined): string[] {
  return content === undefined ? [] : Object.keys(content);
}

function compareContent(
  base: Record<string, ContentNode> | undefined,
  current: Record<string, ContentNode> | undefined,
  dir: Direction,
  where: string,
): Finding[] {
  const findings: Finding[] = [];
  const baseMedia = mediaTypes(base);
  const currentMedia = mediaTypes(current);
  for (const media of baseMedia) {
    if (!currentMedia.includes(media)) {
      findings.push({
        kind: dir === 'request' ? 'request-media-removed' : 'response-schema-removed',
        where,
        message: `media-тип «${media}» удалён вместе со схемой`,
      });
      continue;
    }
    const from = base?.[media]?.schema ?? {};
    const to = current?.[media]?.schema ?? {};
    findings.push(...diffSchema(from, to, dir, `${where}.${media}`));
  }
  return findings;
}

function parameterKey(parameter: ParameterNode): string {
  return `${parameter.in ?? ''}:${parameter.name ?? ''}`;
}

function compareOperation(base: OperationNode, current: OperationNode, where: string): Finding[] {
  const findings: Finding[] = [];

  // Параметры: совпадение по in:name. Удаление — нарушение; добавленный
  // обязательный параметр меняет форму вызова; добавленный опциональный —
  // добавление.
  const baseParameters = base.parameters ?? [];
  const currentParameters = current.parameters ?? [];
  const currentIndex = new Map(
    currentParameters.map((parameter) => [parameterKey(parameter), parameter]),
  );
  for (const parameter of baseParameters) {
    const next = currentIndex.get(parameterKey(parameter));
    if (next === undefined) {
      findings.push({
        kind: 'parameter-removed',
        where,
        message: `параметр ${parameter.in ?? ''}:${parameter.name ?? ''} удалён`,
      });
      continue;
    }
    if (parameter.required !== true && next.required === true) {
      findings.push({
        kind: 'required-field-added',
        where,
        message: `параметр ${parameter.in ?? ''}:${parameter.name ?? ''} стал обязательным`,
      });
    }
    findings.push(
      ...diffSchema(
        parameter.schema ?? {},
        next.schema ?? {},
        'request',
        `${where}.parameters.${parameter.name ?? ''}`,
      ),
    );
  }
  for (const parameter of currentParameters) {
    if (baseParameters.some((candidate) => parameterKey(candidate) === parameterKey(parameter))) {
      continue;
    }
    if (parameter.required === true) {
      findings.push({
        kind: 'required-field-added',
        where,
        message: `добавлен обязательный параметр ${parameter.in ?? ''}:${parameter.name ?? ''}`,
      });
    }
  }

  // Тело запроса.
  const baseBody = base.requestBody;
  const currentBody = current.requestBody;
  if (baseBody === undefined && currentBody !== undefined && currentBody.required !== false) {
    findings.push({
      kind: 'required-field-added',
      where,
      message: 'добавлено обязательное тело запроса',
    });
  } else if (baseBody !== undefined && currentBody === undefined) {
    findings.push({
      kind: 'request-body-removed',
      where,
      message: 'тело запроса удалено',
    });
  } else if (baseBody !== undefined && currentBody !== undefined) {
    if (baseBody.required !== true && currentBody.required === true) {
      findings.push({
        kind: 'required-field-added',
        where,
        message: 'тело запроса стало обязательным',
      });
    }
    findings.push(
      ...compareContent(baseBody.content, currentBody.content, 'request', `${where}.requestBody`),
    );
  }

  // Ответы: удалённый код — нарушение; у общих кодов сравниваются схемы
  // в направлении output. Добавленные коды (в т.ч. error) — добавления.
  const baseResponses = base.responses ?? {};
  const currentResponses = current.responses ?? {};
  for (const [code, response] of Object.entries(baseResponses)) {
    const next = currentResponses[code];
    if (next === undefined) {
      findings.push({
        kind: 'response-status-removed',
        where,
        message: `ответ ${code} удалён`,
      });
      continue;
    }
    findings.push(
      ...compareContent(response.content, next.content, 'output', `${where}.responses.${code}`),
    );
  }

  return findings;
}

/** Индекс операций текущей и базовой спецификаций: «METHOD /path» → операция. */
export function operationsOf(spec: SpecDocument): Map<string, OperationNode> {
  const operations = new Map<string, OperationNode>();
  const paths = spec.paths ?? {};
  for (const [path, methods] of Object.entries(paths)) {
    if (!isRecord(methods)) {
      continue;
    }
    for (const [method, operation] of Object.entries(methods)) {
      if (HTTP_METHODS.has(method) && isRecord(operation)) {
        operations.set(`${method.toUpperCase()} ${path}`, operation);
      }
    }
  }
  return operations;
}

/** Полное сравнение спецификаций; пустой список — несовместимых изменений нет. */
export function checkCompatibility(base: SpecDocument, current: SpecDocument): Finding[] {
  const findings: Finding[] = [];
  const baseOperations = operationsOf(base);
  const currentOperations = operationsOf(current);
  for (const [key, operation] of currentOperations) {
    const previous = baseOperations.get(key);
    if (previous !== undefined) {
      findings.push(...compareOperation(previous, operation, key));
    }
  }
  for (const key of baseOperations.keys()) {
    if (!currentOperations.has(key)) {
      findings.push({
        kind: 'procedure-removed',
        where: key,
        message: 'процедура удалена из контракта',
      });
    }
  }
  return findings;
}

// --- CLI -----------------------------------------------------------------------------

// scripts/ → contracts → packages → корень репозитория.
const repoRoot = resolve(import.meta.dirname, '../../..');
const specRelative = 'packages/contracts/openapi.json';

function git(args: string[]): { status: number; output: string } {
  const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
  return { status: result.status ?? -1, output: `${result.stdout}${result.stderr}` };
}

function fail(messages: string[], exitCode = 1): never {
  console.error(messages.join('\n'));
  process.exit(exitCode);
}

function main(): void {
  // --base <ref>: единственный флаг; неизвестный аргумент — отказ, не игнор.
  const argv = process.argv.slice(2);
  let flagBase: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--base') {
      flagBase = argv[index + 1];
      if (!flagBase) {
        fail(['openapi-compat: --base требует значение <ref>'], 2);
      }
      index += 1;
      continue;
    }
    fail([`openapi-compat: неизвестный аргумент «${String(arg)}» (ожидается --base <ref>)`], 2);
  }

  const currentText = (() => {
    try {
      return readFileSync(`${repoRoot}/${specRelative}`, 'utf8');
    } catch (error) {
      return fail([
        `openapi-compat: ${specRelative} не прочитан: ${error instanceof Error ? error.message : String(error)}`,
        '  Сгенерируй спецификацию: pnpm --filter @repo/contracts openapi.',
      ]);
    }
  })();
  const current = parseSpec(currentText);
  if (current === null) {
    fail([
      `openapi-compat: ${specRelative} не является корректным JSON.`,
      '  Сгенерируй спецификацию: pnpm --filter @repo/contracts openapi.',
    ]);
  }

  // База: флаг → TURBO_SCM_BASE (CI передаёт base.sha PR) → merge-base с main.
  const envBase = process.env['TURBO_SCM_BASE'];
  let baseRef = flagBase ?? (envBase !== undefined && envBase !== '' ? envBase : undefined);
  if (baseRef !== undefined) {
    const verified = git(['rev-parse', '--verify', `${baseRef}^{commit}`]);
    if (verified.status !== 0) {
      fail([
        `openapi-compat: база ${baseRef} не резолвится в коммит.`,
        `  ${verified.output.trim().split('\n').at(-1) ?? ''}`,
      ]);
    }
  } else {
    const mergeBase = git(['merge-base', 'HEAD', 'origin/main']);
    if (mergeBase.status !== 0) {
      fail([
        'openapi-compat: база не определена: git merge-base HEAD origin/main завершился с ошибкой.',
        '  Выполни git fetch origin main или передай --base <ref> (в CI base приходит в TURBO_SCM_BASE).',
      ]);
    }
    baseRef = mergeBase.output.trim().split('\n').at(-1) ?? '';
  }

  const shown = git(['show', `${baseRef}:${specRelative}`]);
  let base: SpecDocument = EMPTY_SPEC;
  if (shown.status !== 0) {
    // Файла не было на базе — вся текущая спецификация состоит из добавлений.
    console.log(
      `openapi-compat: ${specRelative} отсутствует на базе ${baseRef} — все изменения считаются добавлениями`,
    );
  } else {
    const parsed = parseSpec(shown.output);
    if (parsed === null) {
      fail([`openapi-compat: ${specRelative} на базе ${baseRef} не является корректным JSON.`]);
    }
    base = parsed;
  }

  const findings = checkCompatibility(base, current);
  if (findings.length === 0) {
    console.log(
      `openapi-compat: несовместимых изменений контракта относительно ${baseRef} нет (${operationsOf(current).size} операций)`,
    );
    return;
  }
  const lines = [
    `✗ Найдены несовместимые изменения контракта относительно ${baseRef} (${findings.length}):`,
    ...findings.map((finding) => `  - [${finding.kind}] ${finding.where}: ${finding.message}`),
    '',
    '  Несовместимые изменения требуют явного согласия человека: ADR в docs/adr/',
    '  и ревью PR (скил api-contract-change, раздел «Breaking changes»).',
    '  Делай аддитивно: новое опциональное поле или процедура, миграция клиентов,',
    '  удаление старого — отдельным PR.',
  ];
  fail(lines);
}

const invokedDirectly =
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;

if (invokedDirectly) {
  main();
}
