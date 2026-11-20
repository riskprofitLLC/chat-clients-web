// @vitest-environment happy-dom
// Экран контактов: чистая фильтрация/подпись и DOM — список, поиск,
// добавление по логину и по email (дискавери по хэшу).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ContactsScreen, contactTitle, filterContacts, qrPayload } from '../src/ui/screens/contacts.js'
import { Store } from '../src/ui/state/store.js'
import type { AppHost } from '../src/ui/host.js'
import type { UiState } from '../src/ui/host.js'
import type { Contact } from '../src/store/contacts.js'

function contact(login: string, name: string, email?: string): Contact {
  return { login, name, email, updatedAt: 1_700_000_000_000 }
}

const CONTACTS: Contact[] = [
  contact('bob', 'Боб', 'bob@mail.com'),
  contact('alice', 'Алиса'),
  contact('carol', 'Кэрол', 'carol@mail.com'),
]

function baseState(): UiState {
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

interface FakeHost {
  host: AppHost
  store: Store<UiState>
  contacts: Contact[]
  opened: string[]
}

function makeHost(options?: {
  contacts?: Contact[]
  discover?: (token: string, hashes: string[]) => Promise<Array<{ login: string; emailHash: string }>>
  login?: string
}): FakeHost {
  const store = new Store<UiState>(baseState())
  const contacts = [...(options?.contacts ?? CONTACTS)]
  const opened: string[] = []
  const host = {
    store,
    get state() {
      return store.get()
    },
    navigate: () => undefined,
    refreshSummaries: async () => undefined,
    refreshDialog: async () => undefined,
    openChat: async (chatId: string) => {
      opened.push(chatId)
    },
    showChats: () => undefined,
    showContacts: () => undefined,
    showSettings: () => undefined,
    showCalls: () => undefined,
    toast: () => undefined,
    errorMessage: (error: unknown) => (error instanceof Error ? error.message : 'ошибка'),
  }
  const ctx = {
    prefs: { theme: 'auto', accent: 'blue' },
    storagePersisted: true,
    session:
      options?.login === null
        ? null
        : {
            login: options?.login ?? 'me',
            token: 'tok',
            api: { discover: options?.discover ?? (async () => []) },
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
  return { host: { ...host, ctx } as unknown as AppHost, store, contacts, opened }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('фильтр и подпись контакта', () => {
  it('пустой запрос отдаёт все контакты', () => {
    expect(filterContacts(CONTACTS, '')).toHaveLength(3)
    expect(filterContacts(CONTACTS, '   ')).toHaveLength(3)
  })

  it('ищет по имени, логину и email без учёта регистра', () => {
    expect(filterContacts(CONTACTS, 'БОБ').map((c) => c.login)).toEqual(['bob'])
    expect(filterContacts(CONTACTS, 'ALICE').map((c) => c.login)).toEqual(['alice'])
    expect(filterContacts(CONTACTS, 'carol@mail.com').map((c) => c.login)).toEqual(['carol'])
  })

  it('не находит — пустой список', () => {
    expect(filterContacts(CONTACTS, 'никто')).toEqual([])
  })

  it('подпись: имя, а без него — @логин', () => {
    expect(contactTitle(contact('bob', 'Боб'))).toBe('Боб')
    expect(contactTitle(contact('bob', ''))).toBe('@bob')
  })
})

describe('экран контактов: DOM', () => {
  it('рисует строки контактов и открывает чат по тапу', async () => {
    const fake = makeHost()
    const screen = new ContactsScreen(fake.host)
    await screen.render()
    const rows = screen.element.querySelectorAll('.contact-row')
    expect(rows).toHaveLength(3)
    // сортировка по имени включена по умолчанию
    expect(screen.element.querySelector('.chat-title')!.textContent).toBe('Алиса')
    expect(screen.element.querySelector('.chat-preview')!.textContent).toBe('@alice')
    ;(rows[1] as HTMLElement).click()
    expect(fake.opened).toEqual(['bob'])
  })

  it('поиск сужает список, пустое состояние появляется', async () => {
    const fake = makeHost()
    const screen = new ContactsScreen(fake.host)
    await screen.render()
    const input = screen.element.querySelector<HTMLInputElement>('input.search')!
    input.value = 'carol'
    input.dispatchEvent(new Event('input'))
    expect(screen.element.querySelectorAll('.contact-row')).toHaveLength(1)
    expect(screen.element.querySelector('.empty-state')!.classList.contains('hidden')).toBe(true)

    input.value = 'нет-такого'
    input.dispatchEvent(new Event('input'))
    expect(screen.element.querySelectorAll('.contact-row')).toHaveLength(0)
    expect(screen.element.querySelector('.empty-state')!.classList.contains('hidden')).toBe(false)
  })
})

describe('добавление контакта', () => {
  it('по логину: контакт сохраняется и появляется в списке', async () => {
    const fake = makeHost()
    const screen = new ContactsScreen(fake.host)
    await screen.render()
    ;(screen.element.querySelector('.fab') as HTMLElement).click()
    const sheet = document.querySelector('.modal-sheet')!
    const input = sheet.querySelector('input')!
    input.value = 'dave'
    await new Promise((resolve) => setTimeout(resolve, 0))
    ;(sheet.querySelector('.btn.primary') as HTMLElement).click()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(fake.contacts.map((c) => c.login)).toContain('dave')
    expect(screen.element.querySelectorAll('.contact-row')).toHaveLength(4)
  })

  it("email резолвится discover по хэшу", async () => {
    const hashes: string[] = []
    const fake = makeHost({
      discover: async (_token: string, values: string[]) => {
        hashes.push(...values)
        return [{ login: 'erin', emailHash: values[0] ?? '' }]
      },
    })
    const screen = new ContactsScreen(fake.host)
    await screen.render()
    ;(screen.element.querySelector('.fab') as HTMLElement).click()
    const sheet = document.querySelector('.modal-sheet')!
    const input = sheet.querySelector('input')!
    input.value = 'Erin@Mail.com'
    await new Promise((resolve) => setTimeout(resolve, 0))
    ;(sheet.querySelector('.btn.primary') as HTMLElement).click()
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(hashes).toHaveLength(1)
    expect(hashes[0]).toMatch(/^[0-9a-f]{64}$/)
    const added = fake.contacts.find((c) => c.login === 'erin')
    expect(added?.email).toBe('erin@mail.com')
    expect(screen.element.querySelectorAll('.contact-row')).toHaveLength(4)
  })

  it('свой логин контактом не становится', async () => {
    const fake = makeHost({ login: 'me' })
    const screen = new ContactsScreen(fake.host)
    await screen.render()
    ;(screen.element.querySelector('.fab') as HTMLElement).click()
    const sheet = document.querySelector('.modal-sheet')!
    const input = sheet.querySelector('input')!
    input.value = 'me'
    await new Promise((resolve) => setTimeout(resolve, 0))
    ;(sheet.querySelector('.btn.primary') as HTMLElement).click()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(fake.contacts.map((c) => c.login)).not.toContain('me')
    expect(document.querySelector('.field-error')!.classList.contains('hidden')).toBe(false)
  })

  it('qrPayload несёт chat:<логин> как в android', () => {
    expect(qrPayload('Bob')).toBe('chat:bob')
    expect(qrPayload(' bob ')).toBe('chat:bob')
  })
})
