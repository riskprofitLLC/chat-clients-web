import { defineConfig } from 'vitest/config'

// base './' — сборка кладётся в подкаталог /web/ за тем же Caddy,
// что раздаёт сайт-визитку; абсолютные пути сломали бы раздачу
// порт локального релея для dev-прокси; задаётся CHAT_RELAY_PORT,
// чтобы не конфликтовать с уже занятыми портами на машине разработчика
// dev-релей: через прокси клиент всегда ходит на свой origin (':5173/v1'),
// поэтому CSP connect-src 'self' его не блокирует. Явный CHAT_RELAY_URL
// перенаправляет на внешний адрес — только для отладки.
const relayPort = (globalThis as { process?: { env?: Record<string, string> } }).process?.env?.CHAT_RELAY_PORT ?? '8080'
const relayUrl =
  (globalThis as { process?: { env?: Record<string, string> } }).process?.env?.CHAT_RELAY_URL ??
  `http://127.0.0.1:${relayPort}`
// target прокси: свой origin не нужен, ходим через /v1
const proxyTarget = new URL(relayUrl).origin === 'http://localhost:5173' ? `http://127.0.0.1:${relayPort}` : relayUrl

export default defineConfig({
  // прод-деплой отдаёт клиента как /web/ за тем же Caddy, что и релей:
  // base './' держит все пути относительными, сборка не привязана к домену
  base: './',
  build: {
    outDir: 'dist',
    target: 'es2022',
    sourcemap: true,
  },
  server: {
    // локальная связка: dev-сервер проксирует /v1 на релей,
    // чтобы не упираться в CORS при разработке.
    // secure:false — релей на http://127.0.0.1, иначе проксирование падает.
    proxy: {
      '/v1': {
        // адрес релея для локальной связки; прод-сборке не нужен
        target: proxyTarget,
        changeOrigin: true,
        secure: false,
        ws: true,
      },
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
})
