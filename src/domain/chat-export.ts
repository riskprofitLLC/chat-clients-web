// Экспорт и импорт истории чата (P-W2): чистые сборка и разбор файла.
// Формат — JSON с содержимым записей журнала в base64: импорт кладёт те же
// байты обратно, поэтому round-trip не теряет и не меняет историю.
import { fromBase64, toBase64 } from '../util/b64.js'
import { innerContent, parse } from '../protocol/codec.js'
import { refOf } from '../protocol/refs.js'
import type { MessageRecord } from '../store/journal.js'

export const EXPORT_FORMAT = 'chat-history'
export const EXPORT_VERSION = 1

export interface ExportMessage {
  from: string
  ts: number
  // конверт записи журнала в base64 — как есть, без перекодировки
  content: string
}

export interface ExportMedia {
  id: string
  mime?: string
  name?: string
  // блоб из кэша медиа в base64 — опционально, по желанию пользователя
  data: string
}

export interface ExportFile {
  format: typeof EXPORT_FORMAT
  version: number
  chatId: string
  login: string
  exportedAt: number
  count: number
  messages: ExportMessage[]
  media?: ExportMedia[]
}

export interface ExportInput {
  chatId: string
  login: string
  records: readonly MessageRecord[]
  // медиа из кэша: id → блоб; отсутствующие в кэше записи не экспортируются
  media?: ReadonlyMap<string, Uint8Array>
  now?: number
}

// файл выгрузки: записи по возрастанию времени, мета — шапкой
export function buildExport(input: ExportInput): ExportFile {
  const messages = [...input.records]
    .sort((a, b) => a.timestamp - b.timestamp)
    .map((record) => ({ from: record.from, ts: record.timestamp, content: toBase64(record.content) }))
  const media = exportMedia(input.records, input.media)
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    chatId: input.chatId,
    login: input.login,
    exportedAt: input.now ?? Date.now(),
    count: messages.length,
    messages,
    ...(media.length > 0 ? { media } : {}),
  }
}

// id медиа записей истории — по ним UI тянет блобы из кэша
export function mediaIdsOf(records: readonly MessageRecord[]): string[] {
  const out: string[] = []
  for (const record of records) {
    const parsed = parse(innerContent(record.content), false)
    if (parsed.kind !== 'content' || parsed.content.kind !== 'media') continue
    if (!out.includes(parsed.content.info.id)) out.push(parsed.content.info.id)
  }
  return out
}

// медиа записи истории, которые есть в кэше — их и берём в файл
function exportMedia(records: readonly MessageRecord[], cache?: ReadonlyMap<string, Uint8Array>): ExportMedia[] {
  if (!cache || cache.size === 0) return []
  const out: ExportMedia[] = []
  for (const record of records) {
    const parsed = parse(innerContent(record.content), false)
    if (parsed.kind !== 'content' || parsed.content.kind !== 'media') continue
    const info = parsed.content.info
    const blob = cache.get(info.id)
    if (!blob) continue
    out.push({
      id: info.id,
      ...(info.mime ? { mime: info.mime } : {}),
      ...(info.name ? { name: info.name } : {}),
      data: toBase64(blob),
    })
  }
  return out
}

export function serializeExport(file: ExportFile): string {
  return JSON.stringify(file)
}

// разбор файла выгрузки с валидацией; null — файл не нашего формата или битый.
// Битые отдельные записи отсеиваем, а не бракуем весь файл.
export function parseExport(raw: string): ExportFile | null {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return null
}  if (!json || typeof json !== 'object') return null
  const file = json as Partial<ExportFile>
  if (file.format !== EXPORT_FORMAT) return null
  if (file.version !== EXPORT_VERSION) return null
  if (!Array.isArray(file.messages)) return null
  const messages: ExportMessage[] = []
  for (const entry of file.messages) {
    if (!entry || typeof entry !== 'object') continue
    const message = entry as Partial<ExportMessage>
    if (typeof message.from !== 'string' || typeof message.ts !== 'number') continue
    if (!Number.isFinite(message.ts) || message.ts <= 0) continue
    if (typeof message.content !== 'string' || !message.content) continue
    // проверяем декодируемостью, но храним исходную base64-строку
    const decoded = fromBase64(message.content)
    if (!decoded || decoded.length === 0) continue
    messages.push({ from: message.from.slice(0, 128), ts: Math.floor(message.ts), content: message.content })
  }
  const media: ExportMedia[] = []
  if (Array.isArray(file.media)) {
    for (const entry of file.media) {
      if (!entry || typeof entry !== 'object') continue
      const item = entry as Partial<ExportMedia>
      if (typeof item.id !== 'string' || !item.id) continue
      if (typeof item.data !== 'string' || !item.data) continue
      const decoded = fromBase64(item.data)
      if (!decoded || decoded.length === 0) continue
      media.push({
        id: item.id.slice(0, 128),
        ...(typeof item.mime === 'string' ? { mime: item.mime.slice(0, 128) } : {}),
        ...(typeof item.name === 'string' ? { name: item.name.slice(0, 256) } : {}),
        data: item.data,
      })
    }
  }
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    chatId: typeof file.chatId === 'string' ? file.chatId.slice(0, 128) : '',
    login: typeof file.login === 'string' ? file.login.slice(0, 128) : '',
    exportedAt: typeof file.exportedAt === 'number' && Number.isFinite(file.exportedAt) ? file.exportedAt : 0,
    count: messages.length,
    messages,
    ...(media.length > 0 ? { media } : {}),
  }
}

// записи файла как записи журнала — те же байты, что были при выгрузке.
// Недекодируемые строки отфильтрованы разбором, поэтому пустых не будет.
export function recordsOf(file: ExportFile): MessageRecord[] {
  const out: MessageRecord[] = []
  for (const message of file.messages) {
    const content = fromBase64(message.content)
    if (!content || content.length === 0) continue
    out.push({ from: message.from, timestamp: message.ts, content })
  }
  return out
}

export interface ImportPlan {
  // записей в файле
  total: number
  // новых (в чате ещё нет): их и добавляем
  fresh: MessageRecord[]
  // дубли по ключу дедупа журнала (автор + ref содержимого)
  duplicates: number
}

// план импорта с дедупом по тому же ключу, что и журнал при приёме:
// повторный импорт того же файла ничего не дублирует.
// known — ключи «чат:автор:ref», которые уже есть в журнале.
// план импорта с дедупом по тому же ключу, что и журнал при приёме:
// повторный импорт того же файла ничего не дублирует.
// known — ключи «чат:автор:ref», которые уже есть в журнале.
export async function planImport(file: ExportFile, known?: ReadonlySet<string>): Promise<ImportPlan> {
  const seen = new Set<string>()
  const fresh: MessageRecord[] = []
  let duplicates = 0
  for (const record of recordsOf(file)) {
    const key = await dedupeKey(file.chatId, record)
    if (known?.has(key) || seen.has(key)) {
      duplicates++
      continue
    }
    seen.add(key)
    fresh.push(record)
  }
  return { total: file.messages.length, fresh, duplicates }
}

// ключ дедупа журнала: чат + автор + ref содержимого
export async function dedupeKey(chatId: string, record: MessageRecord): Promise<string> {
  return `${chatId}:${record.from}:${await refOf(record.content)}`
}
