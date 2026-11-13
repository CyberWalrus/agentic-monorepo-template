/**
 * PostToolUse(Bash) и Stop — точка входа проверки по результату (roadmap A2 пункт 1).
 * Логика — в protect-result.main.ts: сбой при загрузке модулей (битый конфиг, битый
 * вход) должен закрыть хук (exit 2: stderr виден агенту, Stop не даёт завершиться),
 * а не выйти с кодом 1, который Claude Code считает неблокирующим (З4).
 */
try {
  await import('./protect-result.main.ts');
} catch (error) {
  console.error(
    `protect-result could not check the result (${error instanceof Error ? error.message : String(error)}). ` +
      'The check is failed-closed: protected files may have been changed without detection. ' +
      'Re-run the check or ask the user.',
  );
  process.exit(2);
}
