// @vitest-environment happy-dom
// DOM-тесты экранов: поле облачного пароля (B16), подгрузка TURN (B30),
// presence в подписи диалога (B28), сброс таймера черновика (B22),
// long-press и свайп у сообщения (B33), revoke blob-URL (B34).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LoginScreen } from '../src/ui/screens/login.js'
import { SettingsScreen } from '../src/ui/screens/settings.js'
import { DialogScreen } from '../src/ui/screens/dialog.js'
import { Store } from '../src/ui/state/store.js'
import type { AppHost } from '../src/ui/host.js'
import type { UiState } from '../src/ui/host.js'
import type { Prefs } from '../src/store/prefs.js'
import { RelayError } from '../src/net/api.js'
import * as Env from '../src/protocol/envelope.js'
import { parse } from '../src/protocol/codec.js'
import { mediaInfo, MediaJson } from '../src/protocol/formats.js'

const PREFS: Prefs = {
  serverUrl: 'https://relay.test',
  iceServers: [{ urls: 'turn:turn.test:3478', username: 'turnuser', credential: 'turnpass' }],
  theme: 'auto',
  accent: 'blue',
  notifications: true,
  notificationSound: true,
  notificationText: false,
  quickReaction: '👍',
  presenceHidden: false,
  readReceipts: true,
  typingIndicator: true,
  autoDownloadMedia: false,
  installPromptSeen: false,
  lastChat: null,
}

function baseState(): UiState {
  return {
    route: { name: 'dialog', chatId: 'bob' },
    connected: true,
    summaries: [],
    chatId: 'bob',
    snapshot: null,
    chatLoading: false,
    search: '',
    searchOpen: false,
    replyTo: null,
    editTarget: null,
    composerDraft: '',
    callView: null,
    installAvailable: false,
    failedSends: [],
    presence: null,
    reverify: null,
    theme: 'auto',
    accent: 'blue',
    version: 0,
  }
}

interface FakeMessenger {
  session: { login: string; token?: string }
  setDraft(chatId: string, text_: string): Promise<void>
}

