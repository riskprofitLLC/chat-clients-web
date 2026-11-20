// @vitest-environment happy-dom
// Экран контактов: ряд «Недавние звонки», выбор сортировки и догрузка
// времени захода (пачками по 5, без повторных запросов).
import { describe, expect, it } from 'vitest'
import { ContactsScreen } from '../src/ui/screens/contacts.js'
import { Store } from '../src/ui/state/store.js'
import { DEFAULT_PREFS, type Prefs } from '../src/store/prefs.js'
import type { OnlineStatus } from '../src/net/api.js'
import type { AppHost, UiState } from '../src/ui/host.js'
import type { Contact } from '../src/store/contacts.js'

function contact(login: string, name: string): Contact {
  return { login, name, updatedAt: 1_700_000_000_000 }
}

function state(): UiState {
  return {
    route: { name: 'contacts' },
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

function makeHost(options: {
  contacts?: Contact[]
  prefs?: Partial<Prefs>
  session?: null
  checkOnline?: (token: string, login: string) => Promise<OnlineStatus>
} = {}) {
  const prefs = { ...DEFAULT_PREFS, ...options.prefs }
  const contacts = options.contacts ?? [contact('bob', 'Боб'), contact('alice', 'Алиса')]
  const requests: string[] = []
  const saved: Array<Partial<Prefs>> = []
  let callsShown = 0
  const ctx = {
    prefs,
    session: options.session === null ? null : { login: 'me', token: 'tok' },
    api: {
      checkOnline: async (token: string, login: string) => {
        requests.push(login)
        return options.checkOnline
          ? await options.checkOnline(token, login)
          : ({ online: false, lastSeenUnix: 1_000 } satisfies OnlineStatus)
      },
    },
    contacts: { all: async () => contacts.map((item) => ({ ...item })) },
    savePrefs: async (changes: Partial<Prefs>) => {
      saved.push(changes)
      Object.assign(prefs, changes)
    },
  }
  const store = new Store<UiState>(state())
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
    showCalls: () => {
      callsShown++
    },
    toast: () => undefined,
    errorMessage: (error: unknown) => String(error),
  }
  return {
    host: { ...host, ctx } as unknown as AppHost,
    prefs,
    requests,
    saved,
    callsShown: () => callsShown,
  }
}

const flush = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function logins(screen: ContactsScreen): string[] {
  return Array.from(screen.element.querySelectorAll('.contact-row')).map((row) => (row as HTMLElement).dataset.key!)
}

describe('экран контактов: сортировка', () => {
  it('ряд «Недавние звонки» открывает журнал', async () => {
    const fake = makeHost()
    const screen = new ContactsScreen(fake.host)
    await screen.render()
    const row = screen.element.querySelector<HTMLElement>('.recent-calls-row')!
    expect(row.textContent).toContain('Недавние звонки')
    expect(row.querySelector('svg')).not.toBeNull()
    row.click()
    expect(fake.callsShown()).toBe(1)
  })

  it('модалка сохраняет режим и перерисовывает список', async () => {
    const fake = makeHost({
      checkOnline: async (_token, login) => ({ online: false, lastSeenUnix: login === 'bob' ? 2_000 : 1_000 }),
    })
    const screen = new ContactsScreen(fake.host)
    await screen.render()
    expect(logins(screen)).toEqual(['alice', 'bob'])
    screen.element.querySelector<HTMLButtonElement>('[aria-label="Сортировка"]')!.click()
    const sheet = document.querySelector('.modal-sheet')!
    const options = sheet.querySelectorAll<HTMLButtonElement>('.sort-option')
    expect(options).toHaveLength(2)
    expect(options[0].querySelector('svg')).not.toBeNull()
    expect(options[1].querySelector('svg')).toBeNull()
    options[1].click()
    await flush()
    expect(fake.saved).toEqual([{ contactsSort: 'lastSeen' }])
    expect(logins(screen)).toEqual(['bob', 'alice'])
    document.querySelector('.modal-overlay')?.remove()
  })

  it('догрузка идёт пачками по 5, без дублей, ошибки уходят вниз', async () => {
    const contacts = Array.from({ length: 7 }, (_, i) => contact(`u${i}`, `Имя ${i}`))
    let active = 0
    let maxActive = 0
    const release: Array<() => void> = []
    const fake = makeHost({
      contacts,
      prefs: { contactsSort: 'lastSeen' },
      checkOnline: async (_token, login) => {
        active++
        maxActive = Math.max(maxActive, active)
        return await new Promise<OnlineStatus>((resolve, reject) => {
          release.push(() => {
            active--
            if (login === 'u0') reject(new Error('сеть'))
            else resolve({ online: false, lastSeenUnix: 1_000 + Number(login.slice(1)) })
          })
        })
      },
    })
    const screen = new ContactsScreen(fake.host)
    await screen.render()
    expect(fake.requests).toEqual(['u0', 'u1', 'u2', 'u3', 'u4'])
    expect(maxActive).toBe(5)
    screen.update()
    expect(fake.requests).toHaveLength(5)
    for (const done of release.splice(0)) done()
    await flush()
    expect(fake.requests).toHaveLength(7)
    for (const done of release.splice(0)) done()
    await flush()
    expect(logins(screen)[0]).toBe('u6')
    expect(logins(screen).at(-1)).toBe('u0')
    screen.update()
    expect(fake.requests).toHaveLength(7)
  })

  it('без сессии статусы не запрашиваются', async () => {
    const fake = makeHost({ session: null, prefs: { contactsSort: 'lastSeen' } })
    const screen = new ContactsScreen(fake.host)
    await screen.render()
    expect(fake.requests).toEqual([])
  })
})
