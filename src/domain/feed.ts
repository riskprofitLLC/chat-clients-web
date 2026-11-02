// Лента чата: записи журнала → элементы для показа.
// Реакции и голоса в ленту не попадают (агрегируются у цели), правки и
// закрепы в журнале не лежат вовсе. Чистая логика — тестируется без DOM.
import { parse, type Kind, type Parsed } from '../protocol/codec.js'
import { refOf } from '../protocol/refs.js'
import type { MessageRecord } from '../store/journal.js'

export interface FeedItem {
  record: MessageRecord
  parsed: Parsed
  kind: Kind | null
  mine: boolean
  ref: string
  timestamp: number
  pinned: boolean
  sending: boolean
}

export interface FeedOptions {
  pinnedRefs?: string[]
  pendingRefs?: Set<string>
  // ответ на конкретное сообщение (для подсветки цели)
  highlightRef?: string | null
}

export async function buildFeed(records: MessageRecord[], myLogin: string, options: FeedOptions = {}): Promise<FeedItem[]> {
  const pinned = new Set(options.pinnedRefs ?? [])
  const out: FeedItem[] = []
  for (const record of records) {
    const parsed = parse(record.content, false)
    if (parsed.kind === 'reaction' || parsed.kind === 'vote') continue
    const ref = await refOf(record.content)
    const kind: Kind | null = parsed.kind === 'content' ? parsed.content : null
    out.push({
      record,
      parsed,
      kind,
      mine: record.from === myLogin,
      ref,
      timestamp: record.timestamp,
      pinned: pinned.has(ref) || pinned.has(`ts:${record.timestamp}`),
      sending: options.pendingRefs?.has(ref) === true,
    })
  }
  return out.sort((a, b) => a.timestamp - b.timestamp)
}

// цель ответа ищется по ссылке, фолбэк — по времени (старые записи)
export function findTarget(items: FeedItem[], targetRef?: string, targetTs?: number): FeedItem | null {
  if (targetRef) {
    const exact = items.find((item) => item.ref === targetRef)
    if (exact) return exact
    const prefixed = items.find((item) => item.ref.startsWith(targetRef) || targetRef.startsWith(item.ref))
    if (prefixed) return prefixed
  }
  if (targetTs) {
    const byTime = items.find((item) => item.timestamp === targetTs)
    if (byTime) return byTime
  }
  return null
}

// краткое превью записи для списка чатов
export function previewOf(item: FeedItem): string {
  const kind = item.kind
  const prefix = item.mine ? 'Вы: ' : ''
  if (!kind) return prefix + 'сообщение'
  switch (kind.kind) {
    case 'text':
      return prefix + kind.text
    case 'reply':
      return prefix + kind.reply.text
    case 'media': {
      const info = kind.info
      if (info.type === 'voice') return prefix + 'голосовое сообщение'
      if (info.type === 'file') return prefix + (info.name ?? 'файл')
      return prefix + 'фото'
    }
    case 'poll':
      return prefix + `опрос: ${kind.poll.question}`
    case 'contact':
      return prefix + `контакт: ${kind.name ?? `@${kind.login}`}`
    case 'geo':
      return prefix + 'геопозиция'
    case 'system':
      if (kind.call) return kind.call.status === 'missed' ? 'пропущенный звонок' : 'звонок'
      if (kind.change) {
        if (kind.change.renameTo) return `${kind.change.sender} переименовал(а) группу`
        if (kind.change.added.length > 0) return `${kind.change.sender} добавил(а) участников`
        if (kind.change.removed.length > 0) return `${kind.change.sender} удалил(а) участника`
        return `${kind.change.sender} изменил(а) группу`
      }
      return kind.text
    default:
      return 'сообщение'
  }
}

export function searchFeed(items: FeedItem[], query: string): FeedItem[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return items
  return items.filter((item) => {
    const kind = item.kind
    if (kind?.kind === 'text') return kind.text.toLowerCase().includes(needle)
    if (kind?.kind === 'reply') return kind.reply.text.toLowerCase().includes(needle)
    if (kind?.kind === 'media') return (kind.info.name ?? '').toLowerCase().includes(needle)
    if (kind?.kind === 'poll') return kind.poll.question.toLowerCase().includes(needle)
    return false
  })
}
