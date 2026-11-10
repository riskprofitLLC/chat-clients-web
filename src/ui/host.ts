// Контракт между оболочкой и экранами: состояние, навигация и данные.
// Экраны не знают про Messenger напрямую — только через host.
import type { AppContext } from '../app/context.js'
import type { ChatSnapshot, ChatSummary } from '../domain/messenger.js'
import type { FeedItem } from '../domain/feed.js'
import type { CallView } from '../calls/manager.js'
import type { Store } from './state/store.js'
import type { PendingSend } from '../store/outbox.js'

export type Route =
  | { name: 'login' }
  | { name: 'chats' }
  | { name: 'dialog'; chatId: string }
  | { name: 'settings' }

export interface UiState {
  route: Route
  connected: boolean
  summaries: ChatSummary[]
  chatId: string | null
  snapshot: ChatSnapshot | null
  chatLoading: boolean
  search: string
  searchOpen: boolean
  replyTo: FeedItem | null
  editTarget: FeedItem | null
  composerDraft: string
  callView: CallView | null
  installAvailable: boolean
  failedSends: Array<PendingSend & { key: string }>
  presence: { online: boolean; lastSeen: number } | null
  reverify: { devices: string[]; isNewDevice: boolean } | null
  theme: 'auto' | 'light' | 'dark'
  accent: string
  /** растёт на каждое событие чата: инвалидирует кэши экранов */
  version: number
}

export interface AppHost {
  readonly ctx: AppContext
  readonly store: Store<UiState>
  readonly state: UiState
  navigate(route: Route): void
  refreshSummaries(): Promise<void>
  refreshDialog(): Promise<void>
  openChat(chatId: string): Promise<void>
  showChats(): void
  showSettings(): void
  toast(message: string, kind?: 'info' | 'error' | 'success'): void
  errorMessage(error: unknown): string
}
