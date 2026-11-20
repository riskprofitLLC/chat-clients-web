// Экспорт и импорт истории чата (P-W2): чистые сборка/разбор файла,
// round-trip «выгрузка → импорт даёт ту же историю» и дедуп повтора.
import { describe, expect, it } from 'vitest'
import * as Env from '../src/protocol/envelope.js'
import { MediaJson, ReplyFormat, mediaInfo } from '../src/protocol/formats.js'
import { refOf } from '../src/protocol/refs.js'
import type { MessageRecord } from '../src/store/journal.js'
import {
  EXPORT_FORMAT,
  EXPORT_VERSION,
  buildExport,
  dedupeKey,
  mediaIdsOf,
  parseExport,
  planImport,
  recordsOf,
  serializeExport,
} from '../src/domain/chat-export.js'

const KEY = new Uint8Array(32).fill(3)

function records(): MessageRecord[] {
  return [
    { from: 'bob', timestamp: 1_700_000_000_000, content: Env.escapeText('привет') },
    { from: 'me', timestamp: 1_700_000_060_000, content: ReplyFormat.encode('bob', 'привет', 'ref', 1_700_000_000_000, 'и тебе') },
    { from: 'bob', timestamp: 1_700_000_120_000, content: MediaJson.message(mediaInfo({ id: 'a'.repeat(64), key: KEY, size: 5 })) },    { from: 'bob', timestamp: 1_700_000_180_000, content: Env.encode(Env.TYPE_SYSTEM, '{"t":"создана группа"}') },
  ]
}

describe('buildExport', () => {
  it('файл несёт шапку, записи по возрастанию времени и base64 конверты', () => {
    const file = buildExport({ chatId: 'bob', login: 'me', records: records(), now: 1_700_000_200_000 })
    expect(file.format).toBe(EXPORT_FORMAT)
    expect(file.version).toBe(EXPORT_VERSION)
    expect(file.chatId).toBe('bob')
    expect(file.login).toBe('me')
    expect(file.exportedAt).toBe(1_700_000_200_000)
    expect(file.count).toBe(4)
    expect(file.messages.map((m) => m.ts)).toEqual([1_700_000_000_000, 1_700_000_060_000, 1_700_000_120_000, 1_700_000_180_000])
    // бинарный конверт в файле — base64, а не «как есть»
    expect(file.messages[0].content).toMatch(/^[A-Za-z0-9+/=]+$/)
  })

  it('медиа из кэша попадает в файл, отсутствующее — нет', () => {
    const blob = new Uint8Array([1, 2, 3])
    const file = buildExport({
      chatId: 'bob',
      login: 'me',
      records: records(),
      media: new Map([['a'.repeat(64), blob]]),
      now: 1,
    })
    expect(file.media?.length).toBe(1)
    expect(file.media?.[0].id).toBe('a'.repeat(64))
    const empty = buildExport({ chatId: 'bob', login: 'me', records: records(), now: 1 })
    expect(empty.media).toBeUndefined()
  })

  it('mediaIdsOf перечисляет id медиа записей без повторов', () => {
    expect(mediaIdsOf(records())).toEqual(['a'.repeat(64)])
  })
})

describe('parseExport', () => {
  it('round-trip: выгрузка → разбор даёт те же байты и мету', () => {
    const source = records()
    const file = buildExport({ chatId: 'bob', login: 'me', records: source, now: 1_700_000_200_000 })
    const parsed = parseExport(serializeExport(file))!
    expect(parsed).not.toBeNull()
    expect(parsed.count).toBe(file.count)
    expect(recordsOf(parsed)).toEqual(source)
  })

  it('битые записи отсеиваются, а не бракуют файл', () => {
    const file = buildExport({ chatId: 'bob', login: 'me', records: records(), now: 1 })
    const broken = { ...file, messages: [...file.messages, { from: 'bob', ts: 5, content: '!!!не base64!!!' }, { from: 'bob' }] }
    const parsed = parseExport(JSON.stringify(broken))!
    expect(parsed.messages.length).toBe(file.messages.length)
  })

  it('чужой формат и мусор не разбираются', () => {
    expect(parseExport('')).toBeNull()
    expect(parseExport('не json')).toBeNull()
    expect(parseExport(JSON.stringify({ format: 'other', version: 1, messages: [] }))).toBeNull()
    expect(parseExport(JSON.stringify({ format: EXPORT_FORMAT, version: 99, messages: [] }))).toBeNull()
    expect(parseExport(JSON.stringify({ format: EXPORT_FORMAT, version: EXPORT_VERSION }))).toBeNull()
  })
})

describe('planImport', () => {
  it('первый импорт — все записи новые, повторов нет', async () => {
    const file = buildExport({ chatId: 'bob', login: 'me', records: records(), now: 1 })
    const plan = await planImport(file)
    expect(plan.total).toBe(4)
    expect(plan.fresh.length).toBe(4)
    expect(plan.duplicates).toBe(0)
  })

  it('повторный импорт того же файла целиком уходит в дубли', async () => {
    const file = buildExport({ chatId: 'bob', login: 'me', records: records(), now: 1 })
    const known = new Set<string>()
    for (const record of recordsOf(file)) known.add(await dedupeKey(file.chatId, record))
    const plan = await planImport(file, known)
    expect(plan.fresh.length).toBe(0)
    expect(plan.duplicates).toBe(4)
  })

  it('дубли внутри самого файла считаются один раз', async () => {
    const source = records()
    const doubled = [...source, source[0]]
    const file = buildExport({ chatId: 'bob', login: 'me', records: doubled, now: 1 })
    const plan = await planImport(file)
    expect(plan.total).toBe(5)
    expect(plan.fresh.length).toBe(4)
    expect(plan.duplicates).toBe(1)
  })

  it('ключ дедупа журнала совпадает с ключом записи в чате', async () => {
    const record = records()[0]
    expect(await dedupeKey('bob', record)).toBe(`bob:bob:${await refOf(record.content)}`)
  })
})
