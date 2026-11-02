// HTTP-клиент протокола сервера — порт net/RelayApi.kt на fetch.
// Тело и ответы — байты: сообщения и медиа сервер видит только как opaque-блобы.
import { fromBase64, toBase64 } from '../util/b64.js'
import { text, utf8 } from '../util/bytes.js'

export class RelayError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string,
  ) {
    super(message)
    this.name = 'RelayError'
  }
}

export interface RelayMessage {
  from: string
  kind: string
  blob: Uint8Array
  serverId: number
}

export interface DrainPage {
  messages: RelayMessage[]
  more: boolean
}

export interface DeviceKey {
  deviceId: string
  pubSpki: Uint8Array
}

export interface BatchRecipient {
  to: string
  blobs: Array<[string, Uint8Array]>
}

export interface DeviceInfo {
  deviceId: string
  current: boolean
}

export interface OnlineStatus {
  online: boolean
  lastSeenUnix: number
}

export interface RegisterResult {
  token: string
  userId: string
}

export class RelayApi {
  constructor(private baseUrl: string) {}

  setBaseUrl(url: string): void {
    this.baseUrl = url
  }

  private url(...segments: string[]): string {
    const base = this.baseUrl.trim().replace(/\/+$/, '')
    if (!base) throw new RelayError(0, null, 'некорректный адрес сервера')
    // сегменты экранируются: peer/media id не сломают путь
    return `${base}/${segments.map(encodeURIComponent).join('/')}`
  }

  private async exchange(
    method: string,
    target: string,
    body: Uint8Array | null,
    token: string | null,
    contentType = 'application/json',
    onProgress?: (percent: number) => void,
  ): Promise<Uint8Array> {
    const headers: Record<string, string> = {}
    if (token) headers.Authorization = `Bearer ${token}`
    if (body) headers['Content-Type'] = contentType
    let response: Response
    try {
      response = await fetch(target, { method, headers, body: body as BodyInit | null })
    } catch (error) {
      throw new RelayError(0, null, `сеть недоступна: ${(error as Error).message}`)
    }
    onProgress?.(100)
    const raw = new Uint8Array(await response.arrayBuffer())
    if (!response.ok) {
      const message = text(raw) || `HTTP ${response.status}`
      throw new RelayError(response.status, errorCodeOf(message), message)
    }
    return raw
  }

  private async json(
    method: string,
    target: string,
    body: unknown,
    token: string | null,
  ): Promise<Record<string, unknown>> {
    const raw = await this.exchange(
      method,
      target,
      body === null ? null : utf8(JSON.stringify(body)),
      token,
    )
    const value = text(raw)
    if (!value) return {}
    try {
      return JSON.parse(value) as Record<string, unknown>
    } catch {
      throw new RelayError(502, null, 'некорректный ответ сервера')
    }
  }

  // ─── авторизация ───────────────────────────────────────────────────────

  // dev-релей возвращает код в ответе (CHAT_DEV_MODE=1) — тогда отдаём его
  // вызывающему, чтобы локальная проверка не требовала почты
  async requestCode(email: string): Promise<string | null> {
    const body = await this.json('POST', this.url('v1', 'email-code'), { email: email.trim().toLowerCase() }, null)
    const code = String(body.code ?? '')
    return /^\d{4}$/.test(code) ? code : null
  }

  async register(email: string, code: string, password: string, deviceId: string, pubB64: string): Promise<RegisterResult> {
    const body = await this.json(
      'POST',
      this.url('v1', 'accounts'),
      {
        email: email.trim().toLowerCase(),
        code: code.trim(),
        password,
        device_id: deviceId,
        pub_spki: pubB64,
      },
      null,
    )
    return { token: String(body.token ?? ''), userId: String(body.user_id ?? '') }
  }

  // cloudPassword нужен только при включённом облачном пароле 2FA;
  // сервер отвечает кодом cloudpw_required, клиент спрашивает и повторяет
  async login(identifier: string, password: string, deviceId: string, cloudPassword = ''): Promise<RegisterResult> {
    const body = await this.json(
      'POST',
      this.url('v1', 'login'),
      { login: identifier.trim().toLowerCase(), password, device_id: deviceId, cloudpw: cloudPassword },
      null,
    )
    return { token: String(body.token ?? ''), userId: String(body.user_id ?? '') }
  }

  async putKey(token: string, deviceId: string, pubB64: string): Promise<void> {
    await this.json('PUT', this.url('v1', 'keys', deviceId), { pub_spki: pubB64 }, token)
  }

