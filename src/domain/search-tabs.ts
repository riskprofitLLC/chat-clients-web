// Табы типов результата поиска: чистая классификация элемента ленты и
// фильтрация выдачи без повторных запросов. Аналог android SearchResultKind.
import type { FeedItem } from './feed.js'

export type SearchTab = 'chats' | 'messages' | 'media' | 'links' | 'files'

// ссылка в тексте — http(s):// или www. в начале слова
const linkRe = /(?<![\p{L}\p{N}])(https?:\/\/|www\.)/iu

export function hasLink(text: string | null | undefined): boolean {
  return text != null && linkRe.test(text)
}

function isVisual(mime: string | null | undefined): boolean {
  return mime?.startsWith('image/') === true || mime?.startsWith('video/') === true || mime === 'image/gif'
}

// текст элемента ленты — по нему ищутся и ссылки, и медиа без подписи
function textOf(item: FeedItem): string {
  const kind = item.kind
  if (!kind) return ''
  if (kind.kind === 'text') return kind.text
  if (kind.kind === 'reply') return kind.reply.text
  if (kind.kind === 'media') return kind.info.name ?? ''
  if (kind.kind === 'poll') return kind.poll.question
  if (kind.kind === 'contact') return kind.name ?? kind.login
  return ''
}

// медиа — фото/видео/GIF, файлы — документы, ссылки — http/www в тексте
export function classifyItem(item: FeedItem): Exclude<SearchTab, 'chats'> {
  const kind = item.kind
  if (kind?.kind === 'media') {
    return isVisual(kind.info.mime) ? 'media' : 'files'
  }
  return hasLink(textOf(item)) ? 'links' : 'messages'
}

// табы над результатами: null — всё вместе; «Чаты» — только секция чатов;
// остальные табы фильтруют по типу. Чистая функция — покрывается vitest.
export function filterByTab<T>(items: T[], tab: SearchTab | null, kindOf: (item: T) => Exclude<SearchTab, 'chats'>): T[] {
  if (tab == null || tab === 'messages') return items
  if (tab === 'chats') return []
  return items.filter((item) => kindOf(item) === tab)
}

// секция чатов видна без таба и на табе «Чаты»
export function chatsShown(tab: SearchTab | null): boolean {
  return tab == null || tab === 'chats'
}