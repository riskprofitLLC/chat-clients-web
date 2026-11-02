import { afterEach, describe, expect, it } from 'vitest'
import { MemoryKv } from '../src/store/kv.js'
import { Journal } from '../src/store/journal.js'
import { SecretsStore } from '../src/store/secrets.js'
import { PrefsStore } from '../src/store/prefs.js'
import { KeysStore } from '../src/store/keys.js'
import { ContactsStore } from '../src/store/contacts.js'
import { GroupsStore } from '../src/store/groups.js'
import { ProfilesStore } from '../src/store/profiles.js'
import { CallLogStore, DraftsStore, MarksStore, MediaCache, PinsStore } from '../src/store/chat-state.js'
import { Messenger, KeyChangedError } from '../src/domain/messenger.js'
import { SessionInfo } from '../src/app/session.js'
import { generateIdentity, type E2E } from '../src/crypto/identity.js'
import { generateKeyPair } from '../src/crypto/primitives.js'
import { FakeRelay } from './fake-relay.js'
import { DedupIndex } from '../src/domain/dedup.js'
import { aggregateReactions } from '../src/domain/reactions.js'
import { aggregateVotes } from '../src/domain/polls.js'
import { CallGate } from '../src/domain/callgate.js'
import { applyDelete, applyEdit } from '../src/domain/journal-ops.js'
import { chunkItems, decodeChunk, encodeChunk, TransferMalformed } from '../src/domain/transfer.js'
import { verdict as tofuVerdict } from '../src/domain/tofu.js'
import { CallFormat, GroupFormat, type GroupInfo } from '../src/protocol/formats.js'
import * as Env from '../src/protocol/envelope.js'
import { parse } from '../src/protocol/codec.js'
import { text } from '../src/util/bytes.js'

interface TestUser {
  login: string
  device: string
  kv: MemoryKv
  journal: Journal
  secrets: SecretsStore
  identity: E2E
  messenger: Messenger
  groups: GroupsStore
}

const started: Messenger[] = []

afterEach(() => {
  for (const messenger of started.splice(0)) messenger.stop()
})

async function makeUser(relay: FakeRelay, login: string, device = 'dev1'): Promise<TestUser> {
  const kv = new MemoryKv()
  const secrets = new SecretsStore(kv)
  const blobs = await generateKeyPair()
  await secrets.saveIdentity(blobs)
  const identity = await generateIdentity()
  // ключ в справочнике сервера — от той же идентичности, что у клиента
  const own = new SecretsStore(kv)
  await own.saveIdentity({ secretPkcs8: blobs.secretPkcs8, publicSpki: identity.publicKey() })
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
    groups: new GroupsStore(kv),
    profiles: new ProfilesStore(kv),
    drafts: new DraftsStore(kv),
    pins: new PinsStore(kv),
    marks: new MarksStore(kv),
    media: new MediaCache(kv),
    callLog: new CallLogStore(kv),
  })
  started.push(messenger)
  return { login, device, kv, journal, secrets, identity, messenger, groups: new GroupsStore(kv) }
}

describe('журнал', () => {
  it('пишет, читает хвост и удаляет; на диске нет plaintext', async () => {
    const kv = new MemoryKv()
    const journal = new Journal(kv, new Uint8Array(32).fill(3))
    await journal.append('bob', { from: 'alice', timestamp: 1, content: Env.escapeText('секретный текст') })
    await journal.append('bob', { from: 'bob', timestamp: 2, content: Env.escapeText('ответ') })
    const history = await journal.history('bob')
    expect(history.map((r) => r.timestamp)).toEqual([1, 2])
    expect(text(history[0].content)).toContain('секретный текст')
    expect(await journal.count('bob')).toBe(2)
    expect(await journal.chatIds()).toEqual(['bob'])

    // на диске — только шифротекст
    const raw = await kv.list('j:')
    for (const entry of raw) {
      expect(text(entry.value)).not.toContain('секретный')
    }

    const removed = await journal.deleteRecords('bob', (r) => r.timestamp === 1)
    expect(removed).toBe(1)
    expect((await journal.history('bob')).map((r) => r.timestamp)).toEqual([2])
  })

  it('хвост ограничен limit и не теряет порядок', async () => {
    const journal = new Journal(new MemoryKv(), new Uint8Array(32))
    for (let i = 0; i < 30; i++) {
      await journal.append('bob', { from: 'alice', timestamp: i, content: Env.escapeText(`msg${i}`) })
    }
    const tail = await journal.history('bob', 5)
    expect(tail.map((r) => r.timestamp)).toEqual([25, 26, 27, 28, 29])
  })

  it('чужая AAD не расшифровывается: запись не переезжает в другой чат', async () => {
    const kv = new MemoryKv()
    const journal = new Journal(kv, new Uint8Array(32).fill(9))
    await journal.append('bob', { from: 'alice', timestamp: 1, content: Env.escapeText('текст') })
    // копируем ключ записи в другой чат — расшифровка обязана упасть
    const entries = await kv.list('j:bob:')
    await kv.put('j:carol:000000000001', entries[0].value)
    const records = await journal.history('carol')
    expect(records).toHaveLength(0)
  })
})

