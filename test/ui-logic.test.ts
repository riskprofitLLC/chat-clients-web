// Чистая UI-логика без DOM: цитаты, гейт правки, текст уведомления,
// отметки прочтения. Вынесена из экранов специально для тестируемости.
import { describe, expect, it } from 'vitest'
import { parse } from '../src/protocol/codec.js'
import * as Env from '../src/protocol/envelope.js'
import { ReplyFormat, PollFormat } from '../src/protocol/formats.js'
import { notificationBody } from '../src/domain/feed.js'
import type { FeedItem } from '../src/domain/feed.js'
import { canEditMessage, plainText } from '../src/ui/screens/dialog.js'
import { MemoryKv } from '../src/store/kv.js'
import { MarksStore } from '../src/store/chat-state.js'

function itemOf(content: Uint8Array, mine: boolean): FeedItem {
  const parsed = parse(content)
  return {
    record: { from: mine ? 'me' : 'bob', timestamp: 1, content },
    parsed,
    kind: parsed.kind === 'content' ? parsed.content : null,
    mine,
    ref: 'r',
    timestamp: 1,
    pinned: false,
    sending: false,
  }
}

describe('B23: цитата без префикса «Вы:»', () => {
  it('plainText своего текста и ответа не добавляет «Вы: »', () => {
    expect(plainText(itemOf(Env.escapeText('привет'), true))).toBe('привет')
    const reply = ReplyFormat.encode('bob', 'цитата', 'aabbccdd', 1, 'текст ответа')
    expect(plainText(itemOf(reply, true))).toBe('текст ответа')
  })

  it('медиа и опросы падают в превью (там «Вы: » допустимо)', () => {
    const poll = PollFormat.encode('Вопрос?', ['да', 'нет'], false)
    expect(plainText(itemOf(poll, true))).toContain('Вы: ')
  })
})

describe('B24: править только своё текстовое', () => {
  it('своё текстовое и ответ — можно', () => {
    expect(canEditMessage(itemOf(Env.escapeText('привет'), true))).toBe(true)
    const reply = ReplyFormat.encode('bob', 'цитата', 'aabbccdd', 1, 'ответ')
    expect(canEditMessage(itemOf(reply, true))).toBe(true)
  })

  it('чужое, медиа и опросы — нельзя', () => {
    expect(canEditMessage(itemOf(Env.escapeText('привет'), false))).toBe(false)
    const poll = PollFormat.encode('Вопрос?', ['да'], false)
    expect(canEditMessage(itemOf(poll, true))).toBe(false)
  })
})

// как в chatSummaries: последняя запись + её распарсенный вид
function summaryOf(from: string, value: string): Parameters<typeof notificationBody>[1] {
  const content = Env.escapeText(value)
  const parsed = parse(content)
  return {
    lastRecord: { from, timestamp: 1, content },
    lastKind: parsed.kind === 'content' ? parsed.content : null,
  }
}

describe('B37: текст уведомления не светит содержимое без настройки', () => {
  const foreign = summaryOf('bob', 'секрет')
  const own = summaryOf('me', 'моё')

  it('настройка выключена — общий текст', () => {
    expect(notificationBody(false, foreign, 'me')).toBe('Новое сообщение')
  })

  it('своё сообщение (sync-копия) — общий текст, а не «Вы: …»', () => {
    expect(notificationBody(true, own, 'me')).toBe('Новое сообщение')
  })

  it('чужее сообщение при включённой настройке — превью до 120 символов', () => {
    const body = notificationBody(true, summaryOf('bob', 'я'.repeat(200)), 'me')
    expect(body).toHaveLength(120)
    expect(body).not.toContain('Вы')
  })

  it('пустая история — общий текст', () => {
    expect(notificationBody(true, { lastRecord: null, lastKind: null }, 'me')).toBe('Новое сообщение')
  })
})

describe('B29: отметки прочтения для галочек', () => {
  it('peerReadAt/peerDeliveredAt сохраняются и мержатся с readAt', async () => {
    const kv = new MemoryKv()
    const marks = new MarksStore(kv)
    expect(await marks.get('bob')).toEqual({ readAt: 0, deliveredAt: 0 })

    await marks.patch('bob', { readAt: 100 })
    await marks.patch('bob', { peerDeliveredAt: 200 })
    await marks.patch('bob', { peerReadAt: 300 })

    const mark = await marks.get('bob')
    expect(mark.readAt).toBe(100)
    expect(mark.peerDeliveredAt).toBe(200)
    expect(mark.peerReadAt).toBe(300)

    // битый JSON не роняет хранилище
    await kv.put('read:bob', new Uint8Array([1, 2, 3]))
    expect(await marks.get('bob')).toEqual({ readAt: 0, deliveredAt: 0 })
  })
})
