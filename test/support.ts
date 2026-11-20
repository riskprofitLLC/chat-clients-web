// Общие помощники DOM-тестов оформления: мок хоста, состояние, префиксы.
import { Store } from '../src/ui/state/store.js'
import { MemoryKv } from '../src/store/kv.js'
import { ChatFlagsStore } from '../src/store/chat-flags.js'
import * as Env from '../src/protocol/envelope.js'
import { parse } from '../src/protocol/codec.js'
import type { AppHost, UiState } from '../src/ui/host.js'
import type { ChatSummary } from '../src/domain/messenger.js'
import type { Prefs } from '../src/store/prefs.js'
import { DEFAULT_STUN_URL } from '../src/store/prefs.js'

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

export function baseState(summaries: ChatSummary[]): UiState {
  return {
    route: { name: 'chats' },
    connected: true,
    summaries,
    chatId: '',
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

export function summary(over: Partial<ChatSummary>): ChatSummary {
  const from = over.lastRecord?.from ?? 'bob'
  const content = Env.escapeText('привет')
  const parsed = parse(content)
  const record: ChatSummary = {
    chatId: 'bob',
    title: 'Боб',
    isGroup: false,
    lastRecord: { from, timestamp: 1_700_000_000_000, content },
    lastKind: parsed.kind === 'content' ? parsed.content : null,
    lastTs: 1_700_000_000_000,
    unread: 0,
    draft: '',
    pinned: [],
    typing: false,
    members: 2,
    profileBio: '',
    ...over,
  }
  // kind последней записи считаем по её содержимому — иначе превью даст «сообщение»
  const lastParsed = parse(record.lastRecord!.content)
  return { ...record, lastKind: lastParsed.kind === 'content' ? lastParsed.content : record.lastKind }
}

export function makeHost(summaries: ChatSummary[], login = 'me'): AppHost {
  const store = new Store<UiState>(baseState(summaries))
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
    showCalls: () => undefined,
    showContacts: () => undefined,
    toast: () => undefined,
    errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
  }
  const ctx = {
    chatFlags: new ChatFlagsStore(new MemoryKv()),
    prefs: PREFS,
    storagePersisted: true,
    session: { login },
    messenger: null,
    drafts: { get: async () => null },
    savePrefs: async () => undefined,
  }
  return { ...host, ctx } as unknown as AppHost
}
