/**
 * Рабочее пространство — носитель изоляции E2E-сценариев (ADR 0020). Хранится
 * в строке хранилища (как ownerId — серверные данные вне публичного контракта)
 * и читается из заголовка запроса. Один общий парсер: API (контекст RPC и
 * `/__test__/*`) и web (SSR-проброс) обязаны толковать заголовок одинаково.
 *
 * e58: заголовок описан в спеке. Процедура, которая его читает, помечается
 * обёрткой readsWorkspace в момент определения, а сборка спеки
 * (scripts/openapi-spec.ts) навешивает на каждую такую операцию
 * WORKSPACE_HEADER_PARAMETER. Имя, форма и семантика заголовка живут здесь —
 * одном источнике для парсера и спеки.
 */
import type { AnyContractRouter, OpenAPI } from '@orpc/contract';

/** Заголовок-носитель рабочего пространства (ADR 0020). */
export const WORKSPACE_HEADER = 'x-workspace-id';

/**
 * Допустимая форма идентификатора рабочего пространства. Валидация — не
 * безопасность (авторизации в шаблоне ещё нет), а гигиена хранилища: мусорный
 * заголовок не становится ключом данных навсегда. Источник один: строка
 * уходит и в парсер, и в схему заголовка спеки.
 */
const WORKSPACE_ID_PATTERN_SOURCE = String.raw`^[\w-]{1,64}$`;
const WORKSPACE_ID_PATTERN = new RegExp(WORKSPACE_ID_PATTERN_SOURCE);

/**
 * Рабочее пространство запроса или null — «ничей»: запрос без заголовка (ручные
 * клиенты, k6) видит и создаёт только ничейные задачи — текущее поведение
 * продуктовых клиентов до появления реальных арендаторов (ADR 0020).
 */
export function parseWorkspaceId(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  return WORKSPACE_ID_PATTERN.test(value) ? value : null;
}

/**
 * Параметр заголовка OpenAPI: то, что клиент из openapi.json узнаёт о
 * рабочем пространстве. Необязательный — семантика «заголовка нет» остаётся
 * задокументированным режимом (e58, «Решение»): отсутствующий или
 * недопустимой формы заголовок не отказывает, а переводит запрос в «ничей»
 * scope. Коды в тексте — ответы процедур задач; в спеке они объявлены у самих
 * операций.
 */
export const WORKSPACE_HEADER_PARAMETER = {
  name: WORKSPACE_HEADER,
  in: 'header',
  required: false,
  description:
    'Workspace of the request — the isolation scope of E2E scenarios. 1 to 64 characters: letters, digits, underscore or hyphen. ' +
    'Optional: without the header, or when its value is not of this form, the request runs in the ownerless scope and only lists and changes the tasks that belong to no workspace; no error is answered, so a misspelled header name silently selects another scope. ' +
    'Tasks of another workspace are out of reach: toggle answers 404, remove answers 403.',
  schema: { type: 'string', pattern: WORKSPACE_ID_PATTERN_SOURCE },
} as const satisfies OpenAPI.ParameterObject;

/**
 * Процедуры, читающие заголовок рабочего пространства.
 *
 * Тип meta строителей закрыт: access-policy.ts допускает в meta только
 * `access` и отвергает лишние ключи. Поэтому связь с заголовком процедура
 * объявляет не meta, а обёрткой в момент определения — последнее звено цепочки:
 *
 *   list: readsWorkspace(ocPublic.route({ … }).meta({ … }).output(…)),
 *
 * Строители неизменяемы: вызов после обёртки вернул бы новую процедуру без
 * метки. Не помеченная процедура считается заголовок не читающей — держит тест
 * домена: каждая его процедура помечена (tasks.test.ts).
 *
 * Реестр — по экземпляру процедуры, а не по списку имён: `pnpm gen feature`
 * добавляет домен со своими процедурами, и список по именам расходился бы с
 * роутером по построению (e56).
 */
const workspaceReaders = new WeakSet<object>();

/** Помечает процедуру контракта как читающую заголовок рабочего пространства. */
export function readsWorkspace<T extends object>(procedure: T): T {
  workspaceReaders.add(procedure);
  return procedure;
}

