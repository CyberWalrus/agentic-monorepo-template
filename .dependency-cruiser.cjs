/**
 * Архитектурные границы. Защищённый файл: правила меняет человек.
 * Запуск: pnpm boundaries
 *
 * @type {import('dependency-cruiser').IConfiguration}
 */
module.exports = {
  forbidden: [
    {
      name: 'product-not-to-tools',
      severity: 'error',
      comment:
        'Продуктовый код не импортирует гейты и обвязку (tools/): порты и окружение приходят через запуск (ADR 0005, З9). tools/ — потребитель приложений, не зависимость. Скоуп — весь пакет, не только src/: конфиги (vite.config.ts) — место, где порты запекаются при сборке.',
      from: { path: '^(apps|packages)/[^/]+/' },
      to: { path: '^tools/' },
    },
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Циклы делают модули неотделимыми и ломают tree-shaking.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'packages-not-to-apps',
      severity: 'error',
      comment: 'Пакеты переиспользуемы и не знают о приложениях.',
      from: { path: '^packages/' },
      to: { path: '^apps/' },
    },
    {
      name: 'no-app-to-app',
      severity: 'error',
      comment:
        'Приложения общаются только через контракты (@repo/contracts), не через код друг друга.',
      from: { path: '^apps/([^/]+)/' },
      to: { path: '^apps/', pathNot: '^apps/$1/' },
    },
    {
      name: 'e2e-black-box',
      severity: 'error',
      comment: 'E2E проверяет систему снаружи и не импортирует код приложений и пакетов.',
      from: { path: '^e2e/' },
      to: { path: '^(apps|packages)/' },
    },
    {
      name: 'ui-is-presentational',
      severity: 'error',
      comment: '@repo/ui не знает о домене и транспорте: ни контрактов, ни API-клиентов.',
      from: { path: '^packages/ui/' },
      to: { path: '^packages/contracts/|node_modules/(@orpc|@tanstack|hono)' },
    },
    {
      name: 'contracts-are-pure',
      severity: 'error',
      comment: 'Контракты — только схемы и описания процедур: без UI, HTTP-серверов и Node API.',
      from: { path: '^packages/contracts/src/' },
      to: {
        dependencyTypes: ['npm', 'core'],
        pathNot: 'node_modules/(zod|@orpc/contract)/',
      },
    },
    {
      name: 'no-cross-feature-imports',
      severity: 'error',
      comment:
        'Фичи независимы, чтобы десятки людей и агентов могли работать параллельно. Общий код — в src/lib или packages/.',
      from: { path: '^apps/web/src/features/([^/]+)/' },
      to: { path: '^apps/web/src/features/', pathNot: '^apps/web/src/features/$1/' },
    },
    {
      name: 'api-domain-independent-of-transport',
      severity: 'error',
      comment:
        'Доменные модули API не зависят от HTTP-слоя (app.ts, router.ts, server.ts) и от пограничных адаптеров поверх него (authorization.ts, observability.ts, server-config.ts) — иначе домен протягивает транспорт мимо гейта (e15).',
      from: { path: '^apps/api/src/[^/]+/' },
      to: {
        path: '^apps/api/src/(app|router|server|authorization|observability|server-config)\\.ts$',
      },
    },
    {
      name: 'web-lib-not-to-features',
      severity: 'error',
      comment:
        'Общий слой web — дно зависимостей: src/lib не импортирует фичи (обратное правило — no-cross-feature-imports; e15).',
      from: { path: '^apps/web/src/lib/' },
      to: { path: '^apps/web/src/features/' },
    },
    {
      name: 'no-deep-package-imports',
      severity: 'error',
      comment:
        'Импортируй пакет только через его публичный entry (exports), не через внутренние пути.',
      from: {},
      to: { path: 'node_modules/@repo/[^/]+/.+' },
    },
    {
      name: 'not-to-dev-dep',
      severity: 'error',
      comment:
        'Production-код не должен зависеть от devDependencies — включая production-entry apps/*/server.ts в корне пакета (слот TanStack, ADR 0012; pnpm deploy --prod прунит devDeps; e15).',
      from: {
        path: '^(apps|packages)/[^/]+/(src/|server\\.ts$)',
        pathNot: '\\.(test|visual\\.test)\\.tsx?$',
      },
      to: { dependencyTypes: ['npm-dev'], dependencyTypesNot: ['type-only'] },
    },
    {
      name: 'not-to-unresolvable',
      severity: 'error',
      from: {},
      to: { couldNotResolve: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: {
      // playwright-report: html-отчёт Playwright — артефакт с чужими бандлами (локальные прогоны).
      path: '^e2e/perf/k6/|(^|/)(\\.playwright-cli|dist|\\.output|coverage|reports|test-results|playwright-report)/|routeTree\\.gen\\.ts$',
    },
    tsPreCompilationDeps: true,
    combinedDependencies: false,
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      mainFields: ['module', 'main', 'types', 'typings'],
      extensions: ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json'],
    },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