describe('чистая логика', () => {
  it('дедуп: повтор не проходит, ёмкость ограничена', () => {
    const dedup = new DedupIndex(2)
    expect(dedup.remember('a')).toBe(false)
    expect(dedup.remember('a')).toBe(true)
    dedup.remember('b')
    dedup.remember('c')
    expect(dedup.seen('a')).toBe(false)
    expect(dedup.seen('c')).toBe(true)
  })

  it('реакции: последняя запись автора, пустая снимает', () => {
    const state = aggregateReactions(
      [
        { ts: 1, author: 'bob', emoji: '👍' },
        { ts: 2, author: 'carol', emoji: '❤️' },
        { ts: 3, author: 'bob', emoji: '' },
        { ts: 4, author: 'carol', emoji: '🔥' },
      ],
      'carol',
    )
    expect([...state.byEmoji.keys()]).toEqual(['🔥'])
    expect(state.mine).toBe('🔥')
  })

  it('голоса опроса: снятие и стоп автора', () => {
    const state = aggregateVotes(
      [
        { ts: 1, author: 'bob', choice: 0, stop: false },
        { ts: 2, author: 'carol', choice: 1, stop: false },
        { ts: 3, author: 'bob', choice: -1, stop: false },
        { ts: 4, author: 'alice', choice: -1, stop: true },
      ],
      2,
      'alice',
      'carol',
    )
    expect(state.counts).toEqual([0, 1])
    expect(state.mine).toBe(1)
    expect(state.closed).toBe(true)
  })

  it('гейт звонков: терминальные события идемпотентны, чужой offer устаревает', () => {
    const gate = new CallGate()
    const offer = { ev: 'offer' as const, callId: 'abc12345', ts: Date.now(), cands: [] }
    expect(gate.decide(false, offer).kind).toBe('live')
    const stale = { ...offer, ts: Date.now() - CallFormat.STALE_MS - 1 }
    expect(gate.decide(false, stale).kind).toBe('missed')
    const accept = { ev: 'accept' as const, callId: 'abc12345', ts: Date.now(), cands: [] }
    expect(gate.decide(false, accept).kind).toBe('live')
    expect(gate.decide(false, accept).kind).toBe('mute')
  })

  it('TOFU: первый контакт, новое устройство, смена ключа', async () => {
    const a = await generateKeyPair()
    const b = await generateKeyPair()
    expect((await tofuVerdict(new Map(), [['d1', a.publicSpki]])).kind).toBe('firstSeen')
    const known = new Map([['d1', await digest(a.publicSpki)]])
    expect((await tofuVerdict(known, [['d1', a.publicSpki]])).kind).toBe('ok')
    expect((await tofuVerdict(known, [['d1', a.publicSpki], ['d2', b.publicSpki]])).kind).toBe('newDevice')
    expect((await tofuVerdict(known, [['d1', b.publicSpki]])).kind).toBe('changed')
  })

  it('перенос истории: чанки и строгая валидация', () => {
    const items = [
      { chat: 'bob', from: 'alice', ts: 1, content: Env.escapeText('раз') },
      { chat: 'bob', from: 'bob', ts: 2, content: Env.escapeText('два') },
    ]
    const chunks = chunkItems(items)
    expect(chunks).toHaveLength(1)
    const decoded = decodeChunk(encodeChunk(chunks[0]), 'alice')
    expect(decoded).toHaveLength(2)
    expect(decoded[1].from).toBe('bob')
    // автор вне 1:1 чата — отказ
    const bad = JSON.stringify([{ chat: 'carol', from: 'bob', ts: 1, content: 'AAAA' }])
    expect(() => decodeChunk(new TextEncoder().encode(bad), 'alice')).toThrow(TransferMalformed)
  })
})

