// Локальные флаги списка чатов: «непрочитано вручную», архив и «без звука».
// Это оформление строки, а не данные переписки: сервер и wire их не знают.
import { text, utf8 } from '../util/bytes.js'
import type { Kv } from './kv.js'

export type ChatFlagKind = 'unread' | 'archive' | 'mute'

export interface ChatFlags {
  // чаты, помеченные непрочитанными вручную
  markedUnread: string[]
  // чаты в архиве: скрыты из основного списка
  archived: string[]
  // чаты без звука: уведомления для них выключены
  muted: string[]
}

const KEY = 'chat-flags'

const EMPTY: ChatFlags = { markedUnread: [], archived: [], muted: [] }

export class ChatFlagsStore {
  constructor(private readonly kv: Kv) {}

  async all(): Promise<ChatFlags> {
    const raw = await this.kv.get(KEY)
    if (!raw) return { ...EMPTY }
    try {
      const parsed = JSON.parse(text(raw)) as Partial<ChatFlags> | null
      if (!parsed || typeof parsed !== 'object') return { ...EMPTY }
      return {
        markedUnread: toStrings(parsed.markedUnread),
        archived: toStrings(parsed.archived),
        muted: toStrings(parsed.muted),
      }
    } catch {
      return { ...EMPTY }
    }
  }

  async set(kind: ChatFlagKind, chatId: string, value: boolean): Promise<ChatFlags> {
    const flags = await this.all()
    const list = kind === 'unread' ? flags.markedUnread : kind === 'archive' ? flags.archived : flags.muted
    const next = value ? [...new Set([...list, chatId])] : list.filter((id) => id !== chatId)
    if (kind === 'unread') flags.markedUnread = next
    else if (kind === 'archive') flags.archived = next
    else flags.muted = next
    await this.kv.put(KEY, utf8(JSON.stringify(flags)))
    return flags
  }

  has(flags: ChatFlags, kind: ChatFlagKind, chatId: string): boolean {
    const list = kind === 'unread' ? flags.markedUnread : kind === 'archive' ? flags.archived : flags.muted
    return list.includes(chatId)
  }
}

function toStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : []
}