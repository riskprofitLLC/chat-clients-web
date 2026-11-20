// Лента историй: отбор непросроченных, группировка по автору, чистка.
import { describe, expect, it } from 'vitest'
import * as Env from '../src/protocol/envelope.js'
import { mediaInfo, type MediaInfo } from '../src/protocol/formats.js'
import type { MessageRecord } from '../src/store/journal.js'
import { activeStories, groupByAuthor, isStoryMedia, purgeExpired } from '../src/domain/story-feed.js'

const NOW = 1_700_000_000_000

function story(id: string, exp: number, caption?: string): MediaInfo {
  return mediaInfo({
    id,
    key: new Uint8Array(32),
    size: 1024,
    width: 100,
    height: 100,
    thumb: 'dGh1bWI=',
    type: 'media',
    storyExp: exp,
    storyCaption: caption,
  })
}

function record(from: string, timestamp: number, info: MediaInfo): MessageRecord {
  return { from, timestamp, content: Env.encode(Env.TYPE_MEDIA, JSON.stringify({ ...JSON.parse(JSON.stringify(info)), key: '' })) }
}

// дескриптор собираем через MediaJson.encode — он же лежит в конверте сообщения
function mediaRecord(from: string, timestamp: number, info: MediaInfo): MessageRecord {
  return { from, timestamp, content: Env.encode(Env.TYPE_MEDIA, mediaJson(info)) }
}

function mediaJson(info: MediaInfo): string {
  // локальный сборщик JSON дескриптора без зависимости от кодировки base64-ключа
  const json: Record<string, unknown> = {
    type: info.type,
    id: info.id,
    key: Buffer.from(info.key).toString('base64'),
    size: info.size,
    w: info.width,
    h: info.height,
    thumb: info.thumb,
  }
  if (info.storyExp) json.st = info.storyExp
  if (info.storyCaption) json.sc = info.storyCaption
  return JSON.stringify(json)
}

describe('isStoryMedia', () => {
  it('история — медиа со storyExp', () => {
    expect(isStoryMedia(story('a'.repeat(64), NOW + 60_000))).toBe(true)
  })

  it('обычное медиа и файл историей не являются', () => {
    const plain = mediaInfo({ id: 'b'.repeat(64), key: new Uint8Array(32), width: 10, height: 10 })
    expect(isStoryMedia(plain)).toBe(false)
    expect(isStoryMedia(null)).toBe(false)
  })
})

describe('activeStories', () => {
  it('отбирает непросроченные и сортирует по времени', () => {
    const records = [
      mediaRecord('bob', NOW - 5_000, story('c'.repeat(64), NOW + 60_000)),
      mediaRecord('alice', NOW - 60_000, story('d'.repeat(64), NOW + 120_000)),
      mediaRecord('alice', NOW - 30_000, story('e'.repeat(64), NOW - 1)), // истёкшая
      { from: 'bob', timestamp: NOW - 10_000, content: Env.escapeText('просто текст') },
      { from: 'bob', timestamp: NOW - 20_000, content: new Uint8Array([1, 2, 3]) },
      mediaRecord('carol', NOW - 40_000, mediaInfo({ id: 'f'.repeat(64), key: new Uint8Array(32), width: 4, height: 4 })),
    ]
    const items = activeStories(records as MessageRecord[], NOW)
    expect(items.map((i) => i.author)).toEqual(['alice', 'bob'])
    expect(items.map((i) => i.timestamp)).toEqual([NOW - 60_000, NOW - 5_000])
    expect(items[0]!.caption).toBeUndefined()
    expect(items[0]!.exp).toBe(NOW + 120_000)
    expect(items[0]!.media.thumb).toBe('dGh1bWI=')
  })

  it('подпись истории доезжает до элемента', () => {
    const items = activeStories([mediaRecord('bob', NOW - 1_000, story('a'.repeat(64), NOW + 60_000, 'мой день'))], NOW)
    expect(items[0]!.caption).toBe('мой день')
  })

  it('пустой журнал — пустая лента', () => {
    expect(activeStories([], NOW)).toEqual([])
  })
})

describe('groupByAuthor', () => {
  it('группирует по автору и держит порядок добавления', () => {
    const records = [
      mediaRecord('bob', NOW - 5_000, story('a'.repeat(64), NOW + 60_000)),
      mediaRecord('alice', NOW - 6_000, story('b'.repeat(64), NOW + 60_000)),
      mediaRecord('bob', NOW - 7_000, story('c'.repeat(64), NOW + 60_000)),
    ]
    const groups = groupByAuthor(activeStories(records as MessageRecord[], NOW))
    // лента отсортирована по времени: самая ранняя запись — у bob (NOW-7000)
    expect([...groups.keys()]).toEqual(['bob', 'alice'])
    expect(groups.get('bob')!.map((i) => i.timestamp)).toEqual([NOW - 7_000, NOW - 5_000])
    expect(groups.get('alice')).toHaveLength(1)
    void record
})
})

describe('purgeExpired', () => {
  it('считает только истёкшие записи', () => {
    const items = activeStories(
      [
        mediaRecord('bob', NOW - 1_000, story('a'.repeat(64), NOW + 60_000)),
        mediaRecord('bob', NOW - 2_000, story('b'.repeat(64), NOW - 1_000)),
      ] as MessageRecord[],
      NOW,
    )
    // вторая запись истекла и в ленту не попадает — проверим purge на сыром списке
    expect(purgeExpired(items, NOW)).toBe(0)
    expect(purgeExpired([...items, { ...items[0]!, exp: NOW - 5 }], NOW)).toBe(1)
  })
})