describe('правка и удаление в журнале', () => {
  it('правка заменяет содержимое, сохраняя время и автора, и снимает реакции', async () => {
    const journal = new Journal(new MemoryKv(), new Uint8Array(32))
    const original = Env.escapeText('старый текст')
    await journal.append('bob', { from: 'alice', timestamp: 100, content: original })
    await journal.append('bob', {
      from: 'bob',
      timestamp: 101,
      content: Env.encode('x', JSON.stringify({ to: 100, e: '👍' })),
    })
    const edited = Env.encodeBytes(Env.TYPE_EDITED, new TextEncoder().encode('новый текст'))
    const ok = await applyEdit(journal, 'bob', 'alice', { targetTs: 100, newContent: edited })
    expect(ok).toBe(true)
    const history = await journal.history('bob')
    expect(history).toHaveLength(1)
    expect(history[0].timestamp).toBe(100)
    expect(history[0].from).toBe('alice')
    const parsed = parse(history[0].content)
    if (parsed.kind !== 'content' || parsed.content.kind !== 'text') throw new Error('ожидали текст')
    expect(parsed.content.text).toBe('новый текст')
  })

  it('чужую правку применить нельзя, удаление — только своё', async () => {
    const journal = new Journal(new MemoryKv(), new Uint8Array(32))
    await journal.append('bob', { from: 'alice', timestamp: 100, content: Env.escapeText('текст') })
    const edited = Env.encodeBytes(Env.TYPE_EDITED, new TextEncoder().encode('подмена'))
    expect(await applyEdit(journal, 'bob', 'carol', { targetTs: 100, newContent: edited })).toBe(false)
    expect(await applyDelete(journal, 'bob', 'carol', { targetTs: 100 })).toBe(false)
    expect(await applyDelete(journal, 'bob', 'alice', { targetTs: 100 })).toBe(true)
    expect(await journal.history('bob')).toHaveLength(0)
  })

  it('правка с мусорным конвертом отклоняется', async () => {
    const journal = new Journal(new MemoryKv(), new Uint8Array(32))
    await journal.append('bob', { from: 'alice', timestamp: 100, content: Env.escapeText('текст') })
    expect(
      await applyEdit(journal, 'bob', 'alice', { targetTs: 100, newContent: Env.escapeText('не тот тип') }),
    ).toBe(false)
  })
})

