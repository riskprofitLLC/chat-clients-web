// Мини-сервер в памяти для тестов домена: справочник ключей, per-device
// очереди, ack-дрейн, медиа. Повторяет контракт go/ для той части API,
// которой пользуется клиент.
import { fromBase64 } from '../src/util/b64.js'
import { RelayApi, type BatchRecipient, type DeviceInfo, type DeviceKey, type DrainPage, type OnlineStatus, type RegisterResult } from '../src/net/api.js'

interface QueueItem {
  id: number
  from: string
  kind: string
  blob: Uint8Array
}

export class FakeRelay extends RelayApi {
  private readonly devices = new Map<string, Map<string, Uint8Array>>()
  private readonly tokens = new Map<string, { login: string; device: string }>()
  private readonly queues = new Map<string, QueueItem[]>()
  private readonly media = new Map<string, Uint8Array>()
  private nextId = 1
  delivered: Array<{ from: string; toDevice: string }> = []
  reads: string[] = []
  typings: string[] = []
  calls: string[] = []
  // сеть «лежит»: проверка, что outbox не теряет сообщение
  offline = false

  constructor() {
    super('http://relay.test')
  }

  addAccount(login: string, device: string, pubSpki: Uint8Array, token: string): void {
    const perLogin = this.devices.get(login) ?? new Map<string, Uint8Array>()
    perLogin.set(device, pubSpki)
    this.devices.set(login, perLogin)
    this.tokens.set(token, { login, device })
  }

  private auth(token: string): { login: string; device: string } {
    const entry = this.tokens.get(token)
    if (!entry) throw new Error('нет авторизации')
    return entry
  }

  override async peerKeys(peer: string): Promise<DeviceKey[]> {
    const perLogin = this.devices.get(peer)
    if (!perLogin) return []
    return [...perLogin.entries()].map(([deviceId, pubSpki]) => ({ deviceId, pubSpki }))
  }

  override async send(token: string, to: string, kind: string, blobs: Array<[string, Uint8Array]>): Promise<void> {
    if (this.offline) throw new Error('сеть недоступна')
    const auth = this.auth(token)
    for (const [deviceId, blob] of blobs) {
      const perLogin = this.devices.get(to)
      if (!perLogin?.has(deviceId)) continue
      const key = `${to}:${deviceId}`
      const queue = this.queues.get(key) ?? []
      queue.push({ id: this.nextId++, from: auth.login, kind, blob })
      this.queues.set(key, queue)
    }
  }

  override async sendBatch(token: string, kind: string, recipients: BatchRecipient[]): Promise<Map<string, number>> {
    for (const recipient of recipients) {
      await this.send(token, recipient.to, kind, recipient.blobs)
    }
    return new Map()
  }

  override async drainPage(token: string, after: number, limit?: number): Promise<DrainPage> {
    const auth = this.auth(token)
    const key = `${auth.login}:${auth.device}`
    const queue = (this.queues.get(key) ?? []).filter((item) => item.id > after)
    const page = queue.slice(0, limit ?? 200)
    return {
      messages: page.map((item) => ({ from: item.from, kind: item.kind, blob: item.blob, serverId: item.id })),
      more: queue.length > page.length,
    }
  }

  override async ackMessages(token: string, ids: number[]): Promise<void> {
    const auth = this.auth(token)
    const key = `${auth.login}:${auth.device}`
    const queue = this.queues.get(key) ?? []
    this.queues.set(key, queue.filter((item) => !ids.includes(item.id)))
  }

  override async typing(_token: string, to: string): Promise<void> {
    this.typings.push(to)
  }

  override async confirmDelivered(_token: string, fromUser: string, toDevice: string): Promise<void> {
    this.delivered.push({ from: fromUser, toDevice })
  }

  override async confirmRead(_token: string, fromUser: string): Promise<void> {
    this.reads.push(fromUser)
  }

  override async uploadMedia(_token: string, data: Uint8Array): Promise<string> {
    const id = [...data.slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('').padEnd(64, '0')
    this.media.set(id, data)
    return id
  }

  override async downloadMedia(_token: string, id: string): Promise<Uint8Array> {
    const data = this.media.get(id)
    if (!data) throw new Error('не найдено')
    return data
  }

  override async createCallSession(_token: string, callId: string): Promise<void> {
    this.calls.push(callId)
  }

  override async checkOnline(): Promise<OnlineStatus> {
    return { online: true, lastSeenUnix: 0 }
  }

  override async listDevices(): Promise<DeviceInfo[]> {
    return []
  }

  override async register(email: string, code: string, _password: string, deviceId: string, pubB64: string): Promise<RegisterResult> {
    void email
    void code
    const login = email.split('@')[0] ?? 'user'
    const token = `token-${login}-${deviceId}`
    this.addAccount(login, deviceId, fromBase64(pubB64) ?? new Uint8Array(0), token)
    return { token, userId: login }
  }
}
