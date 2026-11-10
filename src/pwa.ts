// PWA: регистрация service worker, баннер установки, уведомления, Web Push.
//
// Потолки платформы, которые здесь видны:
//   • WebRTC нельзя поднять в service worker — push только уведомляет,
//     ответ на звонок возможен лишь после открытия вкладки;
//   • на iOS push работает только для приложения, добавленного на
//     домашний экран (iOS 16.4+), и только после жеста пользователя;
//   • серверная половина web-push (адаптер к push-шлюзу) — отдельная
//     задача на go/; клиентская половина (подписка) реализована.

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

class InstallState {
  private event: BeforeInstallPromptEvent | null = null
  private readonly listeners = new Set<(available: boolean) => void>()

  constructor() {
    window.addEventListener('beforeinstallprompt', (event) => {
      event.preventDefault()
      this.event = event as BeforeInstallPromptEvent
      this.notify()
    })
    window.addEventListener('appinstalled', () => {
      this.event = null
      this.notify()
    })
  }

  get available(): boolean {
    return this.event !== null
  }

  subscribe(listener: (available: boolean) => void): () => void {
    this.listeners.add(listener)
    listener(this.available)
    return () => this.listeners.delete(listener)
  }

  private notify(): void {
    for (const listener of this.listeners) listener(this.available)
  }

  async install(): Promise<boolean> {
    const event = this.event
    if (!event) return false
    await event.prompt()
    const choice = await event.userChoice
    this.event = null
    this.notify()
    return choice.outcome === 'accepted'
  }
}

export const installState = new InstallState()

// приложение считается установленным, если открыто в standalone-режиме
export function isStandalone(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  )
}

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null
  try {
    // путь относительно документа (index.html в корне сборки), а не бандла;
    // updateViaCache:'none' — обновление всегда проверяется по сети
    return await navigator.serviceWorker.register('./sw.js', { scope: './', updateViaCache: 'none' })
  } catch {
    return null
  }
}

// сообщает, когда готова новая версия; cb вызывается один раз на обновление
export function watchForUpdate(registration: ServiceWorkerRegistration, cb: () => void): void {
  if (registration.waiting && navigator.serviceWorker.controller) cb()
  registration.addEventListener('updatefound', () => {
    const installing = registration.installing
    if (!installing) return
    installing.addEventListener('statechange', () => {
      if (installing.state === 'installed' && navigator.serviceWorker.controller) cb()
    })
  })
}

// активирует ожидающий воркер; страница перезагрузится по controllerchange
export function applyUpdate(): void {
  void navigator.serviceWorker?.getRegistration().then((registration) => registration?.waiting?.postMessage('SKIP_WAITING'))
  navigator.serviceWorker?.addEventListener('controllerchange', () => location.reload(), { once: true })
}

export async function requestNotificationPermission(): Promise<boolean> {
  if (!('Notification' in window)) return false
  if (Notification.permission === 'granted') return true
  if (Notification.permission === 'denied') return false
  return (await Notification.requestPermission()) === 'granted'
}

// локальное уведомление о новом сообщении, когда вкладка не на экране:
// заменяет пуш там, где он недоступен (Safari без установки на домашний экран)
export async function notifyMessage(title: string, body: string): Promise<void> {
  if (document.visibilityState === 'visible') return
  if (!('Notification' in window)) return
  if (Notification.permission !== 'granted') return
  const registration = await navigator.serviceWorker?.ready
  if (registration) {
    await registration.showNotification(title, { body, tag: 'chat-message' })
    return
  }
  new Notification(title, { body })
}
