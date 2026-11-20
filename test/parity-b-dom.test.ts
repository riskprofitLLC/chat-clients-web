// @vitest-environment happy-dom
// DOM-тесты волны B: пункты «Переслать»/«Выбрать» в меню сообщения,
// режим мультивыбора в диалоге, панель массовых действий и мета пересылки.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DialogScreen } from '../src/ui/screens/dialog.js'
import { openMessageMenu } from '../src/ui/components/message-menu.js'
import { closeModal } from '../src/ui/components/modal.js'
import { Store } from '../src/ui/state/store.js'
import * as Env from '../src/protocol/envelope.js'
import { MediaJson, ReplyFormat, mediaInfo } from '../src/protocol/formats.js'
import { parse } from '../src/protocol/codec.js'
import type { AppHost } from '../src/ui/host.js'
import type { UiState } from '../src/ui/host.js'
import type { ChatSummary } from '../src/domain/messenger.js'
import type { ChatSnapshot } from '../src/domain/messenger.js'
import type { FeedItem } from '../src/domain/feed.js'

const FIXED_TS = 1_700_000_000_000

function item(from: string, text_: string, mine: boolean): FeedItem {
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

function snapshot(items: FeedItem[]): ChatSnapshot {
  return { feed: items, reactions: new Map(), polls: new Map(), peerReadAt: 0, peerDeliveredAt: 0 }
}

function summary(chatId: string, title: string): ChatSummary {
  return {
    chatId,
    title,
    isGroup: false,
    lastRecord: null,
    lastKind: null,
    lastTs: FIXED_TS,
    unread: 0,
    draft: '',
    pinned: [],
    typing: false,
    members: 2,
    profileBio: '',
  }
}

interface FakeMessenger {
  session: { login: string }
  forwardMessages: ReturnType<typeof vi.fn>
  deleteMessages: ReturnType<typeof vi.fn>
  messages: ReturnType<typeof vi.fn>
  importRecords: ReturnType<typeof vi.fn>
  importMedia: ReturnType<typeof vi.fn>
  setDraft: () => Promise<void>
}

function makeHost(options: { items?: FeedItem[]; messenger?: FakeMessenger | null } = {}) {
  const state: UiState = {
    route: { name: 'dialog', chatId: 'bob' },
    connected: true,
    summaries: [summary('bob', 'Боб'), summary('carol', 'Кэрол')],
    chatId: 'bob',
    snapshot: snapshot(options.items ?? []),
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
  const store = new Store<UiState>(state)
  const messenger: FakeMessenger = options.messenger ?? {
    session: { login: 'me' },
    forwardMessages: vi.fn(async (_target: string, _records: unknown[]) => 1),
    deleteMessages: vi.fn(async (_chatId: string, _records: unknown[]) => undefined),
    messages: vi.fn(async () => []),
    importRecords: vi.fn(async () => 0),
    importMedia: vi.fn(async () => 0),
    setDraft: async () => undefined,
  }
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
    prefs: {},
    session: { login: 'me' },
    messenger: options.messenger === null ? null : messenger,
    drafts: { get: async () => null },
    media: { get: async () => null, put: async () => undefined },
    journal: { clearChat: async () => undefined },
  }
  return { host: { ...host, ctx } as unknown as AppHost, messenger }
}

afterEach(() => {
  closeModal()
  document.body.replaceChildren()
})

describe('меню сообщения: пересылка и выбор (P-W6/P-W7)', () => {
  it('«Переслать» и «Выбрать» есть в меню и вызывают свои действия', () => {
    let forwarded = 0
    let selected = 0
    openMessageMenu({ x: 0, y: 0 }, {
      react: () => undefined,
      reply: () => undefined,
      copy: () => undefined,
      pin: () => undefined,
      forward: () => {
        forwarded++
      },
      select: () => {
        selected++
      },
    })
    const items = Array.from(document.querySelectorAll<HTMLButtonElement>('.menu-item')).map((b) => b.textContent)
    expect(items.some((text) => text?.includes('Переслать'))).toBe(true)
    expect(items.some((text) => text?.includes('Выбрать'))).toBe(true)
    const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('.menu-item'))
    buttons.find((b) => b.textContent?.includes('Переслать'))!.click()
    buttons.find((b) => b.textContent?.includes('Выбрать'))!.click()
    expect(forwarded).toBe(1)
    expect(selected).toBe(1)
  })
})

describe('режим мультивыбора в диалоге (P-W7)', () => {
  it('«Выбрать» из меню включает режим, шапка считает выбранные, тап переключает', async () => {
    const { host } = makeHost({ items: [item('bob', 'привет', false), item('bob', 'второе', false)] })
    const screen = new DialogScreen(host, 'bob')
    await screen.open('bob')
    // меню сообщения → «Выбрать»
    screen.element.querySelector<HTMLElement>('.message')!.click()
    const menuItems = Array.from(document.querySelectorAll<HTMLButtonElement>('.menu-item'))
    menuItems.find((b) => b.textContent?.includes('Выбрать'))!.click()
    expect(screen.element.querySelector('.selection-title')!.textContent).toBe('1 выбрано')
    // в режиме выбора тап по сообщению переключает выделение, а не меню
    const nodes = screen.element.querySelectorAll<HTMLElement>('.message')
    expect(nodes[0].classList.contains('selecting')).toBe(true)
    expect(nodes[0].classList.contains('selected')).toBe(true)
    nodes[1].click()
    expect(screen.element.querySelector('.selection-title')!.textContent).toBe('2 выбрано')
    // панель массовых действий появилась
    expect(screen.element.querySelector('.selection-bar')!.classList.contains('hidden')).toBe(false)
    nodes[0].click()
    expect(screen.element.querySelector('.selection-title')!.textContent).toBe('1 выбрано')
    screen.dispose()
  })
})

