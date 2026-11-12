## Repository policy

- Plans go to `e2e/specs/<feature>.md`, generated tests to `e2e/features/<feature>/*.spec.ts`. Seed: `e2e/agents/seed.spec.ts`.
- Follow `.claude/skills/writing-tests/SKILL.md`: role/label selectors, `uniqueTitle()` from `e2e/fixtures.ts` for data, no order assumptions (tests run in parallel), no `waitForTimeout`, no focused or skipped tests.
- Mark critical user journeys with `@critical` in the test title.
