// Сборка приложения: хранилище, ключи, сеть, мессенджер, звонки.
// Аналог data/AppContainer.kt — одно место, где всё связано.
import { RelayApi } from '../net/api.js'
import { defaultKv, type Kv } from '../store/kv.js'
import { Journal } from '../store/journal.js'
import { SecretsStore } from '../store/secrets.js'
import { PrefsStore, type Prefs } from '../store/prefs.js'
import { KeysStore } from '../store/keys.js'
import { ContactsStore } from '../store/contacts.js'
import { GroupsStore } from '../store/groups.js'
import { ProfilesStore } from '../store/profiles.js'
import { CallLogStore, DraftsStore, MarksStore, MediaCache, PinsStore } from '../store/chat-state.js'
import { Messenger } from '../domain/messenger.js'
import { CallManager } from '../calls/manager.js'
import { SessionInfo } from './session.js'
import { generateIdentity, identityFromKeys, type E2E } from '../crypto/identity.js'
import { toBase64 } from '../util/b64.js'

export interface LoginResult {
  token: string
  userId: string
}

export class AppContext {
  readonly kv: Kv
  readonly api: RelayApi
  readonly secrets: SecretsStore
  readonly prefsStore: PrefsStore
  readonly journal: Journal
  readonly keys: KeysStore
  readonly contacts: ContactsStore
  readonly groups: GroupsStore
  readonly profiles: ProfilesStore
  readonly drafts: DraftsStore
  readonly pins: PinsStore
  readonly marks: MarksStore
  readonly media: MediaCache
  readonly callLog: CallLogStore
  prefs: Prefs
  session: SessionInfo | null = null
  messenger: Messenger | null = null
  calls: CallManager | null = null

  private constructor(kv: Kv, prefs: Prefs) {
    this.kv = kv
    this.prefs = prefs
    this.api = new RelayApi(prefs.serverUrl)
    this.secrets = new SecretsStore(kv)
    this.prefsStore = new PrefsStore(kv)
    this.keys = new KeysStore(kv)
    this.contacts = new ContactsStore(kv)
    this.groups = new GroupsStore(kv)
    this.profiles = new ProfilesStore(kv)
    this.drafts = new DraftsStore(kv)
    this.pins = new PinsStore(kv)
    this.marks = new MarksStore(kv)
    this.media = new MediaCache(kv)
    this.callLog = new CallLogStore(kv)
    // журнал создаётся ключом данных; до регистрации ключа ещё нет,
    // поэтому пустой журнал работает на временном ключе и заменяется в openSession
    this.journal = new Journal(kv, new Uint8Array(32))
  }

  static async create(kv: Kv = defaultKv()): Promise<AppContext> {
    const prefsStore = new PrefsStore(kv)
    let prefs = await prefsStore.load()
    // скрытый параметр ?server= — для LAN-стендов и автотестов; в UI не показывается
    const fromUrl = new URLSearchParams(location.search).get('server')
    if (fromUrl) prefs = await prefsStore.patch({ serverUrl: fromUrl })
    return new AppContext(kv, prefs)
  }

  // журнал пересоздаётся ключом данных — до этого момента истории нет
  private rewireJournal(dataKey: Uint8Array): Journal {
    const journal = new Journal(this.kv, dataKey)
    Object.assign(this, { journal })
    return journal
  }

  async savePrefs(changes: Partial<Prefs>): Promise<void> {
    this.prefs = await this.prefsStore.patch(changes)
    this.api.setBaseUrl(this.prefs.serverUrl)
  }

  async serverUrl(): Promise<string> {
    return this.prefs.serverUrl
  }

  // ─── вход и регистрация ────────────────────────────────────────────────

  // регистрация: email → код на почту → пароль; устройство привязывается сразу
  async register(email: string, code: string, password: string): Promise<LoginResult> {
    const dataKey = await this.secrets.ensureDataKey()
    this.rewireJournal(dataKey)
    const identity = await generateIdentity()
    const deviceId = await this.secrets.deviceId()
    const result = await this.api.register(email, code, password, deviceId, toBase64(identity.publicKey()))
    await this.secrets.saveIdentity(identity.keyBlobs())
    await this.secrets.saveToken(result.token)
    await this.secrets.saveLogin(result.userId)
    await this.secrets.saveEmail(email)
    await this.openSession(identity, result)
    return result
  }

