import { describe, expect, it } from 'vitest'
import { classifyItem, chatsShown, filterByTab, hasLink } from '../src/domain/search-tabs.js'
import type { FeedItem } from '../src/domain/feed.js'
import { mediaInfo } from '../src/protocol/formats.js'

// табы типов результата поиска: чистая классификация и фильтрация ленты
function item(kind: FeedItem['kind']): FeedItem {
  return {
    record: { from: 'u', content: new Uint8Array(), timestamp: 1 },
    parsed: { kind: 'content', content: kind! },
    kind,
    mine: false,
    ref: 'r',
    timestamp: 1,
    pinned: false,
    sending: false,
  }
}

const text = (value: string) => item({ kind: 'text', text: value, edited: false })
const media = (mime?: string, name?: string) =>
  item({ kind: 'media', info: mediaInfo({ id: 'a'.repeat(64), key: new Uint8Array(), mime, name }) })
const file = (name: string) => item({ kind: 'media', info: mediaInfo({ id: 'a'.repeat(64), key: new Uint8Array(), type: 'file', name }) })

describe('классификация результата поиска', () => {
  it('фото, видео и GIF — медиа', () => {
    expect(classifyItem(media('image/jpeg'))).toBe('media')
    expect(classifyItem(media('video/mp4'))).toBe('media')
    expect(classifyItem(media('image/gif'))).toBe('media')
  })

  it('документ — файл', () => {
    expect(classifyItem(file('отчёт.pdf'))).toBe('files')
  })

  it('текст со ссылкой — ссылки', () => {
    expect(classifyItem(text('смотри https://example.com/x'))).toBe('links')
    expect(classifyItem(text('тут www.example.com'))).toBe('links')
  })

  it('обычный текст — сообщения', () => {
    expect(classifyItem(text('привет'))).toBe('messages')
  })

  it('ссылка только по границе слова', () => {
    expect(hasLink('myhttps://x awww.site')).toBe(false)
    expect(hasLink('зайди на https://x')).toBe(true)
    expect(hasLink(null)).toBe(false)
  })
})

describe('табы над результатами', () => {
  const items = [text('привет'), media('image/jpeg'), text('сайт www.x'), file('док.pdf'), media('video/mp4')]

  it('без таба и на «Сообщения» — вся выдача', () => {
    expect(filterByTab(items, null, classifyItem)).toEqual(items)
    expect(filterByTab(items, 'messages', classifyItem)).toEqual(items)
  })

  it('«Чаты» скрывает сообщения и показывает секцию чатов', () => {
    expect(filterByTab(items, 'chats', classifyItem)).toEqual([])
    expect(chatsShown('chats')).toBe(true)
    expect(chatsShown(null)).toBe(true)
  })

  it('таб типа фильтрует выдачу и прячет чаты', () => {
    expect(filterByTab(items, 'media', classifyItem)).toEqual([items[1], items[4]])
    expect(filterByTab(items, 'files', classifyItem)).toEqual([items[3]])
    expect(filterByTab(items, 'links', classifyItem)).toEqual([items[2]])
    expect(chatsShown('media')).toBe(false)
  })
})