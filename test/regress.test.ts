// Регрессионные тесты на найденные баги (см. promts/sonnet.md).
// Без DOM: MemoryKv + FakeRelay.
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
import { GroupFormat, SystemFormat, type GroupInfo } from '../src/protocol/formats.js'
import * as Env from '../src/protocol/envelope.js'
import { parse } from '../src/protocol/codec.js'
import { refOf } from '../src/protocol/refs.js'
import { sniffAudioMime } from '../src/media/media.js'
import { utf8 } from '../src/util/bytes.js'
import { devServerOverride } from '../src/app/context.js'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

interface TestUser {
  login: string
  device: string
  kv: MemoryKv
  journal: Journal
  identity: E2E
  messenger: Messenger
}

const started: Messenger[] = []

afterEach(() => {
  for (const messenger of started.splice(0)) messenger.stop()
})

async function makeUser(relay: FakeRelay, login: string, device = 'dev1'): Promise<TestUser> {
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
    groups: new GroupsStore(kv),
    profiles: new ProfilesStore(kv),
    drafts: new DraftsStore(kv),
    pins: new PinsStore(kv),
    marks: new MarksStore(kv),
    media: new MediaCache(kv),
    callLog: new CallLogStore(kv),
  })
  started.push(messenger)
  return { login, device, kv, journal, identity, messenger }
}

describe('B2: блокировка TOFU не снимается сама', () => {
  it('два прохода flushOutbox подряд не отправляют сообщение', async () => {
    const relay = new FakeRelay()
    const alice = await makeUser(relay, 'alice')
    await makeUser(relay, 'bob')
    await alice.messenger.sendText('bob', 'первое')
    await makeUser(relay, 'bob', 'dev2')
    alice.messenger.invalidateKeys('bob')
    await expect(alice.messenger.sendText('bob', 'второе')).rejects.toBeInstanceOf(KeyChangedError)
    expect(await alice.messenger.outbox.count()).toBe(1)

    // повторные проходы не должны отправить «второе» без подтверждения
    await alice.messenger.flushOutbox()
    await alice.messenger.flushOutbox()
    expect(await alice.messenger.outbox.count()).toBe(1)
    // и блок по-прежнему на месте
    expect(await alice.messenger.reverifyPending('bob')).not.toBeNull()
  })

  it('явное «отправить всё равно» снимает блок и доигрывает очередь', async () => {
    const relay = new FakeRelay()
    const alice = await makeUser(relay, 'alice')
    const bob = await makeUser(relay, 'bob')
    await alice.messenger.sendText('bob', 'первое')
    await makeUser(relay, 'bob', 'dev2')
    alice.messenger.invalidateKeys('bob')
    await expect(alice.messenger.sendText('bob', 'второе')).rejects.toBeInstanceOf(KeyChangedError)
    await alice.messenger.trustPeer('bob')
    expect(await alice.messenger.outbox.count()).toBe(0)
    await bob.messenger.drainAll()
    expect(await bob.journal.history('alice')).toHaveLength(2)
  })
})

describe('B3: чужой групповой конверт отклоняется', () => {
  it('неучастник не может писать в группу и менять состав', async () => {
    const relay = new FakeRelay()
    const alice = await makeUser(relay, 'alice')
    const bob = await makeUser(relay, 'bob')
    const carol = await makeUser(relay, 'carol')
    const groupId = await alice.messenger.createGroup('Секрет', ['bob'])
    await bob.messenger.drainAll()
    const before = await new GroupsStore(bob.kv).get(groupId)

    // carol подделывает групповой конверт с чужим составом
    const forged: GroupInfo = {
      id: groupId,
      name: 'Взлом',
      members: ['carol', 'bob'],
      rev: (before?.rev ?? 1) + 1,
      desc: '',
      slowMode: 0,
      noForward: false,
      admins: ['carol'],
      noReactions: false,
    }
    const payload = GroupFormat.encode(forged, Env.escapeText('я тут главный'))
    const blob = await carol.identity.seal(bob.identity.publicKey(), payload)
    await relay.send(carol.messenger.session.token, 'bob', 'chat', [['dev1', blob]])
    await bob.messenger.drainAll()

    const after = await new GroupsStore(bob.kv).get(groupId)
    expect(after?.name).toBe(before?.name)
    expect(after?.members).toEqual(before?.members)
    expect(after?.admins).toEqual(before?.admins)
    const history = await bob.journal.history(groupId)
    expect(history.some((r) => parse(r.content).kind === 'content' && JSON.stringify(parse(r.content)).includes('главный'))).toBe(false)
  })
})

