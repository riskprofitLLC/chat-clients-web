// Лента историй: чистые функции над записями журнала. История — обычное
// TYPE_MEDIA сообщение с полями storyExp/storyCaption в MediaInfo, поэтому
// отдельного хранилища у историй нет: они живут в истории чата и гаснут сами.
import { parse } from '../protocol/codec.js'
import type { MediaInfo } from '../protocol/formats.js'
import type { MessageRecord } from '../store/journal.js'

export interface StoryItem {
  author: string
  timestamp: number
  /** время истечения (мс), как storyExp в дескрипторе */
  exp: number
  caption?: string
  media: MediaInfo
}

export function isStoryMedia(info: MediaInfo | null | undefined): boolean {
  return !!info && typeof info.storyExp === 'number' && info.storyExp > 0
}

// медиа записи; групповой конверт разворачиваем — история в группе приходит обёрнутой
function storyMediaOf(content: Uint8Array): MediaInfo | null {
  const parsed = parse(content)
  if (parsed.kind !== 'content') return null
  const inner = parsed.group?.inner ?? parsed.content
  return inner.kind === 'media' ? inner.info : null
}

export function activeStories(records: readonly MessageRecord[], now: number): StoryItem[] {
  const out: StoryItem[] = []
  for (const record of records) {
    const media = storyMediaOf(record.content)
    if (!isStoryMedia(media)) continue
    const exp = media!.storyExp ?? 0
    if (exp <= now) continue // истёкшая история не показывается
    out.push({ author: record.from, timestamp: record.timestamp, exp, caption: media!.storyCaption, media: media! })
  }
  return out.sort((a, b) => a.timestamp - b.timestamp)
}

export function groupByAuthor(items: readonly StoryItem[]): Map<string, StoryItem[]> {
  const out = new Map<string, StoryItem[]>()
  for (const item of items) {
    const list = out.get(item.author)
    if (list) list.push(item)
    else out.set(item.author, [item])
  }
  return out
}

// сколько записей надо выбросить при чистке: только истёкшие
export function purgeExpired(items: readonly StoryItem[], now: number): number {
  let count = 0
  for (const item of items) if (item.exp <= now) count += 1
  return count
}

// остаток жизни истории в часах и минутах: формат вывода — на UI-слое,
// а вот арифметика чистая и нужна тестам без DOM
export function storyLeftParts(ms: number): { hours: number; minutes: number } {
  const total = Math.max(0, Math.floor(ms / 1000))
  return { hours: Math.floor(total / 3600), minutes: Math.floor((total % 3600) / 60) }
}
