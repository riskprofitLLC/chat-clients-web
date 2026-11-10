// Локальная история: живёт ТОЛЬКО на устройстве, записи зашифрованы ключом
// данных (AES-GCM, AAD = chatId). Формат записи и конверт шифрования —
// те же, что в crypto/src/jvmMain/.../MessageStore.kt:
//   запись  = [длина from 2Б][from][timestamp 8Б][content]
//   на диск = IV 12Б || GCM(запись)
// Это сохраняет совместимость переноса истории между Android и web.
import { aesGcmDecrypt, aesGcmEncrypt, randomBytes } from '../crypto/primitives.js'
import { concat, equals, text, utf8 } from '../util/bytes.js'
import { refOf } from '../protocol/refs.js'
import { padSeq, type Kv } from './kv.js'

export interface MessageRecord {
  from: string
  timestamp: number
  content: Uint8Array
}

const IV_SIZE = 12

function serialize(record: MessageRecord): Uint8Array {
  const from = utf8(record.from)
  if (from.length > 65535) throw new Error('слишком длинный отправитель')
  const head = new Uint8Array(10)
  head[0] = (from.length >> 8) & 0xff
  head[1] = from.length & 0xff
  let ts = record.timestamp
  for (let i = 9; i >= 2; i--) {
    head[i] = ts & 0xff
    ts = Math.floor(ts / 256)
  }
  return concat(head, from, record.content)
}

function deserialize(body: Uint8Array): MessageRecord {
  const fromLen = ((body[0] & 0xff) << 8) | (body[1] & 0xff)
  const from = text(body.subarray(10, 10 + fromLen))
  let ts = 0
  for (let i = 2; i < 10; i++) ts = ts * 256 + (body[i] & 0xff)
  return { from, timestamp: ts, content: body.subarray(10 + fromLen) }
}

interface ChatMeta {
  count: number
  seq: number
}

export class Journal {
  private readonly metaCache = new Map<string, ChatMeta>()
  // мьютекс на чат: параллельные append (дрейн, отправка, sync) иначе
  // получают один и тот же seq и затирают друг друга
  private readonly chains = new Map<string, Promise<unknown>>()
  // пока ключа данных нет, журнал заблокирован: писать «на нулевом ключе»
  // нельзя — это молча ломало бы и чтение, и запись истории
  private dataKey: Uint8Array | null = null

  constructor(
    private readonly kv: Kv,
    dataKey: Uint8Array | null = null,
  ) {
    if (dataKey) this.unlock(dataKey)
  }

  get locked(): boolean {
    return this.dataKey === null
  }

  // ключ данных приходит после входа/регистрации/привязки
  unlock(dataKey: Uint8Array): void {
    if (dataKey.length !== 32) throw new Error('ключ данных должен быть 32 байта')
    this.dataKey = dataKey
  }

  private key(): Uint8Array {
    if (!this.dataKey) throw new Error('журнал недоступен: нет ключа данных — войдите заново')
    return this.dataKey
  }

  private metaKey(chatId: string): string {
    return `jm:${chatId}`
  }

  private recordKey(chatId: string, seq: number): string {
    return `j:${chatId}:${padSeq(seq)}`
  }

  private dedupeKey(chatId: string, from: string, ref: string): string {
    return `jr:${chatId}:${from}:${ref}`
  }

  // сериализация операций по чату: цепочка промисов сохраняет порядок
  private withChatLock<T>(chatId: string, run: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(chatId) ?? Promise.resolve()
    const next = previous.then(run, run)
    this.chains.set(chatId, next.then(() => undefined, () => undefined))
    return next
  }

  private async meta(chatId: string): Promise<ChatMeta> {
    const cached = this.metaCache.get(chatId)
    if (cached) return cached
    const raw = await this.kv.get(this.metaKey(chatId))
    const meta: ChatMeta = raw ? (JSON.parse(text(raw)) as ChatMeta) : { count: 0, seq: 0 }
    this.metaCache.set(chatId, meta)
    return meta
  }

  private async saveMeta(chatId: string, meta: ChatMeta): Promise<void> {
    this.metaCache.set(chatId, meta)
    await this.kv.put(this.metaKey(chatId), utf8(JSON.stringify(meta)))
  }

