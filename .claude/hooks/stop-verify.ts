/**
 * Stop — точка входа stop-verify. Логика — в stop-verify.main.ts: сбой при
 * загрузке модулей (битый вход, битый state) должен закрыть хук (exit 2),
 * а не выйти с кодом 1, который Claude Code считает неблокирующим (З4).
 */
try {
  await import('./stop-verify.main.ts');
} catch (error) {
  console.error(
    `stop-verify could not check the result (${error instanceof Error ? error.message : String(error)}). ` +
      'The check is failed-closed: run `pnpm verify --full` manually before finishing.',
  );
  process.exit(2);
}
