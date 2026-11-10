// Outbox (WAL): исходящее сообщение сначала ложится в журнал и в outbox,
// и только потом уходит в сеть. Обрыв связи или закрытие вкладки не теряет
// сообщение — при следующем запуске очередь доигрывается.
//
// Хранится НЕ шифроблоб, а исходный конверт и получатели: при повторной
// отправке состав устройств собеседника перечитывается, и блоб печатается
// заново (устройство могло появиться или смениться).
import { fromBase64, toBase64 } from '../util/b64.js'
import { text, utf8 } from '../util/bytes.js'
import type { Kv } from './kv.js'

export interface PendingSend {
  id: string
  chatId: string
  // получатели-логины: один для 1:1, все участники для группы
  recipients: string[]
  kind: 'chat' | 'transfer'
  // конверт для отправки собеседникам (внутренний контент группового — уже собран)
  contentB64: string
  // копия своего сообщения на свои другие устройства
  sync: boolean
  // локальная запись уже сделана — повтор не должен её дублировать
  localRecord: boolean
  createdAt: number
  attempts: number
  lastError?: string
  lastAttemptAt?: number
  // 4xx — постоянная ошибка: повторять бессмысленно, нужно действие пользователя
  failed?: boolean
}

export class Outbox {
  constructor(private readonly kv: Kv) {}

  private key(id: string): string {
    return `outbox:${String(Date.now()).padStart(15, '0')}:${id}`
  }

  async enqueue(entry: Omit<PendingSend, 'attempts'> & { attempts?: number }): Promise<string> {
    const id = entry.id
    await this.kv.put(this.key(id), utf8(JSON.stringify({ ...entry, attempts: entry.attempts ?? 0 } satisfies PendingSend)))
    return id
  }

  async all(): Promise<Array<PendingSend & { key: string }>> {
    const entries = await this.kv.list('outbox:')
    const out: Array<PendingSend & { key: string }> = []
    for (const entry of entries) {
      try {
        out.push({ ...(JSON.parse(text(entry.value)) as PendingSend), key: entry.key })
      } catch {
        // битая запись очереди не должна блокировать остальные
        await this.kv.delete(entry.key)
      }
    }
    return out
  }

  async remove(key: string): Promise<void> {
    await this.kv.delete(key)
  }

  async bump(key: string, error?: string): Promise<void> {
    const raw = await this.kv.get(key)
    if (!raw) return
    const entry = JSON.parse(text(raw)) as PendingSend
    entry.attempts += 1
    entry.lastError = error
    entry.lastAttemptAt = Date.now()
    await this.kv.put(key, utf8(JSON.stringify(entry)))
  }

  // постоянная ошибка (4xx): больше не пытаемся, ждём «повторить/удалить»
  async markFailed(key: string, error?: string): Promise<void> {
    const raw = await this.kv.get(key)
    if (!raw) return
    const entry = JSON.parse(text(raw)) as PendingSend
    entry.failed = true
    entry.lastError = error
    entry.lastAttemptAt = Date.now()
    await this.kv.put(key, utf8(JSON.stringify(entry)))
  }

  // снять признак «не отправлено» для ручного повтора
  async retry(key: string): Promise<void> {
    const raw = await this.kv.get(key)
    if (!raw) return
    const entry = JSON.parse(text(raw)) as PendingSend
    entry.failed = false
    entry.attempts = 0
    await this.kv.put(key, utf8(JSON.stringify(entry)))
  }

  async count(): Promise<number> {
    return (await this.kv.list('outbox:')).length
  }

  async contentOf(entry: PendingSend): Promise<Uint8Array> {
    const data = fromBase64(entry.contentB64)
    if (!data) throw new Error('битый конверт в очереди отправки')
    return data
  }

  async hasChat(chatId: string): Promise<boolean> {
    return (await this.all()).some((e) => e.chatId === chatId)
  }

  static pack(content: Uint8Array): string {
    return toBase64(content)
  }
}
