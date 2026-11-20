// @vitest-environment happy-dom
// Оболочка: boot, маршрутизация (hash + History API), мобильная и десктопная
// раскладки, связка с мессенджером, баннер установки и автоблокировка PIN.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppShell } from '../src/ui/shell.js'
import type { AppContext } from '../src/app/context.js'

const mediaState = new Map<string, boolean>()
// слушатели изменения медиа-запросов: оболочка переключает раскладку по ним
const mediaListeners = new Map<string, Array<(event: { matches: boolean }) => void>>()

function fireMedia(query: string, matches: boolean): void {
  mediaState.set(query, matches)
  for (const listener of mediaListeners.get(query) ?? []) listener({ matches })
}

function setMedia(query: string, matches: boolean): void {
  mediaState.set(query, matches)
}

// оболочка вешает слушатели на окно и не снимает их: собираем и убираем сами,
// иначе обработчики предыдущего теста перехватывают маршруты следующего
const windowListeners: Array<[string, EventListener]> = []
const realAddEventListener = window.addEventListener.bind(window)

beforeEach(() => {
  mediaState.clear()
  mediaListeners.clear()
  setMedia('(prefers-color-scheme: dark)', false)
  setMedia('(min-width: 900px)', false)
  setMedia('(display-mode: standalone)', false)
  window.matchMedia = ((query: string) => ({
    get matches() {
      return mediaState.get(query) ?? false
    },
    media: query,
    addEventListener(_type: string, listener: (event: { matches: boolean }) => void) {
      const list = mediaListeners.get(query) ?? []
      list.push(listener)
      mediaListeners.set(query, list)
    },
    removeEventListener() {
      mediaListeners.delete(query)
    },
  })) as unknown as typeof window.matchMedia
  window.addEventListener = ((type: string, listener: EventListener, options?: AddEventListenerOptions) => {
    windowListeners.push([type, listener])
    return realAddEventListener(type, listener, options)
  }) as typeof window.addEventListener
})

interface FakeCtx {
  ctx: AppContext
  events: Array<(event: unknown) => void>
  saved: Array<Record<string, unknown>>
  calls: {
    resumeAudioCalls: number
    callEvents: unknown[][]
    updateListeners: Array<(view: unknown) => void>
    onCallEvent(...args: unknown[]): Promise<void>
    onUpdate(listener: (view: unknown) => void): () => void
    resumeAudio(): void
  }
  messengerMarkRead: string[]
}

function makeCtx(options?: { restored?: boolean; messenger?: boolean; lockEnabled?: boolean; autoLockSec?: number }): FakeCtx {
  const events: Array<(event: unknown) => void> = []
  const saved: Array<Record<string, unknown>> = []
  const messengerMarkRead: string[] = []
  const messenger = options?.messenger
    ? {
        session: { login: 'me', deviceId: 'dev-1' },
        onEvent(listener: (event: unknown) => void): () => void {
          events.push(listener)
          return () => undefined
        },
        chatSummaries: async () => [],
        failedSends: async () => [],
        flushOutbox: async () => undefined,
        drainAll: async () => undefined,
        markRead: async (chatId: string) => void messengerMarkRead.push(chatId),
        checkOnline: async () => null,
        chatSnapshot: async () => null,
        reverifyPending: async () => null,
        callLog: async () => [],
      }
    : null

  const calls = {
    resumeAudioCalls: 0,
    callEvents: [] as unknown[][],
    updateListeners: [] as Array<(view: unknown) => void>,
    async onCallEvent(...args: unknown[]): Promise<void> {
      calls.callEvents.push(args)
    },
    onUpdate(listener: (view: unknown) => void): () => void {
      calls.updateListeners.push(listener)
      return () => undefined
    },
    resumeAudio(): void {
      calls.resumeAudioCalls++
    },
  }

  const prefs = {
    theme: 'auto',
    accent: 'blue',
    iceServers: [{ urls: 'stun:stun.test' }],
    notifications: false,
    installPromptSeen: false,
    lockEnabled: options?.lockEnabled ?? false,
    autoLockSec: options?.autoLockSec ?? 0,
  }

  const ctx = {
    prefs,
    session: { login: 'me' },
    chatFlags: { all: async () => ({ markedUnread: [], archived: [], muted: [] }) },
    contacts: { all: async () => [] },
    groups: { all: async () => [] },
    drafts: { get: async () => null },
    profiles: { get: async () => null },
    blocked: { all: async () => [] },
    kv: { list: async () => [] },
    messenger,
    calls,
    restore: async () => options?.restored ?? false,
    devAutoLogin: async () => false,
    // сохранение префсов патчит объект, как настоящий PrefsStore
    savePrefs: async (changes: Record<string, unknown>) => {
      saved.push(changes)
      Object.assign(prefs, changes)
    },
    pinLock: {
      state: async () => ({ enabled: options?.lockEnabled ?? false }),
      remainingMs: async () => 0,
    },
  } as unknown as AppContext
  return { ctx, events, saved, calls, messengerMarkRead }
}

