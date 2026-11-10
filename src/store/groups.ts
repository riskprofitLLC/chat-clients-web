// Группы: сервер о них не знает, определение раздаётся в самих сообщениях.
// Локально храним последнее известное состояние, применяя конверт только
// если его ревизия новее (иначе старый конверт перетирал бы состав).
import { text, utf8 } from '../util/bytes.js'
import type { GroupInfo } from '../protocol/formats.js'
import type { Kv } from './kv.js'

export class GroupsStore {
  constructor(private readonly kv: Kv) {}

  private key(groupId: string): string {
    return `group:${groupId}`
  }

  async get(groupId: string): Promise<GroupInfo | null> {
    const raw = await this.kv.get(this.key(groupId))
    if (!raw) return null
    try {
      return JSON.parse(text(raw)) as GroupInfo
    } catch {
      return null
    }
  }

  // применяет определение, если ревизия не старше известной; возвращает
  // актуальное состояние (или null, если конверт устарел и группы нет)
  async apply(info: GroupInfo): Promise<GroupInfo | null> {
    const existing = await this.get(info.id)
    if (existing && info.rev < existing.rev) return existing
    await this.kv.put(this.key(info.id), utf8(JSON.stringify(info)))
    return info
  }

  async remove(groupId: string): Promise<void> {
    await this.kv.delete(this.key(groupId))
  }

  async all(): Promise<GroupInfo[]> {
    const entries = await this.kv.list('group:')
    const out: GroupInfo[] = []
    for (const entry of entries) {
      try {
        out.push(JSON.parse(text(entry.value)) as GroupInfo)
      } catch {
        // битое определение группы не роняет список
      }
    }
    return out
  }
}
