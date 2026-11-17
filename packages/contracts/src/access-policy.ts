import { oc } from '@orpc/contract';
import * as z from 'zod';

import { commonErrors } from './errors.ts';

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
 * Строитель контракта с типизированной политикой доступа: каждая процедура
 * объявляет `.meta({ access })`, присутствие проверяет access-policy.test.ts.
 * Общие ошибки таксономии (C4.1) наследуются всеми процедурами из каталога
 * errors.ts — единственного источника текстов: FORBIDDEN бросает мидлварь
 * авторизации, INTERNAL_SERVER_ERROR — механизм oRPC для непойманного.
 */
export const ocAccess = oc.$meta<{ access?: AccessPolicy }>({}).errors(commonErrors);
