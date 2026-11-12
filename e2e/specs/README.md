# Test plans

Markdown-планы тестов фич. Их пишет `playwright-test-planner` (или человек), по ним `playwright-test-generator` генерирует тесты в `e2e/features/<feature>/`.

Один файл на фичу: `<feature>.md`. В плане перечислены критерии приёмки, сценарии (шаги и ожидания) и seed (`e2e/agents/seed.spec.ts`).
