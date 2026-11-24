import { oc } from '@orpc/contract';
import * as z from 'zod';

import { accessErrors, commonErrors } from './errors.ts';

const PublicAccessPolicySchema = z.strictObject({ type: z.literal('public') });
const OwnerAccessPolicySchema = z.strictObject({ type: z.literal('owner') });
const AdminAccessPolicySchema = z.strictObject({ type: z.literal('admin') });

/**
 * Политика доступа процедуры: кто должен иметь возможность её вызвать.
 * Исполняет мидлварь авторизации на сервере (apps/api, C2.2): без актора
 * или с чужим актором процедура с политикой «owner» получает отказ до
 * доменной логики. Набор типов растёт аддитивно (ADR 0011): новый вариант
 * или параметр — правка этих схем; лишний ключ в meta отклоняется, а не
 * стирается.
 */
export const AccessPolicySchema = z.discriminatedUnion('type', [
  PublicAccessPolicySchema,
  OwnerAccessPolicySchema,
  AdminAccessPolicySchema,
]);

type AccessPolicy = z.infer<typeof AccessPolicySchema>;

/**
 * Основа контракта с типизированной политикой доступа: каждая процедура
 * объявляет `.meta({ access })`, присутствие проверяет access-policy.test.ts.
 * Общие ошибки таксономии (C4.1) наследуются из каталога errors.ts —
 * единственного источника текстов: INTERNAL_SERVER_ERROR бросает механизм
 * oRPC для непойманного.
 */
const ocProcedure = oc.$meta<{ access?: AccessPolicy }>({});

/**
 * Public-процедуры: проверку доступа мидлварь не выполняет, FORBIDDEN бросать
 * некому, поэтому контракт его не объявляет — описывается только достижимое
 * (e57, ADR 0024). Обработчик public-процедуры не бросит FORBIDDEN через
 * `errors`: конструктор процедуры строится из объявленных ей ошибок.
 */
export const ocPublic = ocProcedure.errors(commonErrors);

/**
 * Процедуры с проверкой доступа (owner, admin): мидлварь авторизации
 * отказывает FORBIDDEN до доменной логики, поэтому ошибка объявлена и
 * типизирована — обработчик бросает её через `errors.FORBIDDEN()`.
 * Строитель выбирается по политике процедуры: тест errors.test.ts красит
 * public-процедуру с FORBIDDEN и процедуру с проверкой доступа без него.
 */
export const ocAccess = ocProcedure.errors(accessErrors);
