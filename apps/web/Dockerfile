# Production-образ web (ADR 0012). Multi-stage: сборка Vite и dev-зависимости
# остаются в builder; рантайм — prod-зависимости (`pnpm deploy --prod`),
# клиентская и серверная сборки (dist/) и entry server.ts.
# Локальная сборка и проверка — до задачи C3.3 (CI-сборка образов).

# Тег закреплён на минор (26.13 = нижняя граница engines), alpine-патчи плывут.
FROM node:26.13.0-alpine AS builder
# corepack в Node >=25 не входит: pnpm ставим глобально; версия — дословно
# packageManager из package.json. Bump pnpm требует синхронной правки здесь.
RUN npm install -g pnpm@12.21.0
WORKDIR /repo

# Сначала манифесты workspace: слой установки зависимостей переживает правки
# исходников. set-перечисление — все члены workspace, lockfile целостен.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY e2e/package.json e2e/
COPY packages/contracts/package.json packages/contracts/
COPY packages/ui/package.json packages/ui/
RUN pnpm install --frozen-lockfile

# Сборка: vite build читает TS-исходники contracts/ui, пишет apps/web/dist.
# API_URL при сборке не нужен: у команды build прокси пуст (ADR 0005).
# tsconfig.base.json нужен после install: apps/web/tsconfig.json extends его,
# и vite резолвит базу при сборке (копия после install — кэш слоя цел).
COPY tsconfig.base.json ./
COPY apps/web apps/web
COPY packages packages
RUN pnpm --filter @repo/web build

# Deploy: prod-зависимости web и workspace-пакеты в одном каталоге.
# files в package.json пакует dist, server.ts и серверные модули из src.
RUN pnpm deploy --filter @repo/web --prod /app

FROM node:26.13.0-alpine AS runtime
# Порт и хост — ENV образа: контейнер обязан слушать 0.0.0.0 и объявленный
# порт; переопределяются -e при запуске. API_URL обязателен при старте entry:
# без него процесс падает (fail-closed, env.ts).
ENV NODE_ENV=production PORT=3000 HOST=0.0.0.0
WORKDIR /app
COPY --from=builder --chown=node:node /app ./
USER node
EXPOSE 3000
# Readiness: /healthz отвечает 200, когда процесс слушает заявленный порт
# (имя /health занято API; через web-origin оно запрещено e2e, ADR 0012).
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/healthz" || exit 1
CMD ["node", "server.ts"]