  // добавление идемпотентно: запись с тем же (автор, ref содержимого) не
  // дублируется при повторе дрейн/переноса. dedupe:false — для служебных
  // вставок, где совпадение ref законно.
  async append(chatId: string, record: MessageRecord, options: { dedupe?: boolean } = {}): Promise<boolean> {
    return this.withChatLock(chatId, async () => {
      const dedupe = options.dedupe !== false
      const ref = dedupe ? await refOf(record.content) : ''
      if (dedupe) {
        const marker = this.dedupeKey(chatId, record.from, ref)
        if (await this.kv.get(marker)) return false
        await this.kv.put(marker, new Uint8Array([1]))
      }
      const meta = await this.meta(chatId)
      const iv = randomBytes(IV_SIZE)
      const sealed = await aesGcmEncrypt(this.key(), iv, serialize(record), utf8(chatId))
      await this.kv.put(this.recordKey(chatId, meta.seq), concat(iv, sealed))
      await this.saveMeta(chatId, { count: meta.count + 1, seq: meta.seq + 1 })
      return true
    })
  }

  // хвост истории: limit записей без чтения всего журнала
  async history(chatId: string, limit = 100): Promise<MessageRecord[]> {
    if (limit <= 0) return []
    this.key()
    const meta = await this.meta(chatId)
    if (meta.count === 0) return []
    const entries = await this.kv.list(`j:${chatId}:`, { reverse: true, limit })
    const out: MessageRecord[] = []
    for (const entry of entries.reverse()) {
      const record = await this.decodeRecord(chatId, entry.value)
      if (record) out.push(record)
    }
    return out
  }

  async count(chatId: string): Promise<number> {
    return (await this.meta(chatId)).count
  }

  async chatIds(): Promise<string[]> {
    const entries = await this.kv.list('jm:')
    return entries.map((e) => e.key.slice(3)).sort()
  }

  private async decodeRecord(chatId: string, blob: Uint8Array): Promise<MessageRecord | null> {
    if (blob.length < IV_SIZE + 16) return null
    try {
      const plain = await aesGcmDecrypt(
        this.key(),
        blob.subarray(0, IV_SIZE),
        blob.subarray(IV_SIZE),
        utf8(chatId),
      )
      return deserialize(plain)
    } catch {
      // физическая порча строки — запись пропускаем, остальная история жива
      return null
    }
  }

  // удаление по предикату: один проход и одна перезапись набора ключей
  async deleteRecords(chatId: string, predicate: (record: MessageRecord) => boolean): Promise<number> {
    return this.withChatLock(chatId, async () => {
      const entries = await this.kv.list(`j:${chatId}:`)
      let removed = 0
      for (const entry of entries) {
        const record = await this.decodeRecord(chatId, entry.value)
        if (record && predicate(record)) {
          await this.kv.delete(entry.key)
          await this.kv.delete(this.dedupeKey(chatId, record.from, await refOf(record.content)))
          removed++
        }
      }
      if (removed > 0) {
        const meta = await this.meta(chatId)
        await this.saveMeta(chatId, { count: Math.max(0, meta.count - removed), seq: meta.seq })
      }
      return removed
    })
  }

  async deleteRecord(chatId: string, timestamp: number, content: Uint8Array): Promise<boolean> {
    let matched = false
    await this.deleteRecords(chatId, (record) => {
      if (matched || record.timestamp !== timestamp) return false
      if (!equals(record.content, content)) return false
      matched = true
      return true
    })
    return matched
  }

  async clearChat(chatId: string): Promise<void> {
    await this.withChatLock(chatId, async () => {
      await this.kv.deletePrefix(`j:${chatId}:`)
      await this.kv.deletePrefix(`jr:${chatId}:`)
      await this.kv.delete(this.metaKey(chatId))
      this.metaCache.delete(chatId)
    })
  }

  async wipe(): Promise<void> {
    await this.kv.deletePrefix('j:')
    await this.kv.deletePrefix('jm:')
    await this.kv.deletePrefix('jr:')
    this.metaCache.clear()
    this.chains.clear()
  }
}
