# Production-образ api (ADR 0012). Multi-stage: инструменты pnpm и dev-зависимости
# остаются в builder; рантайм — только прод-зависимости (`pnpm deploy --prod`)
# и исходники: Node 26 запускает TS стриппингом типов, сборки нет.
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

# Исходники api и workspace-пакетов до deploy: deploy пакует каталог проекта
# (по files из package.json — src без *.test.ts), а контракт едет в образ
# TS-исходниками (Node 26 стриппингом исполняет их в рантайме). Без копии
# packages в образе нет ни src api, ни исходников контракта.
# После install — кэш слоя зависимостей цел.
COPY apps/api apps/api
COPY packages packages

# Deploy: прод-зависимости api и workspace-пакеты (contracts) в одном каталоге.
# files в package.json пакует src без *.test.ts.
RUN pnpm deploy --filter @repo/api --prod /app

# Node не стриппит типы внутри node_modules (ERR_UNSUPPORTED_NODE_MODULES_TYPE_
# STRIPPING), а deploy кладёт workspace-контракт (TS-исходники) именно туда.
# Воспроизводим раскладку pnpm-workspace: контракт — реальным каталогом вне
# node_modules, node_modules/@repo/contracts — симлинком на него, а его
# прод-зависимости — симлинком в каталог .pnpm-хранилища контракта.
RUN set -eux; cd /app; \
    mkdir -p packages; \
    cp -RL node_modules/.pnpm/@repo+contracts@*/node_modules/@repo/contracts packages/contracts; \
    rm node_modules/@repo/contracts; \
    ln -s ../../packages/contracts node_modules/@repo/contracts; \
    set -- node_modules/.pnpm/@repo+contracts@*/node_modules; \
    ln -s "../../$1" packages/contracts/node_modules

FROM node:26.13.0-alpine AS runtime
# Порт и хост — ENV образа: контейнер обязан слушать 0.0.0.0 и объявленный
# порт; переопределяются -e при запуске (ADR 0012).
# Прод-переменные перечислены явно (e69). NODE_ENV=production не снимать через
# -e: тестовый API открывается только при явном NODE_ENV=development|test, а
# ENABLE_TEST_API=1 вместе с NODE_ENV=production — отказ при старте. Флаги
# тестового API заданы нулями здесь, а не оставлены дефолту кода.
ENV NODE_ENV=production PORT=3000 HOST=0.0.0.0 ENABLE_TEST_API=0 ENABLE_TEST_API_WITH_DATABASE=0
WORKDIR /app
COPY --from=builder --chown=node:node /app ./
# Приложение пишет только в stdout/stderr; домашний каталог node не нужен.
USER node
EXPOSE 3000
# Readiness: /health отвечает 200, когда процесс слушает заявленный порт.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/health" || exit 1
CMD ["node", "src/server.ts"]