  async peerKeys(peer: string): Promise<DeviceKey[]> {
    const body = await this.json('GET', this.url('v1', 'keys', peer), null, null)
    const devices = Array.isArray(body.devices) ? (body.devices as Array<Record<string, unknown>>) : []
    const out: DeviceKey[] = []
    for (const device of devices) {
      const pub = fromBase64(String(device.pub_spki ?? ''))
      if (!pub) continue
      out.push({ deviceId: String(device.device_id ?? ''), pubSpki: pub })
    }
    return out
  }

  // ─── сообщения ─────────────────────────────────────────────────────────

  async send(token: string, to: string, kind: string, blobs: Array<[string, Uint8Array]>): Promise<void> {
    await this.json(
      'POST',
      this.url('v1', 'messages'),
      {
        to_user: to,
        kind,
        blobs: blobs.map(([deviceId, blob]) => ({ device_id: deviceId, blob: toBase64(blob) })),
      },
      token,
    )
  }

  // batch: все получатели одним запросом (группа из 50 не упирается в лимит сообщений)
  async sendBatch(token: string, kind: string, recipients: BatchRecipient[]): Promise<Map<string, number>> {
    const body = await this.json(
      'POST',
      this.url('v1', 'messages', 'batch'),
      {
        kind,
        recipients: recipients.map((r) => ({
          to_user: r.to,
          blobs: r.blobs.map(([deviceId, blob]) => ({ device_id: deviceId, blob: toBase64(blob) })),
        })),
      },
      token,
    )
    const errors = new Map<string, number>()
    const list = Array.isArray(body.errors) ? (body.errors as Array<Record<string, unknown>>) : []
    for (const item of list) errors.set(String(item.to_user ?? ''), Number(item.status ?? 500))
    return errors
  }

  // страница ack-дрейна: сервер не удаляет до подтверждения (ack=1)
  async drainPage(token: string, after: number, limit?: number): Promise<DrainPage> {
    const params = new URLSearchParams({ ack: '1' })
    if (after > 0) params.set('after', String(after))
    if (limit) params.set('limit', String(limit))
    const body = await this.json('GET', `${this.url('v1', 'messages')}?${params.toString()}`, null, token)
    const messages = Array.isArray(body.messages) ? (body.messages as Array<Record<string, unknown>>) : []
    const out: RelayMessage[] = []
    for (const message of messages) {
      const blob = fromBase64(String(message.blob ?? ''))
      if (!blob) continue
      out.push({
        from: String(message.from_user ?? ''),
        kind: String(message.kind ?? 'chat'),
        blob,
        serverId: Number(message.id ?? 0),
      })
    }
    return { messages: out, more: body.more === true }
  }

  async ackMessages(token: string, ids: number[]): Promise<void> {
    if (ids.length === 0) return
    // чанки по 500: тело держим в пределах лимита сервера
    for (let i = 0; i < ids.length; i += 500) {
      await this.json('POST', this.url('v1', 'messages', 'ack'), { ids: ids.slice(i, i + 500) }, token)
    }
  }

  async typing(token: string, to: string): Promise<void> {
    try {
      await this.json('POST', this.url('v1', 'typing'), { to_user: to }, token)
    } catch {
      // индикатор набора не критичен: молчание не должно ломать ввод
    }
  }

  async confirmDelivered(token: string, fromUser: string, toDevice: string): Promise<void> {
    await this.json('POST', this.url('v1', 'delivered'), { from_user: fromUser, to_device: toDevice }, token)
  }

  async confirmRead(token: string, fromUser: string): Promise<void> {
    await this.json('POST', this.url('v1', 'read'), { from_user: fromUser }, token)
  }

  // ─── медиа ─────────────────────────────────────────────────────────────

  async uploadMedia(token: string, data: Uint8Array, onProgress?: (percent: number) => void): Promise<string> {
    const raw = await this.exchange(
      'POST',
      this.url('v1', 'media'),
      data,
      token,
      'application/octet-stream',
      onProgress,
    )
    const body = JSON.parse(text(raw)) as Record<string, unknown>
    return String(body.media_id ?? '')
  }

  async downloadMedia(token: string, id: string): Promise<Uint8Array> {
    return this.exchange('GET', this.url('v1', 'media', id), null, token)
  }

  // ─── контакты, устройства, аккаунт ─────────────────────────────────────

  async discover(token: string, emailHashes: string[]): Promise<Array<{ login: string; emailHash: string }>> {
    const body = await this.json('POST', this.url('v1', 'discover'), { email_hashes: emailHashes }, token)
    const matches = Array.isArray(body.matches) ? (body.matches as Array<Record<string, unknown>>) : []
    return matches.map((m) => ({ login: String(m.login ?? ''), emailHash: String(m.email_hash ?? '') }))
  }

