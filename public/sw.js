// Service worker: офлайн-шелл + показ уведомлений. Версию кэша и список
// хэшированных ассетов подставляет scripts/make-sw.mjs после сборки.
//
// Чего здесь принципиально нет: WebRTC в service worker поднять нельзя,
// поэтому входящий звонок приходит уведомлением, а ответ — после открытия
// вкладки. Полноценного фонового приёма, как foreground-сервис в Android,
// у web-платформы нет.

const CACHE = '__CACHE_VERSION__'
const PRECACHE = __PRECACHE__

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .catch(() => undefined),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  )
})

// новая версия ждёт команды от страницы: «Доступна новая версия — Обновить»
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting()
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  // запросы к релею и любые чужие домены не кэшируем
  if (url.origin !== self.location.origin || url.pathname.includes('/v1/')) return

  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => caches.match('./index.html').then((hit) => hit ?? Response.error())))
    return
  }
  // статика: stale-while-revalidate
  event.respondWith(
    caches.match(request).then((hit) => {
      const network = fetch(request)
        .then((response) => {
          if (response.ok && response.type === 'basic') {
            const copy = response.clone()
            void caches.open(CACHE).then((cache) => cache.put(request, copy))
          }
          return response
        })
        .catch(() => hit ?? Response.error())
      return hit ?? network
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ('focus' in client) return client.focus()
      }
      return self.clients.openWindow('./')
    }),
  )
})
