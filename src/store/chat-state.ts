// Локальное состояние чата: черновики, закрепы, отметки прочтения,
// список скрытых чатов, счётчики непрочитанных и кэш расшифрованных медиа.
import { text, utf8 } from '../util/bytes.js'
import type { Kv } from './kv.js'

export class DraftsStore {
  constructor(private readonly kv: Kv) {}

  async set(chatId: string, value: string, at = Date.now()): Promise<void> {
    if (!value) {
      await this.kv.delete(`draft:${chatId}`)
      return
    }
    await this.kv.put(`draft:${chatId}`, utf8(JSON.stringify({ text: value.slice(0, 4096), at })))
  }

  async get(chatId: string): Promise<{ text: string; at: number } | null> {
    const raw = await this.kv.get(`draft:${chatId}`)
    if (!raw) return null
    try {
      return JSON.parse(text(raw)) as { text: string; at: number }
    } catch {
      return null
    }
  }

  async all(): Promise<Map<string, { text: string; at: number }>> {
    const out = new Map<string, { text: string; at: number }>()
    for (const entry of await this.kv.list('draft:')) {
      try {
        out.set(entry.key.slice(6), JSON.parse(text(entry.value)) as { text: string; at: number })
      } catch {
        // битый черновик пропускаем
      }
    }
    return out
  }
}

export class PinsStore {
  constructor(private readonly kv: Kv) {}

  async set(chatId: string, refs: string[]): Promise<void> {
    if (refs.length === 0) {
      await this.kv.delete(`pin:${chatId}`)
      return
    }
    await this.kv.put(`pin:${chatId}`, utf8(JSON.stringify(refs)))
  }

  async get(chatId: string): Promise<string[]> {
    const raw = await this.kv.get(`pin:${chatId}`)
    if (!raw) return []
    try {
      const parsed = JSON.parse(text(raw)) as unknown
      return Array.isArray(parsed) ? parsed.map(String) : []
    } catch {
      return []
    }
  }
}

// отметка «прочитано мной до ts» и «доставлено до ts» по чату
export interface ChatMark {
  readAt: number
  deliveredAt: number
}

export class MarksStore {
  constructor(private readonly kv: Kv) {}

  async get(chatId: string): Promise<ChatMark> {
    const raw = await this.kv.get(`read:${chatId}`)
    if (!raw) return { readAt: 0, deliveredAt: 0 }
    try {
      return JSON.parse(text(raw)) as ChatMark
    } catch {
      return { readAt: 0, deliveredAt: 0 }
    }
  }

  async patch(chatId: string, changes: Partial<ChatMark>): Promise<ChatMark> {
    const next = { ...(await this.get(chatId)), ...changes }
    await this.kv.put(`read:${chatId}`, utf8(JSON.stringify(next)))
    return next
  }

  async all(): Promise<Map<string, ChatMark>> {
    const out = new Map<string, ChatMark>()
    for (const entry of await this.kv.list('read:')) {
      try {
        out.set(entry.key.slice(5), JSON.parse(text(entry.value)) as ChatMark)
      } catch {
        // битая отметка — считаем чат непрочитанным
      }
    }
    return out
  }
}

// кэш расшифрованных медиа: сервер отдаёт блоб один раз, дальше играем локально
export class MediaCache {
  constructor(private readonly kv: Kv, private readonly limitBytes = 64 * 1024 * 1024) {}

  async put(id: string, data: Uint8Array): Promise<void> {
    await this.kv.put(`media:${id}`, data)
    await this.enforceLimit()
  }

  async get(id: string): Promise<Uint8Array | null> {
    return this.kv.get(`media:${id}`)
  }

  async has(id: string): Promise<boolean> {
    return (await this.kv.get(`media:${id}`)) !== null
  }

  async remove(id: string): Promise<void> {
    await this.kv.delete(`media:${id}`)
  }

  // потолок кэша: удаляем произвольные записи, пока не влезли.
  // Точный LRU не нужен: блобы на сервере живут 30 дней и качаются заново.
  private async enforceLimit(): Promise<void> {
    const entries = await this.kv.list('media:')
    let total = 0
    for (const entry of entries) total += entry.value.length
    if (total <= this.limitBytes) return
    for (const entry of entries) {
      if (total <= this.limitBytes) break
      await this.kv.delete(entry.key)
      total -= entry.value.length
    }
  }
}

// настройки звонков: журнал последних звонков для карточки в списке чатов
export interface CallLogEntry {
  callId: string
  peer: string
  outgoing: boolean
  status: 'missed' | 'completed' | 'declined' | 'canceled'
  at: number
  seconds: number
}

export class CallLogStore {
  constructor(private readonly kv: Kv) {}

  async add(entry: CallLogEntry): Promise<void> {
    await this.kv.put(`call:${String(entry.at).padStart(15, '0')}:${entry.callId}`, utf8(JSON.stringify(entry)))
  }

  async all(): Promise<CallLogEntry[]> {
    const entries = await this.kv.list('call:', { reverse: true, limit: 200 })
    const out: CallLogEntry[] = []
    for (const entry of entries) {
      try {
        out.push(JSON.parse(text(entry.value)) as CallLogEntry)
      } catch {
        // битая запись журнала звонков не критична
      }
    }
    return out
  }

  async forChat(chatId: string): Promise<CallLogEntry[]> {
    return (await this.all()).filter((e) => e.peer === chatId)
  }
}
