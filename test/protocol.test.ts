import { describe, expect, it } from 'vitest'
import * as Env from '../src/protocol/envelope.js'
import {
  CallFormat,
  DeleteFormat,
  EditFormat,
  GeoFormat,
  GroupFormat,
  MediaJson,
  mediaInfo,
  PinFormat,
  PollFormat,
  ReactionFormat,
  ReplyFormat,
  SyncFormat,
  SystemFormat,
  VoteFormat,
  isValidEmoji,
  type GroupInfo,
} from '../src/protocol/formats.js'
import { MessageCodec, parse } from '../src/protocol/codec.js'
import { refMatches, refOf, sameRef } from '../src/protocol/refs.js'
import { fromBase64, toBase64 } from '../src/util/b64.js'
import { text, utf8 } from '../src/util/bytes.js'

describe('конверт', () => {
  it('v3: магия, тип, печатный id, round-trip', () => {
    const content = Env.encodeBytes(Env.TYPE_TEXT, utf8('привет'))
    expect(content[0]).toBe(0xc5)
    expect(content[1]).toBe(0xa5)
    expect(String.fromCharCode(content[2])).toBe('3')
    expect(String.fromCharCode(content[3])).toBe('t')
    const decoded = Env.decode(content)!
    expect(decoded.type).toBe('t')
    expect(decoded.id).not.toBeNull()
    for (const b of decoded.id!) {
      expect(b).toBeGreaterThanOrEqual(0x21)
      expect(b).toBeLessThanOrEqual(0x7e)
    }
    expect(text(decoded.payload)).toBe('привет')
  })

  it('два одинаковых текста дают разные конверты (уникальный ref)', async () => {
    const a = Env.escapeText('ок')
    const b = Env.escapeText('ок')
    expect(await refOf(a)).not.toBe(await refOf(b))
  })

  it('побег нужен только для текста, похожего на конверт или JSON', () => {
    expect(Env.needsEscape('{json}')).toBe(true)
    expect(Env.needsEscape('обычный текст')).toBe(false)
    expect(Env.needsEscape('{"type":"media"}')).toBe(true)
  })

  it('v2 читается для старых записей', () => {
    const legacy = new Uint8Array([0xc5, 0xa5, 0x32, 0x74, 0x68, 0x69])
    const decoded = Env.decode(legacy)!
    expect(decoded.type).toBe('t')
    expect(decoded.id).toBeNull()
    expect(text(decoded.payload)).toBe('hi')
  })
})

describe('медиа-дескриптор', () => {
  it('фото: id/key/size/размеры/превью, мусор отбрасывается', () => {
    const info = mediaInfo({
      id: 'a'.repeat(64),
      key: new Uint8Array(32).fill(7),
      size: 1234,
      width: 800,
      height: 600,
      thumb: 'AAAA',
    })
    const content = MediaJson.message(info)
    const parsed = MediaJson.parse(Env.decode(content)!.payload)!
    expect(parsed.id).toBe(info.id)
    expect(parsed.key).toEqual(info.key)
    expect(parsed.width).toBe(800)
    expect(parsed.thumb).toBe('AAAA')
    // короткий id — не медиа
    expect(MediaJson.parseText('{"type":"media","id":"ab","key":"","size":1}')).toBeNull()
    // ключ не 32 байта — не медиа
    expect(
      MediaJson.parseText(JSON.stringify({ type: 'media', id: 'a'.repeat(64), key: toBase64(new Uint8Array(16)), size: 1, w: 1, h: 1 })),
    ).toBeNull()
    // текст — не медиа
    expect(MediaJson.parse(utf8('просто текст'))).toBeNull()
  })

  it('файл и голосовое', () => {
    const file = MediaJson.parse(
      Env.decode(
        MediaJson.message(
          mediaInfo({
            id: 'b'.repeat(64),
            key: new Uint8Array(32),
            size: 10,
            type: 'file',
            name: 'отчёт.pdf',
            mime: 'application/pdf',
          }),
        ),
      )!.payload,
    )!
    expect(file.name).toBe('отчёт.pdf')
    expect(file.mime).toBe('application/pdf')
    const voice = MediaJson.parse(
      Env.decode(
        MediaJson.message(
          mediaInfo({
            id: 'c'.repeat(64),
            key: new Uint8Array(32),
            size: 10,
            type: 'voice',
            duration: 7,
            waveform: new Uint8Array([1, 2, 3]),
          }),
        ),
      )!.payload,
    )!
    expect(voice.duration).toBe(7)
    expect(voice.waveform).toEqual(new Uint8Array([1, 2, 3]))
  })
})

