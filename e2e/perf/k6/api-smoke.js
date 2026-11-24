// k6 smoke для API: p95 и доля ошибок против /perf-budgets.json.
//
// Меряется продуктовый путь (e60): браузер ходит в `/rpc` своего web-origin,
// прокси production-entry web (apps/web/src/server-app.ts) пересылает запрос в
// API. Бюджет лежит на `WEB_URL/rpc/tasks/list` и `WEB_URL/rpc/tasks/toggle` —
// расходы oRPC-сериализации и прокси внутри порога. Прямой `GET /api/tasks`
// остаётся диагностикой без бюджета: разница с ним — цена слоя «прокси + oRPC».
//
// Формат запроса — проводной протокол RPCLink (@orpc/client): POST
// `/rpc/<процедура>`, тело — обёртка `{ json: <вход процедуры> }`, ответ —
// `{ json: <выход> }`. У процедуры без входа (list) в обёртке пусто: `{}`.
//
// Набор фиксирован (e60): перед замером setup доводит список до DATASET_SIZE
// задач тем же продуктовым create, поэтому от прогона к прогону список одного
// размера и p95 сравним. Замер набор не меняет: create растит список, remove
// требует владельца (политика «owner», анонимному клиенту — 403), поэтому
// create живёт только в setup. Список длиннее DATASET_SIZE setup не чинит и
// роняет прогон: замер по неизвестному набору не выдаётся за валидный.
//
// Запуск: eval "$(node tools/ports.ts --env)" && k6 run e2e/perf/k6/api-smoke.js
// — API и production-entry web (`pnpm --filter @repo/web start:prod`) должны
// быть подняты; WEB_URL и API_URL обязательны: порты выводятся из worktree —
// З9, A5; дефолта нет.
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate } from 'k6/metrics';

const budgets = JSON.parse(open('../../../perf-budgets.json'));
const WEB_URL = __ENV.WEB_URL;
const API_URL = __ENV.API_URL;
if (!WEB_URL || !API_URL) {
  throw new Error('WEB_URL or API_URL is empty: run `eval "$(node tools/ports.ts --env)"` first');
}

/** Размер набора: список из стольких задач меряется в каждом прогоне. */
const DATASET_SIZE = 50;
/** Попыток дождаться web в setup — на случай запуска до готовности сервера. */
const READY_ATTEMPTS = 10;

// Теги name: пороги адресуют свои подметрики, отчёт показывает тренды по путям.
const RPC_LIST = 'rpc-list';
const RPC_TOGGLE = 'rpc-toggle';
const API_DIRECT_LIST = 'api-direct-list';
const SETUP = 'rpc-setup';

// Доля запросов list, вернувших 200 с набором не того размера. Ошибку запроса
// считает http_req_failed, здесь — только «ответ есть, но набор чужой».
const datasetMismatch = new Rate('rpc_dataset_mismatch');

const thresholds = { rpc_dataset_mismatch: ['rate==0'] };
for (const name of [RPC_LIST, RPC_TOGGLE]) {
  thresholds[`http_req_duration{name:${name}}`] = [`p(95)<${budgets.api.maxP95Ms}`];
  thresholds[`http_req_failed{name:${name}}`] = [`rate<${budgets.api.maxErrorRate}`];
}
// Подметрика без порога: тренд прямого пути виден в отчёте рядом с бюджетными.
thresholds[`http_req_duration{name:${API_DIRECT_LIST}}`] = [];

export const options = {
  vus: 5,
  duration: '20s',
  thresholds,
};

/** Ошибка разбора последнего тела ответа — попадает в сообщение setup. */
let lastParseError = null;

/** Выход процедуры из ответа (`json` обёртки протокола); не JSON или без поля — null. */
function outputOf(response) {
  let body;
  try {
    body = response.json();
  } catch (error) {
    lastParseError = error;
    return null;
  }
  return typeof body === 'object' && body !== null && 'json' in body ? body.json : null;
}

function call(procedure, name, input) {
  return http.post(`${WEB_URL}/rpc/tasks/${procedure}`, JSON.stringify({ json: input }), {
    // JSON-обёртка протокола: с text/plain сервер не разбирает тело (вход
    // процедуры остаётся undefined, create отвечает 400).
    headers: { 'content-type': 'application/json' },
    tags: { name },
  });
}

/** id задач из ответа list; список не читается — null. */
function taskIdsOf(response) {
  const tasks = outputOf(response);
  return Array.isArray(tasks) ? tasks.map((task) => task.id) : null;
}

function listTasks(name) {
  return call('list', name, undefined);
}

export function setup() {
  let response = listTasks(SETUP);
  for (let attempt = 1; response.status !== 200 && attempt < READY_ATTEMPTS; attempt++) {
    sleep(1);
    response = listTasks(SETUP);
  }
  const before = taskIdsOf(response);
  if (before === null) {
    throw new Error(
      `Cannot read the task list through ${WEB_URL}/rpc (HTTP ${response.status}${lastParseError === null ? '' : `, ${lastParseError}`}): is the web production entry (proxy /rpc) running?`,
    );
  }
  if (before.length > DATASET_SIZE) {
    throw new Error(
      `The store holds ${before.length} tasks, more than DATASET_SIZE=${DATASET_SIZE}: the product path cannot shrink the list — run the smoke against an empty store`,
    );
  }

  for (let index = before.length; index < DATASET_SIZE; index++) {
    const created = call('create', SETUP, { title: `k6 seed ${index + 1}` });
    if (created.status !== 200) {
      throw new Error(`Cannot seed the dataset: create answered HTTP ${created.status}`);
    }
  }

  const seeded = taskIdsOf(listTasks(SETUP));
  if (seeded === null || seeded.length !== DATASET_SIZE) {
    throw new Error(
      `The dataset is not fixed: expected ${DATASET_SIZE} tasks, got ${seeded === null ? 'an unreadable list' : seeded.length}`,
    );
  }
  console.log(
    `dataset: ${DATASET_SIZE} tasks before the measurement (the store held ${before.length})`,
  );
  return seeded;
}

export default function (taskIds) {
  const list = listTasks(RPC_LIST);
  const ids = taskIdsOf(list);
  // 200 с чужим набором — невалидный замер; порог требует ровно ноль таких.
  datasetMismatch.add(list.status === 200 && (ids === null || ids.length !== DATASET_SIZE));
  check(list, { 'list: 200': (r) => r.status === 200 });

  const id = taskIds[(__VU + __ITER) % taskIds.length];
  const toggled = call('toggle', RPC_TOGGLE, { id });
  check(toggled, { 'toggle: 200': (r) => r.status === 200 });

  // Диагностика без бюджета: тот же список напрямую из API (OpenAPI-обработчик).
  http.get(`${API_URL}/api/tasks`, { tags: { name: API_DIRECT_LIST } });
}

export function teardown() {
  const after = taskIdsOf(listTasks(SETUP));
  console.log(
    `dataset: ${after === null ? 'an unreadable list' : `${after.length} tasks`} after the measurement`,
  );
}
