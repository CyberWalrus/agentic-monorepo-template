# Образ локального визуального прогона (b3.3): зависимости предустановлены,
# слой установки привязан к локфайлу — манифесты копируются до всякого другого
# ввода, исходников в образе нет: рабочее дерево кладёт в контейнер
# tools/visual.sh при каждом запуске. Контекст сборки — временный каталог одних
# манифестов (его собирает visual.sh), поэтому кэш слоёв зависит только от них:
# смена кода образ не перестраивает, смена локфайла — да.
# База и архитектура — как в CI job visual (ci.yml): mcr playwright noble на
# linux/amd64 (architecture.md, «Визуальные тесты») — истина рендеринга одна,
# базлайны создаёт CI (b3.1, ADR 0015), локальный прогон остаётся предпросмотром.
ARG PLAYWRIGHT_VERSION
FROM mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble

# pnpm той же версии, что packageManager (в CI её ставит pnpm/action-setup).
ARG PNPM_VERSION
RUN npm install -g pnpm@${PNPM_VERSION} --silent >/dev/null 2>&1

WORKDIR /work
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY e2e/package.json e2e/
COPY packages/contracts/package.json packages/contracts/
COPY packages/ui/package.json packages/ui/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/

# prepare (lefthook install) здесь не срабатывает: .git в контексте нет —
# как и в прежнем потоке visual.sh, распаковывавшем репозиторий без .git.
# Store внутри слоя (не cache-mount): node_modules держат жёсткие ссылки на
# него, образ должен быть самодостаточным.
RUN pnpm install --frozen-lockfile --reporter=silent
