# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: agents/api-logs-canary.spec.ts >> harness canary: a deliberately failing scenario gets its API logs attached
- Location: agents/api-logs-canary.spec.ts:16:1

# Error details

```
Error: Canary fails on purpose (C4): the report of this scenario must contain the api-logs attachment
```

# Page snapshot

```yaml
- main [ref=e2]:
    - generic [ref=e3]:
        - heading "Tasks" [level=1] [ref=e4]
        - paragraph [ref=e5]: 3 of 4 remaining
    - generic [ref=e6]:
        - generic [ref=e7]:
            - generic [ref=e8]: New task
            - textbox "New task" [ref=e9]:
                - /placeholder: What needs to be done?
        - button "Add task" [ref=e10] [cursor=pointer]
    - list "Tasks" [ref=e11]:
        - listitem [ref=e12]:
            - checkbox "Rendered on the server 3b850dd9650ede54c8ce-dfff8ad779edccdb2bf6-0-0-0" [ref=e13]
            - generic [ref=e14]: Rendered on the server 3b850dd9650ede54c8ce-dfff8ad779edccdb2bf6-0-0-0
        - listitem [ref=e15]:
            - checkbox "A11y probe d17318e251674470bbe4-0f5366ebf21566468a10-0-0-0" [ref=e16]
            - generic [ref=e17]: A11y probe d17318e251674470bbe4-0f5366ebf21566468a10-0-0-0
        - listitem [ref=e18]:
            - checkbox "Buy milk 3b850dd9650ede54c8ce-e7eb9170b77ff4abc0ca-0-0-0" [ref=e19]
            - generic [ref=e20]: Buy milk 3b850dd9650ede54c8ce-e7eb9170b77ff4abc0ca-0-0-0
        - listitem [ref=e21]:
            - checkbox "Toggle me 3b850dd9650ede54c8ce-4620ac613e7b58c13295-0-0-0" [checked] [ref=e22]
            - generic [ref=e23]: Toggle me 3b850dd9650ede54c8ce-4620ac613e7b58c13295-0-0-0
```

# Test source

```ts
  1  | import { randomUUID } from 'node:crypto';
  2  | import { mkdirSync, writeFileSync } from 'node:fs';
  3  | import { resolve } from 'node:path';
  4  |
  5  | import { test } from '../fixtures.ts';
  6  |
  7  | const e2eRoot = resolve(import.meta.dirname, '..');
  8  |
  9  | /**
  10 |  * Канарейка отчётного контура (C4): намеренно падающий сценарий, чей отчёт
  11 |  * обязан содержать вложение с логами API. Проект `agents` не запускается
  12 |  * гейтами (default: false в конфиге), поэтому спек живёт здесь и запускается
  13 |  * мета-тестом e2e/features/e2e-reporting/api-logs.spec.ts через CLI — сам
  14 |  * прогон функционального проекта остаётся зелёным.
  15 |  */
  16 | test('harness canary: a deliberately failing scenario gets its API logs attached', async ({
  17 |   page,
  18 | }) => {
  19 |   // Маркерный запрос: идентификатор известен заранее, запись с ним обязана
  20 |   // дойти до вложения канарейки и только до него (соседние id — мимо).
  21 |   const markerId = `canary-${randomUUID()}`;
  22 |   await page.goto('/');
  23 |   await page.evaluate(async (requestId) => {
  24 |     await fetch('/rpc/__canary__', {
  25 |       method: 'POST',
  26 |       headers: { 'content-type': 'application/json', 'x-request-id': requestId },
  27 |       body: '{}',
  28 |     }).catch(() => undefined);
  29 |   }, markerId);
  30 |   mkdirSync(resolve(e2eRoot, 'reports'), { recursive: true });
  31 |   writeFileSync(resolve(e2eRoot, 'reports', 'canary-marker-id'), `${markerId}\n`);
  32 |
> 33 |   throw new Error(
     |         ^ Error: Canary fails on purpose (C4): the report of this scenario must contain the api-logs attachment
  34 |     'Canary fails on purpose (C4): the report of this scenario must contain the api-logs attachment',
  35 |   );
  36 | });
  37 |
```
