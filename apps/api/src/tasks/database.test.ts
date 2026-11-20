import { describe, expect, it } from 'vitest';

import { TASK_POOL_OPTIONS } from './database.ts';

describe('TASK_POOL_OPTIONS', () => {
  // Значения закреплены как контракт (ср. ключ advisory-лока в database.ts):
  // каждый таймаут закрывает свой класс зависания (комментарий в database.ts),
  // рост значения — осознанная правка этого теста, а не случайный дрейф.
  it('bounds every way a connection can hang: pool wait, statement, idle', () => {
    expect(TASK_POOL_OPTIONS).toEqual({
      max: 10,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
      statement_timeout: 15_000,
    });
  });
});
