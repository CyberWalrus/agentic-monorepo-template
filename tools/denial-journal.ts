/**
 * Журнал отказов гейтов (C9.3) — публичный фасад. Реализация живёт в
 * tools/hooks/lib.ts: хуки обязаны быть самодостаточными (синтетические деревья
 * тестов копируют только tools/hooks/, внешний импорт ронял 35 тестов).
 */
export { appendDenial, journalPath, readDenials } from './hooks/lib.ts';
export type { DenialRecord } from './hooks/lib.ts';
