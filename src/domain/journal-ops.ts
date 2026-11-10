// Применение правки и «удалить у всех» к локальному журналу — порт
// domain/MessageEdit.kt и domain/MessageDelete.kt. Логика чистая:
// работает поверх абстрактного хранилища, тестируется без браузера.
import * as Env from '../protocol/envelope.js'
import { GroupFormat, type MediaInfo } from '../protocol/formats.js'
import { parse } from '../protocol/codec.js'
import { refMatches, refOf, sameRef } from '../protocol/refs.js'
import { equals } from '../util/bytes.js'
import type { Journal, MessageRecord } from '../store/journal.js'

const SEARCH_WINDOW = 2000

export interface EditEvent {
  targetRef?: string
  targetTs?: number
  newContent: Uint8Array
}

export interface DeleteEvent {
  targetRef?: string
  targetTs?: number
}

// новый контент правки: TYPE_EDITED, для группы — конверт ТОЙ ЖЕ группы
function validNewContent(chatId: string, content: Uint8Array): boolean {
  const envelope = Env.decode(content)
  if (!envelope) return false
  if (envelope.type === Env.TYPE_EDITED) return content.length <= 10 * 1024
  if (envelope.type !== Env.TYPE_GROUP) return false
  if (content.length > 20 * 1024) return false
  const decoded = GroupFormat.decode(envelope.payload)
  if (!decoded || decoded.group.id !== chatId) return false
  return Env.decode(decoded.inner)?.type === Env.TYPE_EDITED
}

async function findTarget(
  history: MessageRecord[],
  targetRef: string | undefined,
  targetTs: number | undefined,
): Promise<MessageRecord | null> {
  const ordered = [...history].sort((a, b) => a.timestamp - b.timestamp)
  for (const record of ordered) {
    if (targetRef && (await refMatches(targetRef, record.content))) return record
  }
  for (const record of ordered) {
    if (targetTs && record.timestamp === targetTs) return record
  }
  return null
}

async function staleReactions(records: MessageRecord[], target: MessageRecord, targetRef?: string): Promise<MessageRecord[]> {
  const targetOwn = await refOf(target.content)
  const out: MessageRecord[] = []
  for (const record of records) {
    const parsed = parse(record.content, false)
    if (parsed.kind === 'reaction') {
      const matchesRef = targetRef !== undefined && parsed.targetRef === targetRef
      const matchesTs = parsed.targetRef === undefined && parsed.targetTs === target.timestamp
      if (matchesRef || matchesTs) out.push(record)
    } else if (parsed.kind === 'vote') {
      if (parsed.vote.targetRef && sameRef(parsed.vote.targetRef, targetOwn)) out.push(record)
    }
  }
  return out
}

// правка применяется ТОЛЬКО к сообщению автора кадра (A4): собеседник
// не может подменить чужой текст
export async function applyEdit(
  journal: Journal,
  chatId: string,
  expectedAuthor: string | null,
  event: EditEvent,
): Promise<boolean> {
  if (!validNewContent(chatId, event.newContent)) return false
  const history = await journal.history(chatId, SEARCH_WINDOW)
  const target = await findTarget(history, event.targetRef, event.targetTs)
  if (!target) return false
  if (expectedAuthor !== null && target.from !== expectedAuthor) return false

  // повтор уже применённой правки: снимаем возможный дубль от обрыва
  if (equals(target.content, event.newContent)) {
    let kept = false
    await journal.deleteRecords(chatId, (record) => {
      if (record.timestamp !== target.timestamp) return false
      if (!equals(record.content, event.newContent)) return false
      if (kept) return true
      kept = true
      return false
    })
    return true
  }

  // сначала новая запись, потом снос старой и реакций: обрыв между шагами
  // оставляет дубль нового текста, а не теряет правку
  await journal.append(chatId, { from: target.from, timestamp: target.timestamp, content: event.newContent })
  const stale = await staleReactions(history, target, event.targetRef)
  let keptNew = false
  await journal.deleteRecords(chatId, (record) => {
    const isOldTarget = record.timestamp === target.timestamp && equals(record.content, target.content)
    const isDuplicateNew =
      !isOldTarget &&
      record.timestamp === target.timestamp &&
      equals(record.content, event.newContent) &&
      (keptNew ? true : ((keptNew = true), false))
    return isOldTarget || isDuplicateNew
  })
  for (const record of stale) await journal.deleteRecord(chatId, record.timestamp, record.content)
  return true
}

export async function applyDelete(
  journal: Journal,
  chatId: string,
  expectedAuthor: string | null,
  event: DeleteEvent,
  admins: Set<string> = new Set(),
): Promise<boolean> {
  const history = await journal.history(chatId, SEARCH_WINDOW)
  const target = await findTarget(history, event.targetRef, event.targetTs)
  if (!target) return false
  // автор события или админ группы (модерация)
  if (expectedAuthor !== null && target.from !== expectedAuthor && !admins.has(expectedAuthor)) return false
  for (const record of await staleReactions(history, target, event.targetRef)) {
    await journal.deleteRecord(chatId, record.timestamp, record.content)
  }
  await journal.deleteRecord(chatId, target.timestamp, target.content)
  return true
}

// аватар-медиа: конверт в журнал не пишется, применяется к профилю
export function avatarOf(info: MediaInfo): { login: string; remove: boolean; emoji?: string } | null {
  const raw = (info as MediaInfo & { avatarOwner?: string; avatarEmoji?: string; avatarRemove?: boolean })
  if (raw.avatarEmoji) return { login: 'grp', remove: false, emoji: raw.avatarEmoji }
  if (raw.avatarOwner) return { login: raw.avatarOwner, remove: raw.avatarRemove === true }
  return null
}
