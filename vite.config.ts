import { defineConfig } from 'vitest/config'

// base './' — сборка кладётся в подкаталог /web/ за тем же Caddy,
// что раздаёт сайт-визитку; абсолютные пути сломали бы раздачу
// порт локального релея для dev-прокси; задаётся CHAT_RELAY_PORT,
// чтобы не конфликтовать с уже занятыми портами на машине разработчика
const relayUrl =
  (globalThis as { process?: { env?: Record<string, string> } }).process?.env?.CHAT_RELAY_URL ??
  `http://127.0.0.1:${(globalThis as { process?: { env?: Record<string, string> } }).process?.env?.CHAT_RELAY_PORT ?? '8080'}`

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
    // чтобы не упираться в CORS при разработке
    proxy: {
      '/v1': {
        // адрес релея для локальной связки; прод-сборке не нужен
        target: relayUrl,
        changeOrigin: true,
        ws: true,
      },
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
})