describe('B4/B5: групповые правки, удаления и закрепы', () => {
  async function groupSetup(): Promise<{ relay: FakeRelay; alice: TestUser; bob: TestUser; groupId: string }> {
    const relay = new FakeRelay()
    const alice = await makeUser(relay, 'alice')
    const bob = await makeUser(relay, 'bob')
    const groupId = await alice.messenger.createGroup('Команда', ['bob'])
    await alice.messenger.sendText(groupId, 'исходный текст')
    await bob.messenger.drainAll()
    return { relay, alice, bob, groupId }
  }

  it('правка в группе применяется у получателя, а у автора не пишет служебную запись', async () => {
    const { alice, bob, groupId } = await groupSetup()
    const aliceHistory = await alice.journal.history(groupId)
    const target = aliceHistory.find((r) => {
      const parsed = parse(r.content)
      return parsed.kind === 'content' && parsed.content.kind === 'text' && parsed.content.text === 'исходный текст'
    })!
    const beforeCount = aliceHistory.length
    await alice.messenger.editMessage(groupId, target, 'исправленный текст')
    // служебное событие правки НЕ должно стать записью журнала
    expect(await alice.journal.history(groupId)).toHaveLength(beforeCount)
    await bob.messenger.drainAll()
    const bobTexts = (await bob.journal.history(groupId)).map((r) => parse(r.content))
    const edited = bobTexts.find((p) => p.kind === 'content' && p.content.kind === 'text' && p.content.edited)
    expect(edited).toBeTruthy()
  })

  it('удаление в группе убирает сообщение у получателя', async () => {
    const { alice, bob, groupId } = await groupSetup()
    const target = (await alice.journal.history(groupId)).find((r) => {
      const parsed = parse(r.content)
      return parsed.kind === 'content' && parsed.content.kind === 'text' && parsed.content.text === 'исходный текст'
    })!
    await alice.messenger.deleteMessage(groupId, target)
    await bob.messenger.drainAll()
    const texts = (await bob.journal.history(groupId)).map((r) => parse(r.content))
    expect(texts.some((p) => p.kind === 'content' && p.content.kind === 'text' && p.content.text === 'исходный текст')).toBe(false)
  })

  it('закреп в группе доходит до получателя', async () => {
    const { alice, bob, groupId } = await groupSetup()
    const target = (await alice.journal.history(groupId)).find((r) => {
      const parsed = parse(r.content)
      return parsed.kind === 'content' && parsed.content.kind === 'text'
    })!
    await alice.messenger.pinMessage(groupId, target, true)
    await bob.messenger.drainAll()
    const ref = await refOf(target.content)
    expect(await new PinsStore(bob.kv).get(groupId)).toContain(ref)
  })
})

describe('B6: дедуп по содержимому, а не по блобу', () => {
  it('повторная отправка того же контента с новым блобом не создаёт дубль', async () => {
    const relay = new FakeRelay()
    const alice = await makeUser(relay, 'alice')
    const bob = await makeUser(relay, 'bob')
    const content = Env.escapeText('один и тот же текст')
    // два разных sealed-блоба одного контента (как при ретрае outbox)
    const first = await alice.identity.seal(bob.identity.publicKey(), content)
    const second = await alice.identity.seal(bob.identity.publicKey(), content)
    await relay.send(alice.messenger.session.token, 'bob', 'chat', [['dev1', first]])
    await relay.send(alice.messenger.session.token, 'bob', 'chat', [['dev1', second]])
    await bob.messenger.drainAll()
    expect(await bob.journal.history('alice')).toHaveLength(1)
  })
})

describe('B10: первое сообщение группы несёт определение', () => {
  it('получатель узнаёт о группе из первого же конверта', async () => {
    const relay = new FakeRelay()
    const alice = await makeUser(relay, 'alice')
    const bob = await makeUser(relay, 'bob')
    const groupId = await alice.messenger.createGroup('Новая', ['bob'])
    await bob.messenger.drainAll()
    const group = await new GroupsStore(bob.kv).get(groupId)
    expect(group?.name).toBe('Новая')
    expect(group?.members).toEqual(['alice', 'bob'])
  })
})

describe('B15: параллельные append не теряют записи', () => {
  it('одновременные записи получают разные ключи', async () => {
    const journal = new Journal(new MemoryKv(), new Uint8Array(32).fill(7))
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        journal.append('bob', { from: 'alice', timestamp: i, content: Env.escapeText(`m${i}`) }),
      ),
    )
    expect(await journal.count('bob')).toBe(20)
    expect(await journal.history('bob', 100)).toHaveLength(20)
  })

  it('append идемпотентен по (автор, ref)', async () => {
    const journal = new Journal(new MemoryKv(), new Uint8Array(32).fill(7))
    const record = { from: 'alice', timestamp: 1, content: Env.escapeText('повтор') }
    expect(await journal.append('bob', record)).toBe(true)
    expect(await journal.append('bob', record)).toBe(false)
    expect(await journal.count('bob')).toBe(1)
  })
})

