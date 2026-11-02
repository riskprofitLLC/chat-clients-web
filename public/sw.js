// Service worker: офлайн-шелл + показ уведомлений о новых сообщениях.
//
// Чего здесь принципиально нет: WebRTC в service worker поднять нельзя,
// поэтому входящий звонок приходит уведомлением, а ответ — после открытия
// вкладки. Полноценного фонового приёма, как foreground-сервис в Android,
// у web-платформы нет.

const CACHE = 'chat-shell-v3'
const SHELL = ['./', './index.html', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png']

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
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

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  // запросы к релею и любые чужие домены не кэшируем: очередь сообщений
  // и медиа не должны попадать в кэш браузера
  if (url.origin !== self.location.origin || url.pathname.includes('/v1/')) return

  // навигация: сеть, при офлайне — шелл из кэша
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => caches.match('./index.html').then((hit) => hit ?? Response.error())))
    return
  }
  // статика: сначала кэш, потом сеть с докладкой в кэш
  event.respondWith(
    caches.match(request).then((hit) => {
      if (hit) return hit
      return fetch(request)
        .then((response) => {
          if (response.ok && response.type === 'basic') {
            const copy = response.clone()
            void caches.open(CACHE).then((cache) => cache.put(request, copy))
          }
          return response
        })
        .catch(() => Response.error())
    }),
  )
})

// пуш от сервера: контента в нём нет, только wake-сигнал (сервер не видит
// plaintext) — показываем нейтральное уведомление и ждём открытия вкладки
self.addEventListener('push', (event) => {
  let title = 'Новое сообщение'
  let body = 'Откройте приложение, чтобы прочитать'
  try {
    const data = event.data ? event.data.json() : null
    if (data && typeof data === 'object') {
      if (typeof data.title === 'string') title = data.title
      if (typeof data.body === 'string') body = data.body
    }
  } catch {
    // тело пуша необязательно
  }
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag: 'chat-message',
      icon: './icons/icon-192.png',
      badge: './icons/icon-192.png',
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