/** Читает ли процедура заголовок рабочего пространства. */
export function isWorkspaceReader(procedure: object): boolean {
  return workspaceReaders.has(procedure);
}

/**
 * Часть контрактной процедуры, читаемая здесь. `route` у процедуры контракта —
 * всегда объект (пустой, если `.route(...)` не вызывался), поэтому наличие
 * его не проверяется.
 */
interface ContractProcedure {
  readonly '~orpc': { readonly route: { readonly method?: string; readonly path?: string } };
}

function isProcedure(value: unknown): value is ContractProcedure {
  return (
    typeof value === 'object' &&
    value !== null &&
    '~orpc' in value &&
    typeof value['~orpc'] === 'object' &&
    value['~orpc'] !== null
  );
}

/** Все процедуры роутера контракта, рекурсивно по вложенным роутерам. */
function* procedures(router: AnyContractRouter): Generator<ContractProcedure> {
  if (isProcedure(router)) {
    yield router;
    return;
  }
  for (const value of Object.values(router)) {
    yield* procedures(value);
  }
}

/**
 * Операции («METHOD /path»), которые читают заголовок рабочего пространства:
 * операции процедур, помеченных readsWorkspace. Fail-closed: читатель без
 * полного route — ошибка, а не операция без описанного заголовка.
 */
export function workspaceScopedOperations(router: AnyContractRouter): ReadonlySet<string> {
  const operations = new Set<string>();
  for (const procedure of procedures(router)) {
    if (!isWorkspaceReader(procedure)) {
      continue;
    }
    const { method, path } = procedure['~orpc'].route;
    if (method === undefined || path === undefined) {
      throw new Error(
        `A workspace-scoped procedure needs a route to document the ${WORKSPACE_HEADER} header: readsWorkspace wraps a procedure with no method or no path`,
      );
    }
    operations.add(`${method.toUpperCase()} ${path}`);
  }
  return operations;
}

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;

/** Заголовок рабочего пространства среди параметров операции — объявлен ли он уже. */
function hasWorkspaceHeader(parameters: readonly unknown[]): boolean {
  return parameters.some(
    (parameter) =>
      typeof parameter === 'object' &&
      parameter !== null &&
      'name' in parameter &&
      parameter.name === WORKSPACE_HEADER &&
      'in' in parameter &&
      parameter.in === 'header',
  );
}

/**
 * Описывает заголовок рабочего пространства у операций, которые его читают
 * (e58): каждой операции из scoped добавляет WORKSPACE_HEADER_PARAMETER.
 * Заголовок, уже объявленный контрактом, не трогает и не дублирует — источник
 * правды контракт, шаг вступает, только если параметра нет. Fail-closed:
 * операция из scoped, которой в спеке нет, — ошибка: читатель без описанного
 * заголовка не проходит молча. Меняет spec на месте и возвращает его же.
 */
export function documentWorkspaceHeader(
  spec: OpenAPI.Document,
  scoped: ReadonlySet<string>,
): OpenAPI.Document {
  const documented = new Set<string>();
  for (const [path, pathItem] of Object.entries(spec.paths ?? {})) {
    if (!pathItem) {
      continue;
    }
    for (const method of HTTP_METHODS) {
      const operation = pathItem[method];
      if (operation === undefined || !scoped.has(`${method.toUpperCase()} ${path}`)) {
        continue;
      }
      const parameters: readonly (OpenAPI.ReferenceObject | OpenAPI.ParameterObject)[] =
        operation.parameters ?? [];
      if (!hasWorkspaceHeader(parameters)) {
        operation.parameters = [...parameters, WORKSPACE_HEADER_PARAMETER];
      }
      documented.add(`${method.toUpperCase()} ${path}`);
    }
  }
  const missing = [...scoped].filter((key) => !documented.has(key));
  if (missing.length > 0) {
    throw new Error(
      `Workspace-scoped operations are missing from the spec, so the ${WORKSPACE_HEADER} header is left undocumented: ${missing.join(', ')}`,
    );
  }
  return spec;
}