describe('B21: непрочитанные не считают реакции и системные', () => {
  it('бейдж растёт только от видимых сообщений', async () => {
    const relay = new FakeRelay()
    const alice = await makeUser(relay, 'alice')
    const bob = await makeUser(relay, 'bob')
    await bob.messenger.sendText('alice', 'привет')
    await alice.messenger.drainAll()
    const [first] = await alice.journal.history('bob')
    await bob.messenger.react('alice', { ref: await refOf(first.content), ts: first.timestamp }, '🔥')
    await alice.messenger.drainAll()
    const summary = (await alice.messenger.chatSummaries()).find((s) => s.chatId === 'bob')!
    expect(summary.unread).toBe(1)
  })
})

describe('B26/B27: получатель и очередь', () => {
  it('отправка несуществующему получателю — ошибка, а не молчаливый успех', async () => {
    const relay = new FakeRelay()
    const alice = await makeUser(relay, 'alice')
    await expect(alice.messenger.sendText('nobody', 'привет')).rejects.toThrow(/не найден/)
    const failed = await alice.messenger.failedSends()
    expect(failed).toHaveLength(1)
    // ручное удаление убирает запись из очереди
    await alice.messenger.dropSend(failed[0].key)
    expect(await alice.messenger.failedSends()).toHaveLength(0)
  })

  it('два параллельных flushOutbox не шлют одно сообщение дважды', async () => {
    const relay = new FakeRelay()
    const alice = await makeUser(relay, 'alice')
    const bob = await makeUser(relay, 'bob')
    relay.offline = true
    await alice.messenger.sendText('bob', 'ровно один раз')
    relay.offline = false
    await Promise.all([alice.messenger.flushOutbox(), alice.messenger.flushOutbox()])
    await bob.messenger.drainAll()
    expect(await bob.journal.history('alice')).toHaveLength(1)
  })
})

describe('B1: журнал без ключа недоступен', () => {
  it('заблокированный журнал не шифрует нулевым ключом', async () => {
    const journal = new Journal(new MemoryKv(), null)
    expect(journal.locked).toBe(true)
    await expect(journal.history('bob')).rejects.toThrow(/недоступен/)
    journal.unlock(new Uint8Array(32).fill(1))
    expect(journal.locked).toBe(false)
    await journal.append('bob', { from: 'alice', timestamp: 1, content: Env.escapeText('ок') })
    expect(await journal.history('bob')).toHaveLength(1)
  })
})

describe('B11: аватары отключены до согласования формата', () => {
  it('setAvatar явно сообщает, что функция недоступна', async () => {
    const relay = new FakeRelay()
    const alice = await makeUser(relay, 'alice')
    await expect(
      alice.messenger.setAvatar(
        { id: '', key: new Uint8Array(0), size: 0, width: 0, height: 0, thumb: '', type: 'media', duration: 0, spoiler: false, sticker: false, videoNote: false, silent: false, viewOnce: false },
        new Uint8Array(1),
      ),
    ).rejects.toThrow(/недоступны/)
  })
})

describe('B7: wake-сигнал во время дрейна не теряется', () => {
  it('повторный drainAll посреди дренана поднимает флаг повтора и добирает очередь', async () => {
    const relay = new FakeRelay()
    const alice = await makeUser(relay, 'alice')
    const bob = await makeUser(relay, 'bob')
    await alice.messenger.sendText('bob', 'первое')

    let reentrant = -1
    let injected = false
    const originalDrain = relay.drainPage.bind(relay)
    relay.drainPage = async (token, after, limit) => {
      const page = await originalDrain(token, after, limit)
      if (!injected && page.messages.length > 0) {
        injected = true
        // пока идёт дрейн, приходит второе сообщение и повторный сигнал
        await alice.messenger.sendText('bob', 'второе')
        reentrant = await bob.messenger.drainAll()
      }
      return page
    }

    expect(await bob.messenger.drainAll()).toBe(2)
    expect(reentrant).toBe(0)
  })
})

describe('B8: ядовитое сообщение не теряет очередь', () => {
  it('сбой обработки не подтверждается; после 3 попыток — карантин', async () => {
    const relay = new FakeRelay()
    const bob = await makeUser(relay, 'bob')
    // перенос от себя же с битой полезной нагрузкой: decodeChunk бросит
    const garbage = await bob.identity.seal(bob.identity.publicKey(), new Uint8Array([1, 2, 3]))
    await relay.send(bob.messenger.session.token, 'bob', 'transfer', [['dev1', garbage]])

    // первые две попытки: без ack, сообщение остаётся в очереди
    expect(await bob.messenger.drainAll()).toBe(0)
    expect(await relay.drainPage(bob.messenger.session.token, 0)).toMatchObject({ messages: [expect.objectContaining({ kind: 'transfer' })] })
    expect(await bob.messenger.drainAll()).toBe(0)

    // третья попытка: карантин и ack — очередь пуста
    expect(await bob.messenger.drainAll()).toBe(0)
    expect((await relay.drainPage(bob.messenger.session.token, 0)).messages).toHaveLength(0)
    const quarantined = (await bob.kv.list('poison:')).length
    expect(quarantined).toBe(1)
  })
})