function makeHost(options?: { prefs?: Partial<Prefs>; state?: Partial<UiState>; messenger?: FakeMessenger | null; drafts?: Map<string, string> }) {
  const store = new Store<UiState>({ ...baseState(), ...options?.state })
  const prefs = { ...PREFS, ...options?.prefs }
  const drafts = options?.drafts ?? new Map<string, string>()
  const host = {
    store,
    get state() {
      return store.get()
    },
    navigate: () => undefined,
    refreshSummaries: async () => undefined,
    refreshDialog: async () => undefined,
    openChat: async () => undefined,
    showChats: () => undefined,
    showSettings: () => undefined,
    toast: () => undefined,
    errorMessage: (error: unknown) => (error instanceof Error ? error.message : 'ошибка'),
  }
  const ctx = {
    prefs,
    storagePersisted: true,
    messenger: options?.messenger === null ? null : (options?.messenger ?? { session: { login: 'me' }, setDraft: async () => undefined }),
    drafts: {
      get: async (chatId: string) => (drafts.has(chatId) ? { text: drafts.get(chatId)!, at: 1 } : null),
    },
    savePrefs: async () => undefined,
    login: async () => undefined,
    register: async () => undefined,
    linkOffer: async () => ({ nonce: 'n', secret: 's' }),
    linkStatus: async () => null,
    linkJoin: async () => 'f',
    linkToken: async () => null,
    parseLinkOffer: (code: string) => (code.includes('|') ? { nonce: 'n', secret: 's' } : null),
  }
  return { host: { ...host, ctx } as unknown as AppHost, store, prefs }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('B16: поле облачного пароля появляется при cloudpw_required', () => {
  it('скрыто по умолчанию и открывается после ошибки входа', async () => {
      let fail = true
      const { host } = makeHost()
      ;(host.ctx as unknown as { login: () => Promise<void> }).login = async () => {
        if (fail) throw new RelayError(401, 'cloudpw_required', 'нужен облачный пароль')
      }
      const screen = new LoginScreen(host)
      screen.render()
      // полей пароля два: обычный и облачный; облачный — последний
      const passwords = screen.element.querySelectorAll<HTMLInputElement>('input[type=password]')
      const cloud = passwords[passwords.length - 1].closest('label')!
      expect(cloud.classList.contains('hidden')).toBe(true)

      // вход без облачного пароля — ошибка, поле открывается
      screen.element.querySelector<HTMLInputElement>('input[type=text]')!.value = 'bob'
      screen.element.querySelector<HTMLButtonElement>('.btn.primary')!.click()
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(cloud.classList.contains('hidden')).toBe(false)
      screen.dispose()
    })
})

describe('B30: редактор TURN подгружает текущие значения', () => {
  it('urls/логин подставлены, пароль замаскирован', () => {
      const { host } = makeHost({ messenger: { session: { login: 'me' }, setDraft: async () => undefined } })
      const screen = new SettingsScreen(host)
      screen.render()
      const inputs = screen.element.querySelectorAll<HTMLInputElement>('.form.inset input')
      expect(inputs).toHaveLength(3)
      expect(inputs[0].value).toBe('turn:turn.test:3478')
      expect(inputs[1].value).toBe('turnuser')
      expect(inputs[2].type).toBe('password')
      expect(inputs[2].value).toBe('turnpass')
    })

  it('пустые серверы не пачкают поля мусором', () => {
      const { host } = makeHost({ prefs: { iceServers: [] }, messenger: { session: { login: 'me' }, setDraft: async () => undefined } })
      const screen = new SettingsScreen(host)
      screen.render()
      const inputs = screen.element.querySelectorAll<HTMLInputElement>('.form.inset input')
      expect(inputs[0].value).toBe('')
      expect(inputs[1].value).toBe('')
      expect(inputs[2].value).toBe('')
    })
})

// ─── помощники для диалога ────────────────────────────────────────────────

function textItem(from: string, text_: string, mine: boolean): import('../src/domain/feed.js').FeedItem {
  const content = Env.escapeText(text_)
  const parsed = parse(content)
  return {
    record: { from, timestamp: FIXED_TS, content },
    parsed,
    kind: parsed.kind === 'content' ? parsed.content : null,
    mine,
    ref: `ref-${from}-${text_.slice(0, 4)}`,
    timestamp: FIXED_TS,
    pinned: false,
    sending: false,
  }
}

const FIXED_TS = 1_700_000_000_000

function dialogSnapshot(items: import('../src/domain/feed.js').FeedItem[]): import('../src/domain/messenger.js').ChatSnapshot {
  return { feed: items, reactions: new Map(), polls: new Map(), peerReadAt: 0, peerDeliveredAt: 0 }
}

describe('B28: подпись диалога показывает presence собеседника', () => {
  it('«в сети» по presence и пусто при его отсутствии', async () => {
      const { host } = makeHost({ state: { presence: { online: true, lastSeen: 0 }, snapshot: dialogSnapshot([textItem('bob', 'привет', false)]) } })
      const screen = new DialogScreen(host, 'bob')
      await screen.open('bob')
      expect(screen.element.querySelector('.chat-sub')!.textContent).toBe('в сети')
      screen.dispose()

      const second = makeHost({ state: { presence: { online: false, lastSeen: FIXED_TS }, snapshot: dialogSnapshot([textItem('bob', 'привет', false)]) } })
      const screen2 = new DialogScreen(second.host, 'bob')
      await screen2.open('bob')
      expect(screen2.element.querySelector('.chat-sub')!.textContent).toContain('не в сети')
      screen2.dispose()

      const third = makeHost({ state: { presence: null, snapshot: dialogSnapshot([textItem('bob', 'привет', false)]) } })
      const screen3 = new DialogScreen(third.host, 'bob')
      await screen3.open('bob')
      expect(screen3.element.querySelector('.chat-sub')!.textContent).toBe('')
      screen3.dispose()
    })
})

// ─── B22: таймер черновика ────────────────────────────────────────────────

describe('B22: черновик сохраняется по таймеру и сбрасывается при отправке', () => {
  it('набор текста пишет черновик через 800 мс, send сбрасывает его сразу', async () => {
    vi.useFakeTimers()
    const setDraft = vi.fn(async () => undefined)
    const messenger = dialogMessenger({ setDraft })
    const { host } = makeHost({ messenger })
    const screen = new DialogScreen(host, 'bob')
    await screen.open('bob')

    // набор текста — таймер запущен, но ещё не сработал
    const input = screen.element.querySelector<HTMLTextAreaElement>('.composer-input')!
    input.value = 'черновик'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    expect(setDraft).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(800)
    expect(setDraft).toHaveBeenCalledWith('bob', 'черновик')

    // отправка: черновик сразу пустеет, отложенный таймер не перезаписывает
    setDraft.mockClear()
    input.value = 'черновик'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    screen.element.querySelector<HTMLButtonElement>('.composer-send')!.click()
    expect(setDraft).toHaveBeenCalledWith('bob', '')

    // старый таймер снят: значение не возвращается в черновик
    setDraft.mockClear()
    await vi.advanceTimersByTimeAsync(2000)
    expect(setDraft).not.toHaveBeenCalled()

    // dispose тоже снимает таймер
    input.value = 'ещё'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    setDraft.mockClear()
    screen.dispose()
    await vi.advanceTimersByTimeAsync(2000)
    expect(setDraft).not.toHaveBeenCalled()
  })
})


// ─── B33: long-press / свайп / клик по сообщению ──────────────────────────

// happy-dom не реализует PointerEvent — собираем событие с координатами вручную
function firePointer(node: HTMLElement, type: string, x: number, y = 0): void {
  const event = new Event(type, { bubbles: true }) as Event & { clientX: number; clientY: number }
  Object.defineProperty(event, 'clientX', { value: x })
  Object.defineProperty(event, 'clientY', { value: y })
  node.dispatchEvent(event)
}

function dialogMessenger(extra?: Record<string, unknown>): FakeMessenger {
  return {
    session: { login: 'me' },
    setDraft: async () => undefined,
    react: async () => undefined,
    pinMessage: async () => undefined,
    sendTyping: async () => undefined,
    ...extra,
  } as unknown as FakeMessenger
}

describe('B33: меню сообщения доступно без правой кнопки', () => {
  it('long-press открывает меню, движение >8px его отменяет', async () => {
    vi.useFakeTimers()
    const react = vi.fn(async () => undefined)
    const messenger = dialogMessenger({ react })
    const { host } = makeHost({ messenger, state: { snapshot: dialogSnapshot([textItem('bob', 'привет', false)]) } })
    ;(host.ctx as unknown as Record<string, unknown>).messenger = messenger
    const screen = new DialogScreen(host, 'bob')
    await screen.open('bob')
    const message = screen.element.querySelector<HTMLElement>('.message')!

    // долгое нажатие без движения — меню открылось
    firePointer(message, 'pointerdown', 10, 10)
    await vi.advanceTimersByTimeAsync(500)
    expect(document.querySelector('[role=dialog]')).not.toBeNull()

    // закрыть и проверить отмену по движению
    document.querySelector<HTMLElement>('.modal-overlay')!.click()
    expect(document.querySelector('[role=dialog]')).toBeNull()

    firePointer(message, 'pointerdown', 10, 10)
    firePointer(message, 'pointermove', 40, 10)
    await vi.advanceTimersByTimeAsync(500)
    expect(document.querySelector('[role=dialog]')).toBeNull()

    screen.dispose()
  })

  it('свайп вправо ставит ответ и показывает панель цитаты', async () => {
    const messenger = dialogMessenger()
    const { host } = makeHost({ messenger, state: { snapshot: dialogSnapshot([textItem('bob', 'привет', false)]) } })
    ;(host.ctx as unknown as Record<string, unknown>).messenger = messenger
    const screen = new DialogScreen(host, 'bob')
    await screen.open('bob')
    const message = screen.element.querySelector<HTMLElement>('.message')!
    const replyBar = screen.element.querySelector<HTMLElement>('.reply-bar')!
    expect(replyBar.classList.contains('hidden')).toBe(true)

    // свайп вправо (>60px) без вертикального уноса
    firePointer(message, 'pointerdown', 0, 0)
    firePointer(message, 'pointerup', 120, 5)
    expect(replyBar.classList.contains('hidden')).toBe(false)
    expect(replyBar.textContent).toContain('привет')

    // короткий свайп ответ не ставит
    screen.element.querySelector<HTMLButtonElement>('.reply-bar button')!.click()
    expect(replyBar.classList.contains('hidden')).toBe(true)
    firePointer(message, 'pointerdown', 0, 0)
    firePointer(message, 'pointerup', 20, 5)
    expect(replyBar.classList.contains('hidden')).toBe(true)

    screen.dispose()
  })

  it('клик по сообщению тоже открывает меню (десктоп/деградация)', async () => {
      const messenger = dialogMessenger()
      const { host } = makeHost({ messenger, state: { snapshot: dialogSnapshot([textItem('bob', 'привет', false)]) } })
      ;(host.ctx as unknown as Record<string, unknown>).messenger = messenger
      const screen = new DialogScreen(host, 'bob')
      await screen.open('bob')
      const message = screen.element.querySelector<HTMLElement>('.message')!
      message.dispatchEvent(new Event('click', { bubbles: true }))
      expect(document.querySelector('[role=dialog]')).not.toBeNull()
      screen.dispose()
    })
})


// ─── B34: revoke blob-URL ─────────────────────────────────────────────────

function mediaItem(from: string): import('../src/domain/feed.js').FeedItem {
  const info = mediaInfo({ id: 'a'.repeat(64), key: new Uint8Array(32), size: 1024, width: 10, height: 10, thumb: 'AAAA' })
  const content = MediaJson.message(info)
  const parsed = parse(content)
  const ts = FIXED_TS + 1_000_000_000_000_000
  return {
    record: { from, timestamp: ts, content },
    parsed,
    kind: parsed.kind === 'content' ? parsed.content : null,
    mine: false,
    ref: `ref-media-${from}`,
    timestamp: ts,
    pinned: false,
    sending: false,
  }
}

describe('B34: blob-URL медиа отзываются при закрытии чата', () => {
  it('открытие фото создаёт URL, dispose его отзывает', async () => {
    const created: string[] = []
    const revoked: string[] = []
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: () => {
        const url = `blob:mock/${created.length}`
        created.push(url)
        return url
      },
      revokeObjectURL: (url: string) => {
        revoked.push(url)
      },
    })

    const ensureMedia = vi.fn(async () => new Uint8Array([1, 2, 3]))
    const messenger = dialogMessenger({ ensureMedia })
    const { host } = makeHost({ messenger, state: { snapshot: dialogSnapshot([mediaItem('bob')]) } })
    ;(host.ctx as unknown as Record<string, unknown>).messenger = messenger
    const screen = new DialogScreen(host, 'bob')
    await screen.open('bob')

    // до клика URL не создавались
    expect(created).toHaveLength(0)

    screen.element.querySelector<HTMLImageElement>('.photo')!.dispatchEvent(new Event('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(ensureMedia).toHaveBeenCalled()
    expect(created).toHaveLength(1)

    screen.dispose()
    expect(revoked).toEqual(created)

    vi.unstubAllGlobals()
  })
})

describe('пароль на экране входа: глаз показа', () => {
  it('переключает маскировку поля пароля', async () => {
    const { host } = makeHost()
    const screen = new LoginScreen(host)
    screen.render()
    const input = screen.element.querySelector<HTMLInputElement>('input[type="password"]')!
    expect(input).toBeTruthy()
    const eye = screen.element.querySelector<HTMLButtonElement>('.field-toggle')!
    expect(eye).toBeTruthy()
    expect(eye.textContent).toBe('показать пароль')

    eye.click()
    expect(input.type).toBe('text')
    expect(eye.textContent).toBe('скрыть пароль')

    eye.click()
    expect(input.type).toBe('password')
    screen.dispose()
  })
})
