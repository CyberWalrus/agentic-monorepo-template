/**
 * PostToolUse(Edit|Write|MultiEdit) — точка входа агента Claude Code. Логики
 * нет: формат + type-aware линт — CLI в tools/hooks/lint-changed-file.ts (C10.1).
 */
await import('../../tools/hooks/lint-changed-file.ts');
