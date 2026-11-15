import { oc } from '@orpc/contract';
import * as z from 'zod';

const PublicAccessPolicySchema = z.strictObject({ type: z.literal('public') });
const OwnerAccessPolicySchema = z.strictObject({ type: z.literal('owner') });
const AdminAccessPolicySchema = z.strictObject({ type: z.literal('admin') });

/**
 * Политика доступа процедуры: кто должен иметь возможность её вызвать.
 * Это декларация намерения, а не защита: исполнение появится с мидлварью
 * авторизации (задача C2.2), сейчас политики никем не проверяются.
 * Набор типов растёт аддитивно (ADR 0011): новый вариант или параметр —
 * правка этих схем; лишний ключ в meta отклоняется, а не стирается.
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
 */
export const ocAccess = oc.$meta<{ access?: AccessPolicy }>({});
