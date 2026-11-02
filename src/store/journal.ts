// Локальная история: живёт ТОЛЬКО на устройстве, записи зашифрованы ключом
// данных (AES-GCM, AAD = chatId). Формат записи и конверт шифрования —
// те же, что в crypto/src/jvmMain/.../MessageStore.kt:
//   запись  = [длина from 2Б][from][timestamp 8Б][content]
//   на диск = IV 12Б || GCM(запись)
// Это сохраняет совместимость переноса истории между Android и web.
import { aesGcmDecrypt, aesGcmEncrypt, randomBytes } from '../crypto/primitives.js'
import { concat, equals, text, utf8 } from '../util/bytes.js'
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

  constructor(
    private readonly kv: Kv,
    private readonly dataKey: Uint8Array,
  ) {
    if (dataKey.length !== 32) throw new Error('ключ данных должен быть 32 байта')
  }

  private metaKey(chatId: string): string {
    return `jm:${chatId}`
  }

  private recordKey(chatId: string, seq: number): string {
    return `j:${chatId}:${padSeq(seq)}`
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

  async append(chatId: string, record: MessageRecord): Promise<void> {
    const meta = await this.meta(chatId)
    const iv = randomBytes(IV_SIZE)
    const sealed = await aesGcmEncrypt(this.dataKey, iv, serialize(record), utf8(chatId))
    await this.kv.put(this.recordKey(chatId, meta.seq), concat(iv, sealed))
    await this.saveMeta(chatId, { count: meta.count + 1, seq: meta.seq + 1 })
  }

  // хвост истории: limit записей без чтения всего журнала
  async history(chatId: string, limit = 100): Promise<MessageRecord[]> {
    if (limit <= 0) return []
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
        this.dataKey,
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
    const entries = await this.kv.list(`j:${chatId}:`)
    let removed = 0
    for (const entry of entries) {
      const record = await this.decodeRecord(chatId, entry.value)
      if (record && predicate(record)) {
        await this.kv.delete(entry.key)
        removed++
      }
    }
    if (removed > 0) {
      const meta = await this.meta(chatId)
      await this.saveMeta(chatId, { count: Math.max(0, meta.count - removed), seq: meta.seq })
    }
    return removed
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
    await this.kv.deletePrefix(`j:${chatId}:`)
    await this.kv.delete(this.metaKey(chatId))
    this.metaCache.delete(chatId)
  }

  async wipe(): Promise<void> {
    await this.kv.deletePrefix('j:')
    await this.kv.deletePrefix('jm:')
    this.metaCache.clear()
  }
}
