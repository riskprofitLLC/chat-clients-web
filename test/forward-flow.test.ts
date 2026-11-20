// Сквозная проверка волны B на реальном Messenger + FakeRelay: пересылка
// уходит штатным механизмом протокола и приходит с метой «Переслано от X»,
// массовое удаление и импорт истории сохраняют журнал.
import { afterEach, describe, expect, it } from 'vitest'
import { MemoryKv } from '../src/store/kv.js'
import { Journal } from '../src/store/journal.js'
import { SecretsStore } from '../src/store/secrets.js'
import { PrefsStore } from '../src/store/prefs.js'
import { KeysStore } from '../src/store/keys.js'
import { ContactsStore } from '../src/store/contacts.js'
import { BlockedSendersStore } from '../src/store/blocked.js'
import { GroupsStore } from '../src/store/groups.js'
import { ProfilesStore } from '../src/store/profiles.js'
import { CallLogStore, DraftsStore, MarksStore, MediaCache, PinsStore } from '../src/store/chat-state.js'
import { Messenger } from '../src/domain/messenger.js'
import { SessionInfo } from '../src/app/session.js'
import { generateIdentity } from '../src/crypto/identity.js'
import { generateKeyPair } from '../src/crypto/primitives.js'
import { parse } from '../src/protocol/codec.js'
import { MediaJson, mediaInfo } from '../src/protocol/formats.js'
import { buildExport, parseExport, recordsOf, serializeExport } from '../src/domain/chat-export.js'
import { FakeRelay } from './fake-relay.js'

const started: Messenger[] = []

afterEach(() => {
  for (const messenger of started.splice(0)) messenger.stop()
})

async function makeUser(relay: FakeRelay, login: string, device = 'dev1') {
  const kv = new MemoryKv()
  const secrets = new SecretsStore(kv)
  const blobs = await generateKeyPair()
  const identity = await generateIdentity()
  await secrets.saveIdentity({ secretPkcs8: blobs.secretPkcs8, publicSpki: identity.publicKey() })
  const token = `token-${login}-${device}`
  relay.addAccount(login, device, identity.publicKey(), token)
  const session = new SessionInfo(login, token, device, identity, relay)
  const journal = new Journal(kv, await secrets.ensureDataKey())
  const messenger = new Messenger({
    kv,
    api: relay,
    session,
    journal,
    prefs: new PrefsStore(kv),
    keys: new KeysStore(kv),
    contacts: new ContactsStore(kv),
    blocked: new BlockedSendersStore(kv),
    groups: new GroupsStore(kv),
    profiles: new ProfilesStore(kv),
    drafts: new DraftsStore(kv),
    pins: new PinsStore(kv),
    marks: new MarksStore(kv),
    media: new MediaCache(kv),
    callLog: new CallLogStore(kv),
  })
  started.push(messenger)
  return { login, kv, journal, messenger }
}

describe('пересылка через протокол (P-W6)', () => {
  it('пересланное сообщение доходит до получателя с метой «Переслано от X»', async () => {
    const relay = new FakeRelay()
    const alice = await makeUser(relay, 'alice')
    const bob = await makeUser(relay, 'bob')
    const carol = await makeUser(relay, 'carol')
    await alice.messenger.sendText('bob', 'привет из чата')
    await bob.messenger.drainAll()
    const source = (await bob.journal.history('alice'))[0]
    const sent = await bob.messenger.forwardMessages('carol', [source])
    expect(sent).toBe(1)
    await carol.messenger.drainAll()
    const received = (await carol.journal.history('bob'))[0]
    const parsed = parse(received.content, false)
    expect(parsed.kind).toBe('content')
    if (parsed.kind !== 'content' || parsed.content.kind !== 'reply') throw new Error('ожидался reply-конверт пересылки')
    expect(parsed.content.reply.fwd).toBe('alice')
    expect(parsed.content.reply.text).toBe('привет из чата')
    // цитата чужого чата не утекает
    expect(parsed.content.reply.quote).toBe('')
  })

  it('пересылка в группу несёт определение целевой группы', async () => {
    const relay = new FakeRelay()
    const alice = await makeUser(relay, 'alice')
    const bob = await makeUser(relay, 'bob')
    const groupId = await alice.messenger.createGroup('Команда', ['bob'])
    await bob.messenger.drainAll()
    // исходник — обычное сообщение из личного чата
    await alice.messenger.sendText('bob', 'перенесите это в команду')
    const source = (await alice.journal.history('bob'))[0]
    expect(await alice.messenger.forwardMessages(groupId, [source])).toBe(1)
    const forwarded = (await alice.journal.history(groupId)).at(-1)!
    const parsed = parse(forwarded.content, false)
    expect(parsed.kind).toBe('content')
    if (parsed.kind !== 'content') return
    // групповой конверт целевого чата на месте, атрибуция — внутри
    expect(parsed.group?.info.id).toBe(groupId)
    expect(parsed.content.kind).toBe('reply')
    if (parsed.content.kind !== 'reply') return
    expect(parsed.content.reply.fwd).toBe('alice')
    expect(parsed.content.reply.text).toBe('перенесите это в команду')
  })
})