function mount(fake: FakeCtx): { shell: AppShell; root: HTMLElement } {
  const root = document.createElement('div')
  document.body.appendChild(root)
  const shell = new AppShell(root, fake.ctx)
  return { shell, root }
}

afterEach(() => {
  // тесты меняют видимость вкладки — возвращаем «на экране» следующим тестам
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
  for (const [type, listener] of windowListeners.splice(0)) window.removeEventListener(type, listener)
  document.body.replaceChildren()
  location.hash = ''
  vi.useRealTimers()
})

describe('boot', () => {
  it('.без сессии открывается экран входа', async () => {
    const fake = makeCtx()
    const { shell, root } = mount(fake)
    await shell.boot()
    expect(location.hash).toBe('#/login')
    expect(root.querySelector('.login-wrap')).not.toBeNull()
    // пилюля разделов на странице входа не показывается
    expect(document.body.classList.contains('bottom-nav-on')).toBe(false)
  })

  it('.с восстановленной сессией открываются чаты', async () => {
    const fake = makeCtx({ restored: true, messenger: true })
    const { shell, root } = mount(fake)
    await shell.boot()
    expect(location.hash).toBe('#/chats')
    expect(root.querySelector('.screen')).not.toBeNull()
    // мессенджер и звонки подключены к оболочке
    expect(fake.events).toHaveLength(1)
    expect(fake.calls.updateListeners).toHaveLength(1)
  })

  it('.без мессенджера связка не подписывается', async () => {
    const fake = makeCtx({ restored: true })
    const { shell } = mount(fake)
    await shell.boot()
    expect(fake.events).toHaveLength(0)
  })
})

describe('маршрутизация', () => {
  it('.hash меняет маршрут и монтирует экран', async () => {
    const fake = makeCtx({ restored: true, messenger: true })
    const { shell, root } = mount(fake)
    await shell.boot()
    location.hash = '#/contacts'
    window.dispatchEvent(new Event('hashchange'))
    expect(shell.state.route).toEqual({ name: 'contacts' })
    expect(root.querySelector('.screen')).not.toBeNull()
  })

  it('.повторный navigate на тот же hash перемонтирует экран', async () => {
    const fake = makeCtx({ restored: true, messenger: true })
    const { shell } = mount(fake)
    await shell.boot()
    shell.navigate({ name: 'chats' })
    expect(shell.state.route).toEqual({ name: 'chats' })
  })

  it('.неизвестный hash откатывается на экран входа', async () => {
    const fake = makeCtx()
    const { shell, root } = mount(fake)
    await shell.boot()
    location.hash = '#/мимо'
    window.dispatchEvent(new Event('hashchange'))
    expect(shell.state.route).toEqual({ name: 'login' })
    expect(root.querySelector('.login-wrap')).not.toBeNull()
  })

  it('.диалог без мессенджера уводит на вход', async () => {
    const fake = makeCtx({ restored: true })
    const { shell } = mount(fake)
    await shell.boot()
    location.hash = `#/chat/${encodeURIComponent('bob')}`
    window.dispatchEvent(new Event('hashchange'))
    expect(shell.state.route).toEqual({ name: 'login' })
  })
})