describe('пересылка из диалога (P-W6)', () => {
  it('пикер чата шлёт выбранное сообщение штатным механизмом', async () => {
    const messenger = {
      session: { login: 'me' },
      forwardMessages: vi.fn(async (_target: string, _records: unknown[]) => 1),
      deleteMessages: vi.fn(async (_chatId: string, _records: unknown[]) => undefined),
      messages: vi.fn(async () => []),
      importRecords: vi.fn(async () => 0),
      importMedia: vi.fn(async () => 0),
      setDraft: async () => undefined,
    }
    const { host } = makeHost({ items: [item('bob', 'привет', false)], messenger })
    const screen = new DialogScreen(host, 'bob')
    await screen.open('bob')
    screen.element.querySelector<HTMLElement>('.message')!.click()
    const menu = Array.from(document.querySelectorAll<HTMLButtonElement>('.menu-item'))
    menu.find((b) => b.textContent?.includes('Переслать'))!.click()
    // выбор чата: текущий исключён, остаётся только «Кэрол»
    const chats = Array.from(document.querySelectorAll<HTMLButtonElement>('.menu-item'))
    expect(chats.some((b) => b.textContent?.includes('Кэрол'))).toBe(true)
    expect(chats.some((b) => b.textContent?.includes('Боб'))).toBe(false)
    chats.find((b) => b.textContent?.includes('Кэрол'))!.click()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(messenger.forwardMessages).toHaveBeenCalledTimes(1)
    const [target, records] = messenger.forwardMessages.mock.calls[0]
    expect(target).toBe('carol')
    expect(records).toHaveLength(1)
    screen.dispose()
  })
})

describe('массовые действия выделения (P-W7)', () => {
  it('удаление выбранных идёт через deleteMessages с подтверждением', async () => {
    const messenger = {
      session: { login: 'me' },
      forwardMessages: vi.fn(async (_target: string, _records: unknown[]) => 1),
      deleteMessages: vi.fn(async (_chatId: string, _records: unknown[]) => undefined),
      messages: vi.fn(async () => []),
      importRecords: vi.fn(async () => 0),
      importMedia: vi.fn(async () => 0),
      setDraft: async () => undefined,
    }
    const { host } = makeHost({ items: [item('bob', 'привет', false)], messenger })
    const screen = new DialogScreen(host, 'bob')
    await screen.open('bob')
    screen.element.querySelector<HTMLElement>('.message')!.click()
    const menu = Array.from(document.querySelectorAll<HTMLButtonElement>('.menu-item'))
    menu.find((b) => b.textContent?.includes('Выбрать'))!.click()
    const bar = screen.element.querySelector<HTMLElement>('.selection-bar')!
    expect(bar.classList.contains('hidden')).toBe(false)
    bar.querySelector<HTMLButtonElement>('[data-action=delete]')!.click()
    await new Promise((resolve) => setTimeout(resolve, 10))
    // подтверждение ещё не дано — удаления нет
    expect(messenger.deleteMessages).not.toHaveBeenCalled()
    const confirm = Array.from(document.querySelectorAll<HTMLButtonElement>('.btn.danger'))
    confirm.at(-1)!.click()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(messenger.deleteMessages).toHaveBeenCalledTimes(1)
    const [chatId, records] = messenger.deleteMessages.mock.calls[0]
    expect(chatId).toBe('bob')
    expect(records).toHaveLength(1)
    screen.dispose()
  })
})

describe('мета «Переслано от X» (P-W6)', () => {
  it('пересланный текст и медиа показывают исходного автора', async () => {
    const textContent = ReplyFormat.encodeForward('alice', 'пересланный текст')
    const mediaContent = MediaJson.message(mediaInfo({ id: 'a'.repeat(64), key: new Uint8Array(32), forwardFrom: 'alice' }))
    const items = [item('bob', 'пересланный текст', false), item('bob', 'фото', false)]
    items[0].record.content = textContent
    items[0].parsed = parse(textContent)
    items[0].kind = items[0].parsed.kind === 'content' ? items[0].parsed.content : null
    items[1].record.content = mediaContent
    items[1].parsed = parse(mediaContent)
    items[1].kind = items[1].parsed.kind === 'content' ? items[1].parsed.content : null
    const { host } = makeHost({ items })
    const screen = new DialogScreen(host, 'bob')
    await screen.open('bob')
    const marks = screen.element.querySelectorAll<HTMLElement>('.forwarded-from')
    expect(marks).toHaveLength(2)
    expect(marks[0].textContent).toContain('Переслано от alice')
    expect(marks[1].textContent).toContain('Переслано от alice')
    screen.dispose()
  })
})
