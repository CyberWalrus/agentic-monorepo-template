/**
 * PostToolUse(Bash) и Stop — точка входа проверки по результату (roadmap A2 пункт 1).
 * Логика — CLI в tools/hooks/protect-result.ts (C10.1): сбой при загрузке модулей (битый конфиг, битый
 * вход) должен закрыть хук (exit 2: stderr виден агенту, Stop не даёт завершиться),
 * а не выйти с кодом 1, который Claude Code считает неблокирующим (З4).
 */
try {
  await import('../../tools/hooks/protect-result.ts');
} catch (error) {
  console.error(
    `protect-result could not check the result (${error instanceof Error ? error.message : String(error)}). ` +
      'The check is failed-closed: protected files may have been changed without detection. ' +
      'Re-run the check or ask the user.',
  );
  process.exit(2);
}