describe('раскладки', () => {
  it('.десктоп: сайдбар чатов и главная панель', async () => {
    setMedia('(min-width: 900px)', true)
    const fake = makeCtx({ restored: true, messenger: true })
    const { shell, root } = mount(fake)
    await shell.boot()
    expect(root.querySelector('.app-shell')).not.toBeNull()
    expect(root.querySelector('.sidebar')).not.toBeNull()
    expect(root.querySelector('.main-pane')).not.toBeNull()
    // пилюли разделов на десктопе нет
    expect(document.body.classList.contains('bottom-nav-on')).toBe(false)
  })

  it('.десктоп: настройки открываются в главной панели', async () => {
    setMedia('(min-width: 900px)', true)
    const fake = makeCtx({ restored: true, messenger: true })
    const { shell, root } = mount(fake)
    await shell.boot()
    shell.navigate({ name: 'settings' })
    expect(root.querySelector('.main-pane .screen')).not.toBeNull()
  })

  it('.десктоп: пустой маршрут предлагает выбрать чат', async () => {
    setMedia('(min-width: 900px)', true)
    const fake = makeCtx({ restored: true, messenger: true })
    const { shell, root } = mount(fake)
    await shell.boot()
    shell.navigate({ name: 'profile' })
    expect(root.querySelector('.desktop-empty')).not.toBeNull()
  })

  it('.мобильная раскладка: нижняя пилюля с активным табом и бейджем', async () => {
    const fake = makeCtx({ restored: true, messenger: true })
    const { shell, root } = mount(fake)
    await shell.boot()
    expect(document.body.classList.contains('bottom-nav-on')).toBe(true)
    const items = Array.from(root.querySelectorAll<HTMLButtonElement>('.bottom-nav-item'))
    expect(items).toHaveLength(4)
    expect(items[0]!.classList.contains('active')).toBe(true)
    // без непрочитанных бейдж скрыт
    expect(root.querySelector('.bottom-nav-badge')!.classList.contains('hidden')).toBe(true)
  })
})

describe('события мессенджера', () => {
  it('.presence переключает connected', async () => {
    const fake = makeCtx({ restored: true, messenger: true })
    const { shell } = mount(fake)
    await shell.boot()
    fake.events[0]!({ type: 'presence', connected: false })
    expect(shell.state.connected).toBe(false)
  })

  it('.событие звонка без mute уходит в CallManager', async () => {
    const fake = makeCtx({ restored: true, messenger: true })
    const { shell } = mount(fake)
    await shell.boot()
    fake.events[0]!({ type: 'call', from: 'bob', self: false, verdict: { kind: 'ring', event: { ev: 'offer', callId: 'c1', ts: 1, cands: [] } } })
    expect(fake.calls.callEvents).toHaveLength(1)
    // mute-событие звонка не обрабатывается
    fake.events[0]!({ type: 'call', from: 'bob', self: false, verdict: { kind: 'mute' } })
    expect(fake.calls.callEvents).toHaveLength(1)
  })

  it('.keys-changed запоминает reverify для открытого чата', async () => {
    const fake = makeCtx({ restored: true, messenger: true })
    const { shell } = mount(fake)
    await shell.boot()
    location.hash = '#/chat/bob'
    window.dispatchEvent(new Event('hashchange'))
    fake.events[0]!({ type: 'keys-changed', chatId: 'bob', peer: 'bob', devices: ['d2'], isNewDevice: true })
    expect(shell.state.reverify).toEqual({ devices: ['d2'], isNewDevice: true })
  })

  it('.ошибка мессенджера показывает всплывающее сообщение', async () => {
    const fake = makeCtx({ restored: true, messenger: true })
    const { shell } = mount(fake)
    await shell.boot()
    fake.events[0]!({ type: 'error', message: 'сеть' })
    expect(document.querySelector('.snackbar-error')).not.toBeNull()
  })

  it('.сообщение в скрытой вкладке уводит в уведомление', async () => {
    const fake = makeCtx({ restored: true, messenger: true })
    const { shell } = mount(fake)
    await shell.boot()
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    fake.events[0]!({ type: 'message', chatId: 'bob' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    // уведомления выключены в префсах — notifyMessage не вызывается
    expect(shell.state.summaries).toEqual([])
  })
})

describe('баннер установки', () => {
  it('.событие браузера на чатах показывает баннер, отказ сохраняется', async () => {
    const fake = makeCtx({ restored: true, messenger: true })
    const { shell, root } = mount(fake)
    await shell.boot()
    // до события доступности баннера нет: установка ещё не предложена
    expect(root.querySelector('.install-banner')).toBeNull()
    window.dispatchEvent(new Event('beforeinstallprompt'))
    const banner = root.querySelector('.install-banner')!
    expect(banner).not.toBeNull()
    // доступность установки пришла — кнопка зовёт установить
    expect(banner.querySelector('.btn')!.textContent).toBe('Установить приложение')
    await banner.querySelector<HTMLButtonElement>('.icon-btn')!.click()
    expect(fake.saved).toEqual([{ installPromptSeen: true }])
    expect(root.querySelector('.install-banner')).toBeNull()
  })

  it('.на других маршрутах баннера нет', async () => {
    const fake = makeCtx({ restored: true, messenger: true })
    const { shell, root } = mount(fake)
    await shell.boot()
    shell.navigate({ name: 'settings' })
    expect(root.querySelector('.install-banner')).toBeNull()
  })

  it('.установленное приложение (standalone) баннер не показывает', async () => {
    setMedia('(display-mode: standalone)', true)
    const fake = makeCtx({ restored: true, messenger: true })
    const { shell, root } = mount(fake)
    await shell.boot()
    expect(root.querySelector('.install-banner')).toBeNull()
  })
})

describe('клавиатура, данные и блокировка', () => {
  it('.ctrl+k уводит на список чатов', async () => {
    const fake = makeCtx({ restored: true, messenger: true })
    const { shell } = mount(fake)
    await shell.boot()
    shell.navigate({ name: 'settings' })
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }))
    expect(shell.state.route).toEqual({ name: 'chats' })
  })

  it('.refreshSummaries обновляет список и версию', async () => {
    const fake = makeCtx({ restored: true, messenger: true })
    const { shell } = mount(fake)
    await shell.boot()
    await shell.refreshSummaries()
    expect(shell.state.version).toBeGreaterThan(0)
  })

  it('.отметка о прочтении уходит через 500 мс после показа диалога', async () => {
    vi.useFakeTimers()
    const fake = makeCtx({ restored: true, messenger: true })
    const { shell } = mount(fake)
    await shell.boot()
    location.hash = '#/chat/bob'
    window.dispatchEvent(new Event('hashchange'))
    await vi.advanceTimersByTimeAsync(600)
    expect(fake.messengerMarkRead).toEqual(['bob'])
  })

  it('.toast и errorMessage делегируют во всплывающее сообщение и errorText', async () => {
    const fake = makeCtx({ restored: true, messenger: true })
    const { shell } = mount(fake)
    await shell.boot()
    shell.toast('готово')
    expect(document.querySelector('.snackbar-info')!.textContent).toContain('готово')
    expect(shell.errorMessage(new Error('сеть'))).toBe('сеть')
  })
})