  async listDevices(token: string): Promise<DeviceInfo[]> {
    const body = await this.json('GET', this.url('v1', 'devices'), null, token)
    const list = Array.isArray(body.devices) ? (body.devices as Array<Record<string, unknown>>) : []
    return list.map((d) => ({ deviceId: String(d.device_id ?? ''), current: d.current === true }))
  }

  async revokeDevice(token: string, deviceId: string): Promise<void> {
    await this.json('POST', this.url('v1', 'devices', 'revoke'), { device_id: deviceId }, token)
  }

  async changeEmail(token: string, newEmail: string, code: string): Promise<void> {
    await this.json('POST', this.url('v1', 'account', 'email'), { new_email: newEmail.trim().toLowerCase(), code: code.trim() }, token)
  }

  async changePassword(token: string, currentPassword: string, newPassword: string): Promise<void> {
    await this.json('POST', this.url('v1', 'account', 'password'), { current_password: currentPassword, new_password: newPassword }, token)
  }

  async deleteAccount(token: string, password: string): Promise<void> {
    await this.json('POST', this.url('v1', 'account', 'delete'), { password }, token)
  }

  async setCloudPassword(token: string, currentPassword: string, cloudPassword: string): Promise<void> {
    await this.json('POST', this.url('v1', 'account', 'cloudpw'), { current_password: currentPassword, cloudpw: cloudPassword }, token)
  }

  async setAccountInactivity(token: string, password: string, months: number): Promise<void> {
    await this.json('POST', this.url('v1', 'account', 'inactivity'), { password, months }, token)
  }

  async reportUser(token: string, toUser: string, reason: string): Promise<void> {
    await this.json('POST', this.url('v1', 'report'), { to_user: toUser, reason: reason.slice(0, 500) }, token)
  }

  async checkOnline(token: string, user: string): Promise<OnlineStatus> {
    const body = await this.json('POST', this.url('v1', 'online'), { user }, token)
    return { online: Number(body.online ?? 0) === 1, lastSeenUnix: Number(body.last_seen ?? 0) }
  }

  async setPresenceHidden(token: string, hide: boolean): Promise<void> {
    await this.json('POST', this.url('v1', 'presence', 'privacy'), { hide }, token)
  }

  async registerPushToken(token: string, pushToken: string, platform = 'web'): Promise<void> {
    await this.json('POST', this.url('v1', 'push'), { token: pushToken, platform }, token)
  }

  // ─── звонки ────────────────────────────────────────────────────────────

  async createCallSession(token: string, callId: string): Promise<void> {
    await this.json('POST', this.url('v1', 'calls'), { call_id: callId }, token)
  }

  callPipeUrl(callId: string): string {
    const base = this.url('v1', 'calls', callId, 'ws')
    return base.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:')
  }

  wsUrl(): string {
    return this.url('v1', 'ws').replace(/^http:/, 'ws:').replace(/^https:/, 'wss:')
  }

  // ─── линковка нового устройства ────────────────────────────────────────

  async linkInit(deviceId: string, pubB64: string): Promise<{ nonce: string; pollSecret: string }> {
    const body = await this.json('POST', this.url('v1', 'link', 'init'), { device_id: deviceId, pub_spki: pubB64 }, null)
    return { nonce: String(body.nonce ?? ''), pollSecret: String(body.poll_secret ?? '') }
  }

  async linkConfirm(token: string, nonce: string, pubB64: string): Promise<void> {
    await this.json('POST', this.url('v1', 'link', 'confirm'), { nonce, pub_spki: pubB64 }, token)
  }

  async linkPoll(nonce: string, pollSecret?: string): Promise<RegisterResult | null> {
    const params = pollSecret ? `?secret=${encodeURIComponent(pollSecret)}` : ''
    const body = await this.json('GET', `${this.url('v1', 'link', nonce)}${params}`, null, null)
    if (body.status !== 'linked') return null
    return { token: String(body.token ?? ''), userId: String(body.user_id ?? '') }
  }
}

// сервер отвечает {"error":"code","message":"..."} — код важнее текста
function errorCodeOf(message: string): string | null {
  try {
    const parsed = JSON.parse(message) as Record<string, unknown>
    const code = String(parsed.error ?? '')
    return code || null
  } catch {
    return null
  }
}

export function isCloudPasswordRequired(error: unknown): boolean {
  return error instanceof RelayError && (error.code === 'cloudpw_required' || error.status === 401 && error.message.includes('облачный пароль'))
}