describe('массовое удаление выделенного (P-W7)', () => {
  it('своё уходит «удалить у всех», чужие снимаются только локально', async () => {
    const relay = new FakeRelay()
    const alice = await makeUser(relay, 'alice')
    const bob = await makeUser(relay, 'bob')
    await alice.messenger.sendText('bob', 'моё сообщение')
    await bob.messenger.sendText('alice', 'чужое сообщение')
    await alice.messenger.drainAll()
    const mine = (await alice.journal.history('bob'))[0]
    const theirs = (await alice.journal.history('bob'))[1]
    expect(await alice.journal.count('bob')).toBe(2)
    await alice.messenger.deleteMessages('bob', [mine, theirs])
    expect(await alice.journal.count('bob')).toBe(0)
    // у собеседника осталось только «чужое»: событие удаления пришло по своему
    await bob.messenger.drainAll()
    expect(await bob.journal.count('alice')).toBe(1)
    const left = (await bob.journal.history('alice'))[0]
    expect(left.from).toBe('bob')
  })
})

describe('импорт истории (P-W2)', () => {
  it('round-trip: выгрузка → импорт даёт ту же историю', async () => {
    const relay = new FakeRelay()
    const alice = await makeUser(relay, 'alice')
    const bob = await makeUser(relay, 'bob')
    await alice.messenger.sendText('bob', 'первое')
    await bob.messenger.sendText('alice', 'второе')
    await alice.messenger.drainAll()
    const before = await alice.journal.history('bob', 100)
    const file = buildExport({ chatId: 'bob', login: 'alice', records: before, now: 1 })
    // чистим историю и возвращаем её из файла
    await alice.journal.clearChat('bob')
    expect(await alice.journal.count('bob')).toBe(0)
    const parsed = parseExport(serializeExport(file))!
    const added = await alice.messenger.importRecords('bob', recordsOf(parsed))
    expect(added).toBe(before.length)
    expect(await alice.journal.history('bob', 100)).toEqual(before)
  })
})

describe('импорт с дедупом', () => {
  it('повторный импорт того же файла ничего не дублирует', async () => {
    const relay = new FakeRelay()
    const alice = await makeUser(relay, 'alice')
    await makeUser(relay, 'bob')
    await alice.messenger.sendText('bob', 'сообщение')
    const before = await alice.journal.history('bob', 100)
    const file = buildExport({ chatId: 'bob', login: 'alice', records: before, now: 1 })
    const records = recordsOf(parseExport(serializeExport(file))!)
    await alice.journal.clearChat('bob')
    expect(await alice.messenger.importRecords('bob', records)).toBe(before.length)
    // всё уже в журнале — второго раза записи не добавляются
    expect(await alice.messenger.importRecords('bob', records)).toBe(0)
    expect(await alice.journal.count('bob')).toBe(before.length)
  })

  it('медиа из файла импорта попадает в кэш и читается обратно', async () => {
    const relay = new FakeRelay()
    const alice = await makeUser(relay, 'alice')
    const blob = new Uint8Array([9, 8, 7])
    const file = buildExport({
      chatId: 'bob',
      login: 'alice',
      records: [{ from: 'bob', timestamp: 5, content: MediaJson.message(mediaInfo({ id: 'abc123'.padEnd(64, '0'), key: new Uint8Array(32), size: blob.length })) }],
      media: new Map([['abc123'.padEnd(64, '0'), blob]]),
      now: 1,
    })
    const parsed = parseExport(serializeExport(file))!
    expect(await alice.messenger.importMedia(parsed.media ?? [])).toBe(1)
    expect(await alice.kv.get(`media:${'abc123'.padEnd(64, '0')}`)).toEqual(blob)
  })
})