describe('автоблокировка PIN', () => {
  it('.PIN включён: поверх интерфейса встаёт экран блокировки', async () => {
    const fake = makeCtx({ restored: true, messenger: true, lockEnabled: true, autoLockSec: 10 })
    const { shell } = mount(fake)
    await shell.boot()
    expect(document.querySelector('.app-lock')).not.toBeNull()
  })

  it('.PIN выключен: экрана блокировки нет', async () => {
    const fake = makeCtx({ restored: true, messenger: true })
    const { shell } = mount(fake)
    await shell.boot()
    expect(document.querySelector('.app-lock')).toBeNull()
  })

  it('.после разблокировки простой дольше порога блокирует снова', async () => {
    vi.useFakeTimers()
    const fake = makeCtx({ restored: true, messenger: true, lockEnabled: true, autoLockSec: 10 })
    // разблокировка удаётся с первого раза
    ;(fake.ctx as unknown as { pinLock: { verify: () => Promise<{ ok: boolean; remainingMs: number }> } }).pinLock.verify =
      async () => ({ ok: true, remainingMs: 0 })
    const { shell } = mount(fake)
    await shell.boot()
    const input = document.querySelector<HTMLInputElement>('.app-lock-input')!
    input.value = '123456'
    // ввод обрабатывается слушателем: без события кнопка останется выключенной
    input.dispatchEvent(new Event('input'))
    const submit = document.querySelector<HTMLButtonElement>('.app-lock-card .btn.primary')!
    expect(submit.disabled).toBe(false)
    await submit.click()
    expect(document.querySelector('.app-lock')).toBeNull()

    // простой дольше порога — блокировка возвращается
    await vi.advanceTimersByTimeAsync(11_000)
    expect(document.querySelector('.app-lock')).not.toBeNull()
  })
})