describe('ответы, реакции, правки', () => {
  it('ответ с ссылкой на цель', () => {
    const content = ReplyFormat.encode('bob', 'цитата', 'aabbccdd', 123, 'текст ответа')
    const decoded = ReplyFormat.decode(Env.decode(content)!.payload)!
    expect(decoded.author).toBe('bob')
    expect(decoded.quote).toBe('цитата')
    expect(decoded.targetRef).toBe('aabbccdd')
    expect(decoded.text).toBe('текст ответа')
  })

  it('пересылка и тихий текст', () => {
    const fwd = ReplyFormat.decode(Env.decode(ReplyFormat.encodeForward('alice', 'текст'))!.payload)!
    expect(fwd.fwd).toBe('alice')
    expect(fwd.quote).toBe('')
    const silent = ReplyFormat.decode(Env.decode(ReplyFormat.encodeSilent('тсс'))!.payload)!
    expect(silent.silent).toBe(true)
    expect(silent.text).toBe('тсс')
  })

  it('реакция: набор и произвольный эмодзи-кластер', () => {
    const content = ReactionFormat.encode({ ref: 'aabbccdd' }, '👍')
    const decoded = ReactionFormat.decode(Env.decode(content)!.payload)!
    expect(decoded.emoji).toBe('👍')
    expect(decoded.target.ref).toBe('aabbccdd')
    // снятие реакции — пустой эмодзи
    expect(ReactionFormat.decode(Env.decode(ReactionFormat.encode({ ref: 'x' }, ''))!.payload)!.emoji).toBe('')
    // текст вместо эмодзи не проходит
    expect(ReactionFormat.decode(utf8('{"i":"x","e":"привет"}'))).toBeNull()
    expect(isValidEmoji('👨‍👩‍👧')).toBe(true)
    expect(isValidEmoji('abc')).toBe(false)
  })

  it('правка несёт готовые байты нового содержимого', () => {
    const newContent = Env.escapeText('после правки')
    const content = EditFormat.encode('aabbccdd', 1, newContent)
    const decoded = EditFormat.decode(Env.decode(content)!.payload)!
    expect(decoded.newContent).toEqual(newContent)
    expect(MessageCodec.editOf(content)).not.toBeNull()
    expect(MessageCodec.editOf(Env.escapeText('нет'))).toBeNull()
  })

  it('закреп и удаление', () => {
    const pin = PinFormat.encode('aabbccdd', 1, true)
    expect(MessageCodec.pinOf(pin)!.pinned).toBe(true)
    const del = DeleteFormat.encode('aabbccdd', 1)
    expect(MessageCodec.deleteOf(del)!.targetRef).toBe('aabbccdd')
    expect(MessageCodec.deleteOf(Env.escapeText('нет'))).toBeNull()
  })
})

describe('группы', () => {
  const info: GroupInfo = {
    id: 'grp_test1',
    name: 'Тестовая',
    members: ['alice', 'bob'],
    rev: 3,
    desc: 'описание',
    slowMode: 0,
    noForward: false,
    admins: ['alice'],
    noReactions: false,
  }

  it('групповой конверт несёт внутренний текст', () => {
    const inner = Env.escapeText('всем привет')
    const content = GroupFormat.encode(info, inner)
    const parsed = parse(content)
    expect(parsed.kind).toBe('content')
    if (parsed.kind !== 'content') return
    expect(parsed.group!.info.name).toBe('Тестовая')
    expect(parsed.group!.info.rev).toBe(3)
    expect(parsed.content.kind).toBe('text')
    if (parsed.content.kind === 'text') expect(parsed.content.text).toBe('всем привет')
  })

  it('вложенная группа не разбирается дальше глубины 1', () => {
    const inner = GroupFormat.encode(info, Env.escapeText('x'))
    const outer = GroupFormat.encode(info, inner)
    const parsed = parse(outer)
    if (parsed.kind !== 'content') throw new Error('ожидали контент')
    expect(parsed.content.kind).toBe('unsupported')
  })

  it('битые данные — не группа', () => {
    expect(GroupFormat.decodeText('{"g":"grp_ok","n":"имя","m":[],"c":"x"}')).toBeNull()
    expect(GroupFormat.decodeText('{"g":"плохой","n":"имя","m":["alice"],"c":"x"}')).toBeNull()
  })

  it('изменение состава локализуется при показе', () => {
    const content = SystemFormat.encodeChange({
      sender: 'alice',
      added: ['bob'],
      removed: [],
      avatar: false,
    })
    const decoded = SystemFormat.decodeChange(Env.decode(content)!.payload)!
    expect(decoded.added).toEqual(['bob'])
    const parsed = parse(content)
    if (parsed.kind !== 'content' || parsed.content.kind !== 'system') throw new Error('ожидали системную запись')
    expect(parsed.content.change!.added).toEqual(['bob'])
  })
})

