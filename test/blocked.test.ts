// Блок-лист отправителей (P-W4): стор и реальное глушение входящих —
// блоб заблокированного отправителя сбрасывается при дрейне, доставка
// подтверждается (ретраи не копятся), в журнал и уведомления не попадает.
import { afterEach, describe, expect, it } from 'vitest'
import { MemoryKv } from '../src/store/kv.js'
import { BlockedSendersStore, normalizeLogin } from '../src/store/blocked.js'
import { Journal } from '../src/store/journal.js'
import { SecretsStore } from '../src/store/secrets.js'
import { PrefsStore } from '../src/store/prefs.js'
import { KeysStore } from '../src/store/keys.js'
import { ContactsStore } from '../src/store/contacts.js'
import { GroupsStore } from '../src/store/groups.js'
import { ProfilesStore } from '../src/store/profiles.js'
import { CallLogStore, DraftsStore, MarksStore, MediaCache, PinsStore } from '../src/store/chat-state.js'
import { Messenger } from '../src/domain/messenger.js'
import { SessionInfo } from '../src/app/session.js'
import { generateIdentity } from '../src/crypto/identity.js'
import { generateKeyPair } from '../src/crypto/primitives.js'
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

describe('BlockedSendersStore', () => {
  it('блокировка и разблокировка по логину в нижнем регистре', async () => {
    const store = new BlockedSendersStore(new MemoryKv())
    expect(normalizeLogin('  Bob ')).toBe('bob')
    await store.block('Bob')
    expect(await store.isBlocked('bob')).toBe(true)
    expect(await store.isBlocked('BOB')).toBe(true)
    expect(await store.all()).toEqual(['bob'])
    await store.block('alice')
    expect(await store.all()).toEqual(['alice', 'bob'])
    await store.unblock('BOB')
    expect(await store.isBlocked('bob')).toBe(false)
    expect(await store.all()).toEqual(['alice'])
  })

  it('пустой логин не блокируется', async () => {
    const store = new BlockedSendersStore(new MemoryKv())
    await expect(store.block('   ')).rejects.toThrow()
    expect(await store.all()).toEqual([])
  })
})

describe('блокировка входящих (P-W4)', () => {
  it('сообщение заблокированного отправителя не попадает в журнал и не нотифицирует', async () => {
    const relay = new FakeRelay()
    const alice = await makeUser(relay, 'alice')
    const bob = await makeUser(relay, 'bob')
    await alice.messenger.sendText('bob', 'привет')
    // до блокировки сообщение доходит
    await bob.messenger.drainAll()
    expect(await bob.journal.count('alice')).toBe(1)

    const blocked = new BlockedSendersStore(bob.kv)
    await blocked.block('alice')
    await alice.messenger.sendText('bob', 'ещё одно')
    let events = 0
    bob.messenger.onEvent(() => {
      events++
    })
    expect(await bob.messenger.drainAll()).toBe(0)
    // журнал не вырос, событий чата не было — уведомления не пришли
    expect(await bob.journal.count('alice')).toBe(1)
    expect(events).toBe(0)
    // очередь опустела: блоб подтверждён, у отправителя не копятся ретраи
    const page = await relay.drainPage('token-bob-dev1', 0)
    expect(page.messages).toEqual([])
    // разблокировка возвращает приём
    await blocked.unblock('alice')
    await alice.messenger.sendText('bob', 'третье')
    expect(await bob.messenger.drainAll()).toBe(1)
    expect(await bob.journal.count('alice')).toBe(2)
  })
})
