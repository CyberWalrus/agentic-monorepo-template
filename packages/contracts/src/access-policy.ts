import { oc } from '@orpc/contract';
import * as z from 'zod';

const PublicAccessPolicySchema = z.object({ type: z.literal('public') });
const OwnerAccessPolicySchema = z.object({ type: z.literal('owner') });
const AdminAccessPolicySchema = z.object({ type: z.literal('admin') });

/**
 * Политика доступа процедуры: кто может её вызвать. Набор типов растёт
 * аддитивно (ADR 0011): параметры вариантов добавляются без ломающих изменений.
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
