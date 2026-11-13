import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

/**
 * Прокси `/rpc` на API (ADR 0005): браузер ходит в свой origin, сборка не
 * зависит от адреса API. Адрес и порт приходят при старте процесса dev/preview
 * (env `API_URL` и флаг `--port` от `pnpm dev`/e2e-конфига), не при сборке: у
 * команды `build` прокси пуст, поэтому два прогона сборки с разными `API_URL`
 * дают одинаковый `dist` (скан запечённых адресов — в шаге `bundle`). Проверено
 * эмпирически (2026-11-13): и preview, и dev прокси перехватывает `/rpc`
 * раньше SSR-обработчика TanStack Start. Проксируется только `/rpc`:
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
  // Порт — от --port (pnpm dev / e2e-конфиг): фиксированных портов нет (З9).
  // host фиксирован: URL гейтов — 127.0.0.1, localhost двусмысленен (vite может
  // слушаться только на ::1, а poll пойдёт на IPv4).
  return {
    server: { host: '127.0.0.1', strictPort: true, proxy: rpcProxy },
    preview: { host: '127.0.0.1', strictPort: true, proxy: rpcProxy },
    // Плагин React должен идти после плагина Start.
    plugins: [tanstackStart(), react(), requireApiUrlForServe()],
  };
});

/** Сервер без адреса API не стартует: пустая цель прокси означает молча сломанный /rpc. */
function assertApiUrl(): void {
  if (!process.env['API_URL']) {
    throw new Error(
      'API_URL is empty: export it (see reports/ports.json after `pnpm dev`) or run through `pnpm dev` / the e2e webServer',
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
