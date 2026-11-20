// @vitest-environment happy-dom
// Регрессии геометрии веб-клиента: прокрутка экранов настроек и звонков не
// сбрасывается наверх при перерисовке, список контактов перерисовывается на
// месте, а строка списка чатов не шире своего контейнера.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { SettingsScreen } from '../src/ui/screens/settings.js'
import { CallsScreen } from '../src/ui/screens/calls.js'
import { ContactsScreen } from '../src/ui/screens/contacts.js'
import { Store } from '../src/ui/state/store.js'
import type { AppHost } from '../src/ui/host.js'
import type { UiState } from '../src/ui/host.js'
import type { Prefs } from '../src/store/prefs.js'
import { DEFAULT_STUN_URL } from '../src/store/prefs.js'
import type { CallLogEntry } from '../src/store/chat-state.js'
import type { Contact } from '../src/store/contacts.js'

const PREFS: Prefs = {
  serverUrl: 'https://relay.test',
  iceServers: [{ urls: DEFAULT_STUN_URL }],
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
  contactsSort: 'name',
  lockEnabled: false,
  pinSalt: null,
  pinHash: null,
  pinFailCount: 0,
  pinLockedUntil: 0,
  autoLockSec: 0,
}

const CALLS: CallLogEntry[] = [
  { callId: 'c1', peer: 'bob', outgoing: true, status: 'completed', at: 1700000000000, seconds: 42 },
  { callId: 'c2', peer: 'alice', outgoing: false, status: 'missed', at: 1699999000000, seconds: 0 },
]

const CONTACTS: Contact[] = [
  { login: 'bob', name: 'Боб', updatedAt: 1700000000000 },
  { login: 'alice', name: '', updatedAt: 1699999000000 },
]

function baseState(): UiState {
  return {
    route: { name: 'settings' },
    connected: true,
    summaries: [],
    chatId: null,
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

interface FakeHost {
  host: AppHost
  store: Store<UiState>
}

function makeHost(): FakeHost {
  const store = new Store<UiState>(baseState())
  const contacts = CONTACTS.map((item) => ({ ...item }))
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
    showContacts: () => undefined,
    showSettings: () => undefined,
    showCalls: () => undefined,
    toast: () => undefined,
    errorMessage: (error: unknown) => (error instanceof Error ? error.message : 'ошибка'),
  }
  const ctx = {
    prefs: PREFS,
    storagePersisted: true,
    session: { login: 'me', token: 'tok', api: {} },
    messenger: {
      session: { login: 'me', token: 'tok' },
      callLog: async () => CALLS.map((entry) => ({ ...entry })),
      setBio: async () => undefined,
      chatSummaries: async () => [],
      failedSends: async () => [],
    },
    contacts: {
      all: async () => contacts.map((item) => ({ ...item })),
      put: async (item: Contact) => {
        const index = contacts.findIndex((existing) => existing.login === item.login)
        if (index >= 0) contacts[index] = item
        else contacts.push(item)
      },
      rename: async (login: string, name: string) => {
        const item = contacts.find((existing) => existing.login === login)
        if (item) item.name = name
      },
      remove: async (login: string) => {
        const index = contacts.findIndex((existing) => existing.login === login)
        if (index >= 0) contacts.splice(index, 1)
      },
      get: async () => null,
      byName: async (login: string) => login,
    },
    savePrefs: async () => undefined,
  }
  return { host: { ...host, ctx } as unknown as AppHost, store }
}

// happy-dom не считает раскладку и не сбрасывает scrollTop при замене детей —
// эмулируем поведение браузера, иначе тест ничего не проверял бы.
function resetScrollOnReplace(node : HTMLElement) : void {
  const original = node.replaceChildren.bind(node)
  node.replaceChildren = ((...children : ChildNode[]) => {
    original(...children)
    node.scrollTop = 0
  }) as HTMLElement['replaceChildren']
}

describe('прокрутка настроек не сбрасывается при перерисовке', () => {
  it('повторный render() возвращает scrollTop тела настроек', () => {
    const fake = makeHost()
    const screen = new SettingsScreen(fake.host)
    screen.render()
    const body = screen.element.querySelector<HTMLElement>('.settings-body')!
    resetScrollOnReplace(body)
    body.scrollTop = 320
    screen.render()
    expect(screen.element.querySelector('.settings-body')!.scrollTop).toBe(320)
  })

  it('первая отрисовка не трогает прокрутку', () => {
    const fake = makeHost()
    const screen = new SettingsScreen(fake.host)
    screen.render()
    expect(screen.element.querySelector('.settings-body')!.scrollTop).toBe(0)
  })
})

describe('прокрутка журнала звонков не сбрасывается', () => {
  it('повторный render() сохраняет позицию списка', async () => {
    const fake = makeHost()
    const screen = new CallsScreen(fake.host)
    await screen.render()
    const list = screen.element.querySelector<HTMLElement>('.chat-list')!
    resetScrollOnReplace(list)
    list.scrollTop = 200
    await screen.render()
    expect(list.scrollTop).toBe(200)
  })
})

describe('контакты перерисовываются на месте', () => {
  it('узел списка тот же и прокрутка сохранена', async () => {
    const fake = makeHost()
    const screen = new ContactsScreen(fake.host)
    await screen.render()
    const list = screen.element.querySelector<HTMLElement>('.chat-list')!
    list.scrollTop = 150
    await screen.render()
    expect(screen.element.querySelector('.chat-list')).toBe(list)
    expect(list.scrollTop).toBe(150)
  })
})

describe('строка списка чатов не шире контейнера', () => {
  const css = readFileSync('src/ui/styles/components.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  const rowBlock = css.slice(css.indexOf('.chat-row {'), css.indexOf('}', css.indexOf('.chat-row {')))
  const listBlock = css.slice(css.indexOf('.chat-list {'), css.indexOf('}', css.indexOf('.chat-list {')))

  it('строка занимает ширину списка, а боковые отступы держит контейнер', () => {
    // <button> с display:flex без width садится по контенту и уезжает за край
    expect(rowBlock).toMatch(/width\s*:\s*100%/)
    // горизонтальных margin'ов у строки нет — иначе width:100% даёт переполнение
    expect(rowBlock).not.toMatch(/margin-left|margin-right|margin\s*:\s*[^;]*var\(--sp-2\)/)
    expect(listBlock).toMatch(/padding-left\s*:\s*var\(--sp-2\)/)
    expect(listBlock).toMatch(/padding-right\s*:\s*var\(--sp-2\)/)
  })

  it('ни один экран не возвращает строке горизонтальные margin', () => {
    const screens = readFileSync('src/ui/styles/screens.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    const mediaStart = screens.indexOf('@media (min-width: 900px)')
    const media = screens.slice(mediaStart, screens.indexOf('@media (min-width: 1280px)', mediaStart))
    expect(media).not.toMatch(/\.chat-row/)
  })
})
