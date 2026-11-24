import { isContractProcedure } from '@orpc/contract';
import { describe, expect, it } from 'vitest';

import { AccessPolicySchema } from './access-policy.ts';
import { contract } from './index.ts';
import { commonErrors, forbiddenError, notFoundError } from './errors.ts';

/** Каталог целиком: каждый объявленный где-то код обязан иметь его текст. */
const catalogMessages: Record<string, string> = {
  ...Object.fromEntries(
    Object.entries(commonErrors).map(([code, item]) => [code, item.message ?? '']),
  ),
  FORBIDDEN: forbiddenError.message,
  NOT_FOUND: notFoundError.message,
};

interface ProcedureErrors {
  path: string;
  errors: Record<string, { message?: string }>;
  meta: Record<string, unknown>;
}

function collectProcedures(node: unknown, prefix = ''): ProcedureErrors[] {
  if (typeof node !== 'object' || node === null) {
    return [];
  }

  const procedures: ProcedureErrors[] = [];
  for (const [key, value] of Object.entries(node)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isContractProcedure(value)) {
      procedures.push({
        path,
        errors: value['~orpc'].errorMap ?? {},
        meta: value['~orpc'].meta ?? {},
      });
    } else {
      procedures.push(...collectProcedures(value, path));
    }
  }
  return procedures;
}

/** Процедура с проверкой доступа: политика не public (или её нет — deny-by-default). */
function checksAccess({ meta }: ProcedureErrors): boolean {
  const policy = AccessPolicySchema.safeParse(meta['access']);
  return !policy.success || policy.data.type !== 'public';
}

function declaresForbidden({ errors }: ProcedureErrors): boolean {
  return errors['FORBIDDEN'] !== undefined;
}

describe('error catalog is the single source of taxonomy messages', () => {
  const procedures = collectProcedures(contract);

  it('every declared error message comes from the catalog', () => {
    expect(procedures.length).toBeGreaterThan(0);
    const violations: string[] = [];
    for (const { path, errors } of procedures) {
      for (const [code, item] of Object.entries(errors)) {
        const expected = catalogMessages[code];
        if (expected === undefined) {
          violations.push(`${path}: ${code} is declared outside the catalog`);
        } else if (item.message !== expected) {
          violations.push(`${path}: ${code} message is not the catalog one`);
        }
      }
    }
    expect(violations, 'procedures with off-catalog error declarations').toEqual([]);
  });

  it('NOT_FOUND is declared only where it is possible at all', () => {
    const withNotFound = procedures
      .filter((p) => p.errors['NOT_FOUND'] !== undefined)
      .map((p) => p.path);

    expect(withNotFound).toContain('tasks.toggle');
    // remove без NOT_FOUND: отказ fail-closed без оракула существования (C2.3)
    expect(withNotFound).not.toContain('tasks.remove');
  });

  // e57: контракт описывает только достижимое. FORBIDDEN бросает проверка
  // доступа (мидлварь авторизации, роутер remove): public-процедуре обещать
  // его нельзя — бросить некому; процедуре с проверкой — обязана.
  it('FORBIDDEN is declared exactly by procedures that check access', () => {
    const mismatched = procedures
      .filter((p) => checksAccess(p) !== declaresForbidden(p))
      .map((p) =>
        checksAccess(p)
          ? `${p.path}: checks access, FORBIDDEN is not declared`
          : `${p.path}: public procedure declares FORBIDDEN it can never throw`,
      );

    expect(mismatched, 'FORBIDDEN declared outside procedures that check access').toEqual([]);

    // Оба класса в контракте tasks есть — иначе проверка выше прошла бы
    // вхолостую. Списки сверяются в пределах домена tasks: другие домены (фича,
    // сгенерированная pnpm gen feature) добавляют процедуры любого класса.
    const tasksProcedures = procedures.filter((p) => p.path.startsWith('tasks.'));
    expect(tasksProcedures.filter(checksAccess).map((p) => p.path)).toEqual(['tasks.remove']);
    expect(tasksProcedures.filter((p) => !checksAccess(p)).map((p) => p.path)).toEqual([
      'tasks.list',
      'tasks.create',
      'tasks.toggle',
    ]);
  });
});
