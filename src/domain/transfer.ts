// Перенос истории между устройствами — порт domain/TransferCodec.kt.
// Принимается ТОЛЬКО от своего логина (проверяет вызывающий по from кадра).
import { fromBase64, toBase64 } from '../util/b64.js'
import { text, utf8 } from '../util/bytes.js'

export interface TransferItem {
  chat: string
  from: string
  ts: number
  content: Uint8Array
}

export const MAX_RECORDS = 50_000
const MAX_RECORD_BYTES = 10 * 1024 * 1024
const MAX_TOTAL_BYTES = 400 * 1024 * 1024
export const CHUNK_RECORDS = 200
const CHUNK_BYTES = 6 * 1024 * 1024

const chatRe = /^([a-z0-9_-]{3,32}|grp_[a-z0-9_-]{1,48})$/
const loginRe = /^[a-z0-9_-]{3,32}$/

export class TransferMalformed extends Error {}

// режем записи на чанки по числу и суммарному размеру: один блоб ≤ 10 МБ
export function chunkItems(items: TransferItem[]): TransferItem[][] {
  const out: TransferItem[][] = []
  let current: TransferItem[] = []
  let size = 0
  for (const item of items) {
    if (current.length > 0 && (current.length >= CHUNK_RECORDS || size + item.content.length > CHUNK_BYTES)) {
      out.push(current)
      current = []
      size = 0
    }
    current.push(item)
    size += item.content.length
  }
  if (current.length > 0) out.push(current)
  return out
}

export function encodeChunk(items: TransferItem[]): Uint8Array {
  return utf8(
    JSON.stringify(
      items.map((item) => ({
        chat: item.chat,
        from: item.from,
        ts: item.ts,
        content: toBase64(item.content),
      })),
    ),
  )
}

export function decodeChunk(json: Uint8Array, myLogin: string): TransferItem[] {
  let raw: unknown
  try {
    raw = JSON.parse(text(json))
  } catch {
    throw new TransferMalformed('перенос: битый JSON')
  }
  if (!Array.isArray(raw)) throw new TransferMalformed('перенос: не массив')
  if (raw.length > MAX_RECORDS) throw new TransferMalformed('перенос: слишком много записей')
  const out: TransferItem[] = []
  let total = 0
  for (const entry of raw as Array<Record<string, unknown>>) {
    const chat = String(entry.chat ?? '')
    const from = String(entry.from ?? '')
    const ts = Number(entry.ts ?? -1)
    if (!chatRe.test(chat)) throw new TransferMalformed('перенос: некорректный чат')
    if (!loginRe.test(from)) throw new TransferMalformed('перенос: некорректный автор')
    // 1:1 — автор это я или сам чат; в группе состав уточняется по конверту
    if (!chat.startsWith('grp_') && from !== myLogin && from !== chat) {
      throw new TransferMalformed('перенос: автор вне чата')
    }
    if (!(ts > 0)) throw new TransferMalformed('перенос: некорректное время')
    const content = fromBase64(String(entry.content ?? ''))
    if (!content || content.length === 0 || content.length > MAX_RECORD_BYTES) {
      throw new TransferMalformed('перенос: некорректный размер записи')
    }
    total += content.length
    if (total > MAX_TOTAL_BYTES) throw new TransferMalformed('перенос: превышен объём')
    out.push({ chat, from, ts, content })
  }
  return out
}