  // вход: работает только для устройства, уже привязанного к аккаунту
  // (регистрацией или линковкой) — иначе сервер отвечает «устройство не привязано»
  async login(identifier: string, password: string, cloudPassword = ''): Promise<LoginResult> {
    const blobs = await this.secrets.loadIdentity()
    if (!blobs) throw new Error('на этом устройстве нет ключей: используйте привязку нового устройства')
    const deviceId = await this.secrets.deviceId()
    const result = await this.api.login(identifier, password, deviceId, cloudPassword)
    await this.secrets.saveToken(result.token)
    await this.secrets.saveLogin(result.userId)
    await this.openSession(identityFromKeys(blobs.secretPkcs8, blobs.publicSpki), result)
    return result
  }

  // ─── привязка нового устройства ────────────────────────────────────────

  // шаг 1 нового устройства: ключ и код для старого устройства
  async linkStart(): Promise<{ nonce: string; pollSecret: string; fingerprint: string; pubB64: string; identity: E2E }> {
    const dataKey = await this.secrets.ensureDataKey()
    this.rewireJournal(dataKey)
    const identity = await generateIdentity()
    const deviceId = await this.secrets.deviceId()
    const init = await this.api.linkInit(deviceId, toBase64(identity.publicKey()))
    const { sha256 } = await import('../crypto/primitives.js')
    const { toHex } = await import('../util/bytes.js')
    const fingerprint = toHex(await sha256(identity.publicKey())).slice(0, 32)
    // ключи попадают на диск ТОЛЬКО после успешной привязки
    this.pendingIdentity = identity
    return { nonce: init.nonce, pollSecret: init.pollSecret, fingerprint, pubB64: toBase64(identity.publicKey()), identity }
  }

  private pendingIdentity: E2E | null = null

  async linkPoll(nonce: string, pollSecret: string): Promise<LoginResult | null> {
    const result = await this.api.linkPoll(nonce, pollSecret)
    if (!result) return null
    const identity = this.pendingIdentity
    if (!identity) throw new Error('ключ привязки потерян: начните заново')
    await this.secrets.saveIdentity(identity.keyBlobs())
    await this.secrets.saveToken(result.token)
    await this.secrets.saveLogin(result.userId)
    await this.openSession(identity, result)
    this.pendingIdentity = null
    return result
  }

  // шаг 2 старого устройства: подтверждение кода нового устройства
  async linkConfirm(nonce: string, newDevicePub: string): Promise<void> {
    if (!this.session) throw new Error('сначала войдите на этом устройстве')
    await this.api.linkConfirm(this.session.token, nonce.trim(), newDevicePub)
  }

  // ─── выход ─────────────────────────────────────────────────────────────

  async logout(): Promise<void> {
    this.messenger?.stop()
    this.messenger = null
    this.calls = null
    this.session = null
    await this.secrets.logout()
  }

  // полная очистка устройства: история, ключи, настройки
  async wipe(): Promise<void> {
    this.messenger?.stop()
    this.messenger = null
    this.calls = null
    this.session = null
    await this.secrets.wipe()
    this.prefs = await this.prefsStore.load()
  }

  // ─── активная сессия ───────────────────────────────────────────────────

  async restore(): Promise<boolean> {
    const blobs = await this.secrets.loadIdentity()
    const token = await this.secrets.token()
    const login = await this.secrets.login()
    if (!blobs || !token || !login) return false
    const dataKey = await this.secrets.dataKey()
    if (dataKey) this.rewireJournal(dataKey)
    const identity = identityFromKeys(blobs.secretPkcs8, blobs.publicSpki)
    await this.openSession(identity, { token, userId: login })
    return true
  }

  private async openSession(identity: E2E, result: LoginResult): Promise<void> {
    const deviceId = await this.secrets.deviceId()
    const session = new SessionInfo(result.userId, result.token, deviceId, identity, this.api)
    this.session = session
    // ключ публикуем заново: после переустановки сервер мог знать старый
    try {
      await this.api.putKey(session.token, deviceId, toBase64(identity.publicKey()))
    } catch {
      // 409 «ключ уже закреплён» — норма для повторного входа
    }
    const messenger = new Messenger({
      kv: this.kv,
      api: this.api,
      session,
      journal: this.journal,
      prefs: this.prefsStore,
      keys: this.keys,
      contacts: this.contacts,
      groups: this.groups,
      profiles: this.profiles,
      drafts: this.drafts,
      pins: this.pins,
      marks: this.marks,
      media: this.media,
      callLog: this.callLog,
    })
    this.messenger = messenger
    this.calls = new CallManager(messenger, async () => this.prefs)
    await messenger.start()
  }
}
