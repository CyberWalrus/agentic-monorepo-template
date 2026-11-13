import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

/**
 * Прокси `/rpc` на API (ADR 0005): браузер ходит в свой origin, сборка не
 * зависит от адреса API. Цель читается при старте процесса dev/preview, не при
 * сборке: у команды `build` прокси пуст, поэтому два прогона сборки с разными
 * `API_URL` дают одинаковый `dist` (скан запечённых адресов — в шаге `bundle`).
 * Проверено эмпирически (2026-11-13): и preview, и dev прокси перехватывает
 * `/rpc` раньше SSR-обработчика TanStack Start. Проксируется только `/rpc`:
 * `/health` и `/__test__/*` через web недоступны (e2e-тест закрепляет),
 * фикстуры и k6 ходят в API напрямую.
 */
export default defineConfig(({ command }) => {
  // Проверка в хуках сервера, а не в конфиге: конфиг загружают и knip, и сборка —
  // им адрес не нужен; сервер без API_URL обязан не стартовать вовсе.
  const rpcProxy =
    command === 'build'
      ? {}
      : { '/rpc': { target: process.env['API_URL'] ?? '', changeOrigin: false } };
  return {
    server: { port: 3000, strictPort: true, proxy: rpcProxy },
    preview: { port: 3000, strictPort: true, proxy: rpcProxy },
    // Плагин React должен идти после плагина Start.
    plugins: [tanstackStart(), react(), requireApiUrlForServe()],
  };
});

/** Сервер без адреса API не стартует: пустая цель прокси означает молча сломанный /rpc. */
function assertApiUrl(): void {
  if (!process.env['API_URL']) {
    throw new Error(
      'API_URL is empty: export it (e.g. `export API_URL=http://localhost:3001`, fixed ports until A5 PR-3) or run through `pnpm dev` / the e2e webServer',
    );
  }
}

function requireApiUrlForServe(): Plugin {
  return {
    name: 'require-api-url',
    configureServer: assertApiUrl,
    configurePreviewServer: assertApiUrl,
  };
}
