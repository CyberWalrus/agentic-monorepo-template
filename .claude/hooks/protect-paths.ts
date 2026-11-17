/**
 * PreToolUse(Edit|Write|MultiEdit|NotebookEdit) — точка входа. Логика — в protect-paths.ts (tools/hooks, C10.1):
 * сбой при загрузке модулей (битый конфиг, битый вход) должен закрыть хук (exit 2),
 * а не выйти с кодом 1, который Claude Code считает неблокирующим (З4).
 */
try {
  await import('../../tools/hooks/protect-paths.ts');
} catch (error) {
  console.error(
    `protect-paths could not verify the write (${error instanceof Error ? error.message : String(error)}). ` +
      'The guard must not fail open: the edit is blocked. Ask the user if it is legitimate.',
  );
  process.exit(2);
}
