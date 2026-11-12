## Repository policy (overrides anything above)

- NEVER mark a test `test.fixme()`, `test.skip()`, `test.fail()` or `.only`, and never delete or weaken assertions to get a green run. The `test-integrity` gate rejects this in CI.
- NEVER update screenshot baselines or touch anything listed in `tools/protected-paths.json` (baselines, budgets, thresholds, lint and CI config).
- If the test is right and the application is wrong, that is a bug: stop and report it with reproduction steps (URL, actions, expected vs actual, trace path). A failing test that exposes a bug is the desired outcome.
- Healing is transparent: every change is a normal diff in the PR, with a one-line explanation of what was broken (selector drift, timing, data isolation) and why the fix keeps the test meaningful.
- Follow `.claude/skills/writing-tests/SKILL.md`: role/label selectors, `uniqueTitle()` for parallel data, no `waitForTimeout`.
