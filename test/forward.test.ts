// Пересылка сообщения (P-W6): payload без группового конверта исходного
// чата, атрибуция исходного автора и её сохранение при повторной пересылке.
import { describe, expect, it } from 'vitest'
import * as Env from '../src/protocol/envelope.js'
import { GroupFormat, MediaJson, PollFormat, ReplyFormat, SystemFormat } from '../src/protocol/formats.js'
import { parse } from '../src/protocol/codec.js'
import { mediaInfo } from '../src/protocol/formats.js'
import { encodeForward, forwardPayload } from '../src/domain/forward.js'

const KEY = new Uint8Array(32).fill(7)

function groupEnvelope(inner: Uint8Array): Uint8Array {
  return GroupFormat.encode(
    {
      id: 'grp_1',
      name: 'Группа',
      members: ['alice', 'bob'],
      rev: 1,
      desc: '',
      slowMode: 0,
      noForward: false,
      admins: ['alice'],
      noReactions: false,
    },
    inner,
  )
}

describe('forwardPayload', () => {
  it('текст едет с атрибуцией автора', () => {
    const payload = forwardPayload(Env.escapeText('привет'), 'alice')
    expect(payload).toEqual({ kind: 'text', text: 'привет', fwd: 'alice' })
  })

  it('ответ пересылается своим текстом без цитаты, автор — отправитель записи', () => {
    const reply = ReplyFormat.encode('bob', 'цитата чата', 'ref1', 123, 'текст ответа')
    const payload = forwardPayload(reply, 'alice')
    expect(payload).toEqual({ kind: 'text', text: 'текст ответа', fwd: 'alice' })
  })

  it('повторная пересылка сохраняет ИСХОДНОГО автора', () => {
    const first = encodeForward(forwardPayload(Env.escapeText('привет'), 'alice')!)
    const second = forwardPayload(first, 'carol')
    expect(second).toEqual({ kind: 'text', text: 'привет', fwd: 'alice' })
  })

  it('групповой конверт разворачивается: состав чужой группы не утекает', () => {
    const wrapped = groupEnvelope(Env.escapeText('из группы'))
    const payload = forwardPayload(wrapped, 'alice')
    expect(payload).toEqual({ kind: 'text', text: 'из группы', fwd: 'alice' })
  })

  it('медиа едет тем же дескриптором с полем fwd', () => {
    const info = mediaInfo({ id: 'a'.repeat(64), key: KEY, size: 10 })
    const payload = forwardPayload(MediaJson.message(info), 'alice')!
    expect(payload.kind).toBe('media')
    if (payload.kind !== 'media') return
    expect(payload.info.forwardFrom).toBe('alice')
    expect(payload.info.id).toBe(info.id)
  })
  it('keepAuthor=false снимает атрибуцию', () => {
    const payload = forwardPayload(Env.escapeText('привет'), 'alice', false)
    expect(payload).toEqual({ kind: 'text', text: 'привет' })
    const media = forwardPayload(MediaJson.message(mediaInfo({ id: 'b'.repeat(64), key: KEY, forwardFrom: 'alice' })), null, false)!
    expect(media.kind).toBe('media')
    if (media.kind !== 'media') return
    expect(media.info.forwardFrom).toBeUndefined()
  })

  it('опросы и служебные записи не пересылаются', () => {
    const poll = PollFormat.encode('вопрос?', ['да', 'нет'], false)
    expect(forwardPayload(poll, 'alice')).toBeNull()
    expect(forwardPayload(SystemFormat.encode('создана группа'), 'alice')).toBeNull()
  })
})

describe('encodeForward', () => {
  it('текст с автором уходит REPLY-конвертом с полем fwd', () => {
    const content = encodeForward({ kind: 'text', text: 'привет', fwd: 'alice' })
    const envelope = Env.decode(content)!
    expect(envelope.type).toBe(Env.TYPE_REPLY)
    const reply = ReplyFormat.decode(envelope.payload)!
    expect(reply.fwd).toBe('alice')
    expect(reply.text).toBe('привет')
    // цитаты у пересылки нет — получатель видит обычное сообщение
    expect(reply.author).toBe('')
    expect(reply.quote).toBe('')
  })

  it('без автора текст уходит обычным конвертом', () => {
    const content = encodeForward({ kind: 'text', text: 'привет' })
    const parsed = parse(content, false)
    expect(parsed.kind).toBe('content')
    if (parsed.kind !== 'content') return
    expect(parsed.content.kind).toBe('text')
  })

  it('медиа пересланным конвертом читается обратно тем же дескриптором', () => {
    const info = mediaInfo({ id: 'c'.repeat(64), key: KEY, size: 42, type: 'file', name: 'док.pdf' })
    const payload = forwardPayload(MediaJson.message(info), 'alice')!
    const content = encodeForward(payload)
    const parsed = parse(content, false)
    expect(parsed.kind).toBe('content')
    if (parsed.kind !== 'content' || parsed.content.kind !== 'media') return
    expect(parsed.content.info.forwardFrom).toBe('alice')
    expect(parsed.content.info.name).toBe('док.pdf')
    expect(parsed.content.info.size).toBe(42)
  })
})
