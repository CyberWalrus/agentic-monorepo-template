/**
 * PreToolUse(Bash) — точка входа. Вся логика и импорты — в guard-bash.main.ts:
 * сбой при загрузке модулей (битый конфиг, битый вход) должен закрыть хук (exit 2),
 * а не выйти с кодом 1, который Claude Code считает неблокирующим (З4).
 */
try {
  await import('./guard-bash.main.ts');
} catch (error) {
  console.error(
    `guard-bash could not verify the command (${error instanceof Error ? error.message : String(error)}). ` +
      'The guard must not fail open: the command is blocked. Rephrase it or ask the user.',
  );
  process.exit(2);
}