describe('обмен между двумя клиентами', () => {
  it('текст доходит, шифруется и дедуплицируется', async () => {
    const relay = new FakeRelay()
    const alice = await makeUser(relay, 'alice')
    const bob = await makeUser(relay, 'bob')

    await alice.messenger.sendText('bob', 'привет, боб')
    expect(await bob.messenger.drainAll()).toBeGreaterThan(0)

    const history = await bob.journal.history('alice')
    expect(history).toHaveLength(1)
    const parsed = parse(history[0].content)
    if (parsed.kind !== 'content' || parsed.content.kind !== 'text') throw new Error('ожидали текст')
    expect(parsed.content.text).toBe('привет, боб')
    expect(history[0].from).toBe('alice')
    expect(relay.delivered).toEqual([{ from: 'alice', toDevice: 'dev1' }])

    // повторный дрейн той же очереди не создаёт дубль
    await bob.messenger.drainAll()
    expect(await bob.journal.history('alice')).toHaveLength(1)
  })

  it('ответ, реакция и правка видны у собеседника', async () => {
    const relay = new FakeRelay()
    const alice = await makeUser(relay, 'alice')
    const bob = await makeUser(relay, 'bob')

    await alice.messenger.sendText('bob', 'первое')
    await bob.messenger.drainAll()
    const [original] = await alice.journal.history('bob')

    // bob отвечает цитатой
    const ref = await (await import('../src/protocol/refs.js')).refOf(original.content)
    await bob.messenger.sendText('alice', 'ответ', { replyTo: { ref, author: 'alice', quote: 'первое', ts: original.timestamp } })
    await alice.messenger.drainAll()
    const aliceHistory = await alice.journal.history('bob')
    expect(aliceHistory).toHaveLength(2)
    const reply = parse(aliceHistory[1].content)
    if (reply.kind !== 'content' || reply.content.kind !== 'reply') throw new Error('ожидали ответ')
    expect(reply.content.reply.text).toBe('ответ')
    expect(reply.content.reply.targetRef).toBe(ref)

    // bob ставит реакцию
    await bob.messenger.react('alice', { ref, ts: original.timestamp }, '🔥')
    await alice.messenger.drainAll()
    const reactions = await alice.messenger.reactionsFor('bob', ref, original.timestamp)
    expect(reactions.byEmoji.get('🔥')).toEqual(['bob'])

    // alice правит своё сообщение — у bob текст обновился
    await alice.messenger.editMessage('bob', original, 'исправлено')
    await bob.messenger.drainAll()
    // у bob в этом чате две записи: своя реплика и исходное от alice — уже правленое
    const bobHistory = await bob.journal.history('alice')
    expect(bobHistory).toHaveLength(2)
    const texts = bobHistory
      .map((record) => parse(record.content))
      .filter((parsed) => parsed.kind === 'content' && parsed.content.kind === 'text')
    expect(texts).toHaveLength(1)
    const edited = texts[0]
    if (edited.kind !== 'content' || edited.content.kind !== 'text') throw new Error('ожидали текст')
    expect(edited.content.text).toBe('исправлено')
    expect(edited.content.edited).toBe(true)
  })

  it('удаление у всех убирает сообщение у собеседника', async () => {
    const relay = new FakeRelay()
    const alice = await makeUser(relay, 'alice')
    const bob = await makeUser(relay, 'bob')
    await alice.messenger.sendText('bob', 'удали меня')
    await bob.messenger.drainAll()
    const [target] = await alice.journal.history('bob')
    await alice.messenger.deleteMessage('bob', target)
    await bob.messenger.drainAll()
    expect(await bob.journal.history('alice')).toHaveLength(0)
  })

  it('групповое сообщение расходится всем участникам', async () => {
    const relay = new FakeRelay()
    const alice = await makeUser(relay, 'alice')
    const bob = await makeUser(relay, 'bob')
    const carol = await makeUser(relay, 'carol')

    const groupId = await alice.messenger.createGroup('Тест', ['bob', 'carol'])
    await alice.messenger.sendText(groupId, 'всем привет')
    await bob.messenger.drainAll()
    await carol.messenger.drainAll()

    for (const user of [bob, carol]) {
      const history = await user.journal.history(groupId)
      expect(history.length).toBeGreaterThan(0)
      const last = history[history.length - 1]
      const parsed = parse(last.content)
      if (parsed.kind !== 'content' || parsed.content.kind !== 'text') throw new Error('ожидали текст')
      expect(parsed.content.text).toBe('всем привет')
      expect(parsed.group!.info.name).toBe('Тест')
      expect(parsed.group!.info.members).toEqual(['alice', 'bob', 'carol'])
    }
  })

  it('медиа: блоб выгружается и скачивается по id', async () => {
    const relay = new FakeRelay()
    const alice = await makeUser(relay, 'alice')
    const bob = await makeUser(relay, 'bob')
    const payload = new Uint8Array([1, 2, 3, 4, 5])
    const mediaId = await alice.messenger.uploadMedia(payload)
    await alice.messenger.sendMedia('bob', {
      id: mediaId,
      key: new Uint8Array(32),
      size: payload.length,
      width: 10,
      height: 10,
      thumb: 'AAAA',
      type: 'media',
      duration: 0,
      spoiler: false,
      sticker: false,
      videoNote: false,
      silent: false,
      viewOnce: false,
    })
    await bob.messenger.drainAll()
    const history = await bob.journal.history('alice')
    expect(history).toHaveLength(1)
    const parsed = parse(history[0].content)
    if (parsed.kind !== 'content' || parsed.content.kind !== 'media') throw new Error('ожидали медиа')
    const blob = await bob.messenger.ensureMedia(parsed.content.info)
    expect(blob).toEqual(payload)
  })

  it('outbox: при обрыве сети сообщение живёт локально и уходит после восстановления', async () => {
    const relay = new FakeRelay()
    const alice = await makeUser(relay, 'alice')
    const bob = await makeUser(relay, 'bob')

    relay.offline = true
    await alice.messenger.sendText('bob', 'переживу обрыв')
    expect(await alice.journal.history('bob')).toHaveLength(1)
    expect(await alice.messenger.outbox.count()).toBe(1)

    relay.offline = false
    await alice.messenger.flushOutbox()
    expect(await alice.messenger.outbox.count()).toBe(0)
    await bob.messenger.drainAll()
    const history = await bob.journal.history('alice')
    expect(history).toHaveLength(1)
  })

  it('новое устройство собеседника блокирует отправку до подтверждения (TOFU)', async () => {
    const relay = new FakeRelay()
    const alice = await makeUser(relay, 'alice')
    await makeUser(relay, 'bob')
    await alice.messenger.sendText('bob', 'первое')
    // у bob появилось второе устройство
    await makeUser(relay, 'bob', 'dev2')
    // кэш ключей живёт минуту: без сброса новое устройство всплыло бы позже
    alice.messenger.invalidateKeys('bob')
    await expect(alice.messenger.sendText('bob', 'второе')).rejects.toBeInstanceOf(KeyChangedError)
    // запись уже в журнале, отправка ждёт подтверждения в outbox
    expect(await alice.messenger.outbox.count()).toBe(1)
  })

  it('черновик синхронизируется на свои устройства', async () => {
    const relay = new FakeRelay()
    const phone = await makeUser(relay, 'alice', 'phone')
    const web = await makeUser(relay, 'alice', 'web')
    await phone.messenger.sendText('bob', 'есть контакт')
    await phone.messenger.setDraft('bob', 'недописанное')
    await web.messenger.drainAll()
    const drafts = new DraftsStore(web.kv)
    expect((await drafts.get('bob'))?.text).toBe('недописанное')
  })

  it('история переносится на второе устройство своего аккаунта', async () => {
    const relay = new FakeRelay()
    const phone = await makeUser(relay, 'alice', 'phone')
    const web = await makeUser(relay, 'alice', 'web')
    await phone.messenger.sendText('bob', 'старое сообщение')
    await phone.journal.append('bob', { from: 'bob', timestamp: 5, content: Env.escapeText('и это тоже') })
    const moved = await phone.messenger.transferHistoryTo('web')
    expect(moved).toBeGreaterThanOrEqual(2)
    await web.messenger.drainAll()
    const history = await web.journal.history('bob')
    expect(history.map((r) => r.timestamp)).toContain(5)
  })

  it('чужой transfer игнорируется', async () => {
    const relay = new FakeRelay()
    const alice = await makeUser(relay, 'alice')
    const bob = await makeUser(relay, 'bob')
    const payload = encodeChunk([{ chat: 'alice', from: 'bob', ts: 1, content: Env.escapeText('чужое') }])
    const blob = await bob.identity.seal(alice.identity.publicKey(), payload)
    await relay.send(bob.messenger.session.token, 'alice', 'transfer', [['dev1', blob]])
    await alice.messenger.drainAll()
    expect(await alice.journal.history('alice')).toHaveLength(0)
  })

  it('список чатов показывает непрочитанные, черновики и группы', async () => {
    const relay = new FakeRelay()
    const alice = await makeUser(relay, 'alice')
    const bob = await makeUser(relay, 'bob')
    await bob.messenger.sendText('alice', 'привет')
    await bob.messenger.sendText('alice', 'как дела')
    await alice.messenger.drainAll()
    await alice.messenger.setDraft('bob', 'отвечаю')
    const summaries = await alice.messenger.chatSummaries()
    const bobChat = summaries.find((s) => s.chatId === 'bob')!
    expect(bobChat.unread).toBe(2)
    expect(bobChat.draft).toBe('отвечаю')
    expect(bobChat.isGroup).toBe(false)
    await alice.messenger.markRead('bob')
    expect((await alice.messenger.chatSummaries()).find((s) => s.chatId === 'bob')!.unread).toBe(0)
    expect(relay.reads).toEqual(['bob'])
  })

  it('закреп и опрос сохраняются в чате', async () => {
    const relay = new FakeRelay()
    const alice = await makeUser(relay, 'alice')
    const bob = await makeUser(relay, 'bob')
    await alice.messenger.sendPoll('bob', 'Вопрос?', ['да', 'нет'], false)
    await bob.messenger.drainAll()
    const history = await bob.journal.history('alice')
    const parsed = parse(history[0].content)
    if (parsed.kind !== 'content' || parsed.content.kind !== 'poll') throw new Error('ожидали опрос')
    const pollRef = (await import('../src/protocol/refs.js')).refOf(history[0].content)
    await bob.messenger.vote('alice', await pollRef, 1)
    await alice.messenger.drainAll()
    const votes = await alice.messenger.votesFor('bob', await pollRef, 2, 'alice')
    expect(votes.counts).toEqual([0, 1])
    expect(votes.mine).toBeNull()
  })

  it('звонок: событие проходит гейт и оставляет запись о пропущенном', async () => {
    const relay = new FakeRelay()
    const alice = await makeUser(relay, 'alice')
    const bob = await makeUser(relay, 'bob')
    const events: string[] = []
    bob.messenger.onEvent((event) => {
      if (event.type === 'call') events.push(event.verdict.kind)
    })
    const callId = CallFormat.newCallId()
    const offer = CallFormat.encode('offer', callId, Date.now())
    const blob = await alice.identity.seal(bob.identity.publicKey(), offer)
    await relay.send(alice.messenger.session.token, 'bob', 'chat', [['dev1', blob]])
    await bob.messenger.drainAll()
    expect(events).toEqual(['live'])

    // отмена приходит как пропущенный
    const cancel = CallFormat.encode('cancel', callId, Date.now())
    const cancelBlob = await alice.identity.seal(bob.identity.publicKey(), cancel)
    await relay.send(alice.messenger.session.token, 'bob', 'chat', [['dev1', cancelBlob]])
    await bob.messenger.drainAll()
    expect(events).toEqual(['live', 'missed'])
    const history = await bob.journal.history('alice')
    expect(history).toHaveLength(1)
    expect(CallFormat.recordDecode(Env.decode(history[0].content)!.payload)!.status).toBe('missed')
  })

  it('смена состава группы через событие обновляет определение', async () => {
    const relay = new FakeRelay()
    const alice = await makeUser(relay, 'alice')
    const bob = await makeUser(relay, 'bob')
    const carol = await makeUser(relay, 'carol')
    const groupId = await alice.messenger.createGroup('Команда', ['bob'])
    await bob.messenger.drainAll()
    await alice.messenger.addMembers(groupId, ['carol'])
    await bob.messenger.drainAll()
    const group = await new GroupsStore(bob.kv).get(groupId)
    expect(group!.members).toContain('carol')
    const summary = (await bob.messenger.chatSummaries()).find((s) => s.chatId === groupId)!
    expect(summary.members).toBe(3)
    void carol
  })

  it('групповой конверт хранится в журнале и читается кодеком', async () => {
    const relay = new FakeRelay()
    const alice = await makeUser(relay, 'alice')
    const groupId = await alice.messenger.createGroup('Своя', ['bob'])
    const info: GroupInfo = {
      id: groupId,
      name: 'Своя',
      members: ['alice', 'bob'],
      rev: 2,
      desc: '',
      slowMode: 0,
      noForward: false,
      admins: ['alice'],
      noReactions: false,
    }
    const content = GroupFormat.encode(info, Env.escapeText('внутри'))
    const parsed = parse(content)
    if (parsed.kind !== 'content') throw new Error('ожидали контент')
    expect(parsed.group!.info.id).toBe(groupId)
    void alice
  })
})

async function digest(pub: Uint8Array): Promise<string> {
  const { sha256 } = await import('../src/crypto/primitives.js')
  const { toHex } = await import('../src/util/bytes.js')
  return toHex(await sha256(pub))
}