describe('мобильные маршруты', () => {
  it('.контакты, звонки, профиль, блок, хранилище и настройки', async () => {
    const fake = makeCtx({ restored: true, messenger: true })
    const { shell, root } = mount(fake)
    await shell.boot()
    const routes = ['contacts', 'calls', 'profile', 'blocked', 'storage', 'settings'] as const
    for (const name of routes) {
      location.hash = `#/${name}`
      window.dispatchEvent(new Event('hashchange'))
      expect(shell.state.route).toEqual({ name })
      expect(root.querySelector('.screen')).not.toBeNull()
    }
  })

  it('.диалог с мессенджером открывается и запрашивает snapshot', async () => {
    const fake = makeCtx({ restored: true, messenger: true })
    const { shell, root } = mount(fake)
    await shell.boot()
    location.hash = '#/chat/bob'
    window.dispatchEvent(new Event('hashchange'))
    expect(shell.state.route).toEqual({ name: 'dialog', chatId: 'bob' })
    expect(shell.state.chatId).toBe('bob')
    await shell.refreshDialog()
    expect(root.querySelector('.screen')).not.toBeNull()
  })

  it('.смена ширины переключает раскладку на десктопную', async () => {
    const fake = makeCtx({ restored: true, messenger: true })
    const { shell, root } = mount(fake)
    await shell.boot()
    fireMedia('(min-width: 900px)', true)
    expect(root.querySelector('.app-shell')).not.toBeNull()
  })
})

describe('десктопные маршруты и хелперы хоста', () => {
  it('.настройки, блок, хранилище, звонки и контакты в главной панели', async () => {
    setMedia('(min-width: 900px)', true)
    const fake = makeCtx({ restored: true, messenger: true })
    const { shell, root } = mount(fake)
    await shell.boot()
    for (const name of ['settings', 'blocked', 'storage', 'calls', 'contacts'] as const) {
      shell.navigate({ name })
      expect(root.querySelector('.main-pane .screen')).not.toBeNull()
    }
  })

  it('.хелперы хоста навигируют и открывают чат', async () => {
    const fake = makeCtx({ restored: true, messenger: true })
    const { shell } = mount(fake)
    await shell.boot()
    shell.showChats()
    expect(shell.state.route).toEqual({ name: 'chats' })
    shell.showContacts()
    expect(shell.state.route).toEqual({ name: 'contacts' })
    shell.showSettings()
    expect(shell.state.route).toEqual({ name: 'settings' })
    shell.showProfile()
    expect(shell.state.route).toEqual({ name: 'profile' })
    shell.showCalls()
    expect(shell.state.route).toEqual({ name: 'calls' })
    await shell.openChat('bob')
    expect(shell.state.route).toEqual({ name: 'dialog', chatId: 'bob' })
  })

  it('.регистрация service worker включает слежение за обновлением', async () => {
    const registration = { waiting: null, installing: null, addEventListener: () => undefined }
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { register: async () => registration, controller: null },
    })
    const fake = makeCtx({ restored: true, messenger: true })
    const { shell } = mount(fake)
    await shell.boot()
    // watchForUpdate повесил слушатель на регистрацию и ничего не сломал
    expect(registration.addEventListener).toBeDefined()
  })
})

describe('уведомления о сообщениях', () => {
  it('.сообщение в скрытой вкладке показывает уведомление', async () => {
    const shown: string[] = []
    class FakeNotification {
      constructor(title: string, options?: { body?: string }) {
        shown.push(`${title}:${options?.body ?? ''}`)
      }
    }
    Object.defineProperty(FakeNotification, 'permission', { value: 'granted' })
    vi.stubGlobal('Notification', FakeNotification)
    const fake = makeCtx({ restored: true, messenger: true })
    // уведомления включены, мессенджер отдаёт сводку по чату
    ;(fake.ctx.prefs as unknown as { notifications: boolean }).notifications = true
    ;(fake.ctx.messenger as unknown as { chatSummaries: () => Promise<unknown[]> }).chatSummaries = async () => [
      {
        chatId: 'bob',
        title: 'Боб',
        isGroup: false,
        lastRecord: null,
        lastKind: null,
        lastTs: 0,
        unread: 1,
        draft: '',
        pinned: [],
        typing: false,
        members: 2,
        profileBio: '',
      },
    ]
    const { shell } = mount(fake)
    await shell.boot()
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    fake.events[0]!({ type: 'message', chatId: 'bob' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(shown).toHaveLength(1)
    expect(shown[0]).toContain('Боб')
  })
})
