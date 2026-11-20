// Локальный блок-лист отправителей (P-W5→P-W4): блобы таких отправителей
// сбрасываются при дрейне (доставка подтверждается — у отправителя не
// копятся ретраи), в журнал не пишутся и уведомлений не дают.
import { utf8 } from '../util/bytes.js'
import type { Kv } from './kv.js'

const PREFIX = 'blk:'

// логин сравниваем в нижнем регистре: «Bob» и «bob» — один аккаунт
export function normalizeLogin(login: string): string {
  return login.trim().toLowerCase()
}

export class BlockedSendersStore {
  constructor(private readonly kv: Kv) {}

  private key(login: string): string {
    return `${PREFIX}${normalizeLogin(login)}`
  }

  async isBlocked(login: string): Promise<boolean> {
    return (await this.kv.get(this.key(login))) !== null
  }

  async block(login: string): Promise<void> {
    const normalized = normalizeLogin(login)
    if (!normalized) throw new Error('некорректный отправитель')
    await this.kv.put(this.key(normalized), utf8('1'))
  }

  async unblock(login: string): Promise<void> {
    await this.kv.delete(this.key(login))
  }

  async all(): Promise<string[]> {
    const entries = await this.kv.list(PREFIX)
    return entries.map((entry) => entry.key.slice(PREFIX.length)).sort()
  }
}