describe('B25: длинный текст не обрезается молча', () => {
  it('сообщение длиннее 4096 символов — ошибка, запись не создаётся', async () => {
    const relay = new FakeRelay()
    const alice = await makeUser(relay, 'alice')
    await expect(alice.messenger.sendText('bob', 'я'.repeat(4097))).rejects.toThrow(/4096/)
    expect(await alice.journal.history('bob')).toHaveLength(0)
  })
})

describe('B36: MIME аудио по сигнатуре', () => {
  it('webm/ogg/mp4/wav определяются, дефолт — webm', () => {
    expect(sniffAudioMime(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0, 0]))).toBe('audio/webm')
    expect(sniffAudioMime(new Uint8Array([...'OggS'].map((c) => c.charCodeAt(0))))).toBe('audio/ogg')
    const mp4 = new Uint8Array(12)
    mp4.set([...'ftyp'].map((c) => c.charCodeAt(0)), 4)
    expect(sniffAudioMime(mp4)).toBe('audio/mp4')
    const wav = new Uint8Array([...'RIFF'].map((c) => c.charCodeAt(0)))
    expect(sniffAudioMime(wav)).toBe('audio/wav')
    expect(sniffAudioMime(new Uint8Array([1, 2, 3]))).toBe('audio/webm')
  })
})

describe('B44: медиа-кэш вытесняет по времени доступа', () => {
  it('тронутая запись выживает, самая старая удаляется', async () => {
    const kv = new MemoryKv()
    const cache = new MediaCache(kv, 100) // потолок 100 байт
    await cache.put('a', new Uint8Array(40))
    await sleep(5)
    await cache.put('b', new Uint8Array(40))
    await sleep(5)
    expect(await cache.get('a')).not.toBeNull() // касание: 'a' свежее 'b'
    await sleep(5)
    await cache.put('c', new Uint8Array(40)) // 120 > 100 → вытесняем 'b'
    expect(await cache.has('a')).toBe(true)
    expect(await cache.has('b')).toBe(false)
    expect(await cache.has('c')).toBe(true)
  })

  it('битая мет — сирота: запись удаляется', async () => {
    const kv = new MemoryKv()
    const cache = new MediaCache(kv)
    await kv.put('media:x', new Uint8Array(10))
    await kv.put('mm:x', utf8('{{{не json'))
    await cache.put('y', new Uint8Array(10))
    expect(await kv.get('media:x')).toBeNull()
    expect(await kv.get('mm:x')).toBeNull()
  })
})

describe('B44: голос опроса находится по короткой ссылке', () => {
  it('votesFor матчит префикс полного ref (sameRef, а не строгое равно)', async () => {
    const relay = new FakeRelay()
    const alice = await makeUser(relay, 'alice')
    const bob = await makeUser(relay, 'bob')
    await alice.messenger.sendPoll('bob', 'Вопрос?', ['да', 'нет'], false)
    await bob.messenger.drainAll()

    const history = await bob.journal.history('alice')
    const parsed = parse(history[0].content)
    if (parsed.kind !== 'content' || parsed.content.kind !== 'poll') throw new Error('ожидали опрос')

    // боб голосует полной ссылкой, алиса спрашивает коротким префиксом
    const pollRef = await refOf(history[0].content)
    await bob.messenger.vote('alice', pollRef, 1)
    await alice.messenger.drainAll()
    const votes = await alice.messenger.votesFor('bob', pollRef.slice(0, 8), 2, 'alice')
    expect(votes.counts).toEqual([0, 1])
  })
})

void SystemFormat

// dev-параметр ?server= не должен уводить токен на произвольный хост
describe('devServerOverride', () => {
  it('принимает только http(s)-URL', () => {
    expect(devServerOverride('https://relay.test')).toBe('https://relay.test')
    expect(devServerOverride('http://127.0.0.1:8080')).toBe('http://127.0.0.1:8080')
    expect(devServerOverride('javascript:alert(1)')).toBeNull()
    expect(devServerOverride('data:text/html,x')).toBeNull()
    expect(devServerOverride('ftp://relay.test')).toBeNull()
    expect(devServerOverride('не-url')).toBeNull()
    expect(devServerOverride(null)).toBeNull()
    expect(devServerOverride('')).toBeNull()
  })
})
