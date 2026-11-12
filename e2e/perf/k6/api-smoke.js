// k6 smoke для API: p95 и доля ошибок против /perf-budgets.json.
// Запуск: k6 run e2e/perf/k6/api-smoke.js (API должен слушать на API_URL).
import http from 'k6/http';
import { check } from 'k6';

const budgets = JSON.parse(open('../../../perf-budgets.json'));
const API_URL = __ENV.API_URL || 'http://localhost:3001';

export const options = {
  vus: 5,
  duration: '20s',
  thresholds: {
    http_req_duration: [`p(95)<${budgets.api.maxP95Ms}`],
    http_req_failed: [`rate<${budgets.api.maxErrorRate}`],
  },
};

export default function () {
  const created = http.post(
    `${API_URL}/api/tasks`,
    JSON.stringify({ title: `k6 ${__VU}-${__ITER}` }),
    {
      headers: { 'content-type': 'application/json' },
    },
  );
  check(created, { 'create: 200': (r) => r.status === 200 });

  const list = http.get(`${API_URL}/api/tasks`);
  check(list, { 'list: 200': (r) => r.status === 200 });
}