describe('звонки, опросы, синк', () => {
  it('событие звонка', () => {
    const content = CallFormat.encode('offer', 'abc12345', 1000, 'v=0...', ['cand1'])
    const decoded = CallFormat.decode(Env.decode(content)!.payload)!
    expect(decoded.ev).toBe('offer')
    expect(decoded.sdp).toBe('v=0...')
    expect(decoded.cands).toEqual(['cand1'])
    expect(CallFormat.decode(utf8('{"e":"nope","id":"abc12345","ts":1}'))).toBeNull()
    expect(CallFormat.decode(utf8('{"e":"offer","id":"ab","ts":1}'))).toBeNull()
    expect(CallFormat.newCallId()).toMatch(/^[a-z0-9]{16}$/)
  })

  it('запись «пропущенный звонок» — системная структура', () => {
    const content = CallFormat.encodeRecord('abc12345', 'missed')
    const parsed = parse(content)
    if (parsed.kind !== 'content' || parsed.content.kind !== 'system') throw new Error('ожидали системную запись')
    expect(parsed.content.call!.callId).toBe('abc12345')
  })

  it('опрос и голос', () => {
    const content = PollFormat.encode('Вопрос?', ['да', 'нет'], true)
    const parsed = parse(content)
    if (parsed.kind !== 'content' || parsed.content.kind !== 'poll') throw new Error('ожидали опрос')
    expect(parsed.content.poll.options).toEqual(['да', 'нет'])
    const vote = VoteFormat.encode('aabbccdd', 1)
    const voteParsed = parse(vote)
    expect(voteParsed.kind).toBe('vote')
  })

  it('синк на свои устройства', () => {
    const inner = Env.escapeText('своё сообщение')
    const content = SyncFormat.encode('bob', inner)
    const decoded = SyncFormat.decode(Env.decode(content)!.payload)!
    expect(decoded.chatId).toBe('bob')
    expect(decoded.content).toEqual(inner)
    expect(SyncFormat.decode(utf8('{"c":"bob","d":"не base64!"}'))).toBeNull()
  })
})

describe('ссылки и гео', () => {
  it('ref совпадает у обеих сторон и матчится по префиксу', async () => {
    const content = Env.escapeText('сообщение')
    const ref = await refOf(content)
    expect(ref).toHaveLength(16)
    expect(await refMatches(ref, content)).toBe(true)
    expect(await refMatches(ref.slice(0, 8), content)).toBe(true)
    expect(await refMatches('deadbeef', content)).toBe(false)
    expect(sameRef(ref.slice(0, 8), ref)).toBe(true)
  })

  it('гео: координаты валидируются', () => {
    const content = GeoFormat.encode(55.755826, 37.6173)
    const point = GeoFormat.decode(Env.decode(content)!.payload)!
    expect(point.lat).toBeCloseTo(55.755826, 6)
    expect(GeoFormat.decode(utf8('{"la":200,"lo":0}'))).toBeNull()
  })

  it('base64 устойчив к мусору и кратен 4', () => {
    expect(fromBase64('abc')).toBeNull()
    expect(fromBase64('!!!!')).toBeNull()
    const data = new Uint8Array([0, 1, 2, 250, 251, 252, 253])
    expect(fromBase64(toBase64(data))).toEqual(data)
  })
})
