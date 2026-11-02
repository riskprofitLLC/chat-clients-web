// Ядро обмена: сборка конверта, fan-out по устройствам, приём с ack-страницами,
// дедуп, реакции/правки/удаления/закрепы, группы, статусы.
// Порт data/MessageRepository.kt — та же логика и те же wire-форматы.
import * as Env from '../protocol/envelope.js'
import {
  BioFormat,
  CallFormat,
  ContactFormat,
  DraftFormat,
  EditFormat,
  GeoFormat,
  GroupFormat,
  MediaJson,
  PinFormat,
  PollFormat,
  ReplyFormat,
  ReactionFormat,
  SyncFormat,
  SystemFormat,
  VoteFormat,
  DeleteFormat,
  type CallEvent,
  type GroupInfo,
  type MediaInfo,
} from '../protocol/formats.js'
import { parse, type Kind } from '../protocol/codec.js'
import { refOf } from '../protocol/refs.js'
import { applyDelete, applyEdit } from './journal-ops.js'
import { aggregateReactions, type ReactionEntry } from './reactions.js'
import { aggregateVotes, type VoteEntry } from './polls.js'
import { CallGate, type CallVerdict } from './callgate.js'
import { DedupIndex } from './dedup.js'
import { verdict as tofuVerdict } from './tofu.js'
import { chunkItems, decodeChunk, encodeChunk, type TransferItem } from './transfer.js'
import { Outbox, type PendingSend } from '../store/outbox.js'
import { Journal, type MessageRecord } from '../store/journal.js'
import { CallLogStore, DraftsStore, MarksStore, MediaCache, PinsStore, type CallLogEntry } from '../store/chat-state.js'
import { ContactsStore } from '../store/contacts.js'
import { GroupsStore } from '../store/groups.js'
import { KeysStore } from '../store/keys.js'
import { ProfilesStore } from '../store/profiles.js'
import { PrefsStore } from '../store/prefs.js'
import { WsClient } from '../net/ws.js'
import { RelayError, type BatchRecipient, type DeviceKey, type RelayApi, type RelayMessage } from '../net/api.js'
import { SessionInfo, type DeviceKeyPair } from '../app/session.js'
import type { Kv } from '../store/kv.js'

// смена состава устройств собеседника: отправка блокируется до подтверждения
export class KeyChangedError extends Error {
  constructor(
    readonly peer: string,
    readonly devices: string[],
    readonly isNewDevice: boolean,
  ) {
    super(`ключи изменились: ${peer}`)
    this.name = 'KeyChangedError'
  }
}

export interface ChatSummary {
  chatId: string
  title: string
  isGroup: boolean
  group?: GroupInfo
  lastRecord: MessageRecord | null
  lastKind: Kind | null
  lastTs: number
  unread: number
  draft: string
  pinned: string[]
  typing: boolean
  members: number
  profileBio: string
}

export type MessengerEvent =
  | { type: 'chat'; chatId: string }
  | { type: 'typing'; chatId: string }
  | { type: 'presence'; connected: boolean }
  | { type: 'call'; from: string; self: boolean; verdict: CallVerdict }
  | { type: 'keys-changed'; peer: string; devices: string[]; isNewDevice: boolean }
  | { type: 'error'; message: string }

export interface MessengerDeps {
  kv: Kv
  api: RelayApi
  session: SessionInfo
  journal: Journal
  prefs: PrefsStore
  keys: KeysStore
  contacts: ContactsStore
  groups: GroupsStore
  profiles: ProfilesStore
  drafts: DraftsStore
  pins: PinsStore
  marks: MarksStore
  media: MediaCache
  callLog: CallLogStore
}

const KEY_TTL_MS = 60_000
const DRAIN_MAX_PAGES = 1024
const TYPING_THROTTLE_MS = 3_000
const BATCH_CHUNK = 128

export class Messenger {
  readonly outbox: Outbox
  private readonly dedup = new DedupIndex()
  private readonly callGate = new CallGate()
  private readonly keyCache = new Map<string, { at: number; devices: DeviceKey[] }>()
  private readonly typingSent = new Map<string, number>()
  private readonly typingSeen = new Map<string, number>()
  private readonly listeners = new Set<(event: MessengerEvent) => void>()
  private ws: WsClient | null = null
  private stopped = true
  private draining = false
  private outboxTimer: ReturnType<typeof setInterval> | null = null
  private typingTimer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly deps: MessengerDeps) {
    this.outbox = new Outbox(deps.kv)
  }

  get session(): SessionInfo {
    return this.deps.session
  }

  get prefs(): PrefsStore {
    return this.deps.prefs
  }

  get journal(): Journal {
    return this.deps.journal
  }

  onEvent(listener: (event: MessengerEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(event: MessengerEvent): void {
    for (const listener of this.listeners) listener(event)
  }

  // ─── жизненный цикл ────────────────────────────────────────────────────

  async start(): Promise<void> {
    this.stopped = false
    await this.seedDedup()
    await this.flushOutbox()
    await this.drainAll()
    this.connectWs()
    this.outboxTimer = setInterval(() => void this.flushOutbox().catch(() => {}), 15_000)
    // индикатор «печатает» живёт 5 секунд после сигнала
    this.typingTimer = setInterval(() => {
      const now = Date.now()
      let changed = false
      for (const [chatId, at] of this.typingSeen) {
        if (now - at > 5_000) {
          this.typingSeen.delete(chatId)
          changed = true
        }
      }
      if (changed) for (const chatId of this.typingSeen.keys()) this.emit({ type: 'typing', chatId })
    }, 2_000)
  }

  stop(): void {
    this.stopped = true
    this.ws?.close()
    this.ws = null
    if (this.outboxTimer) clearInterval(this.outboxTimer)
    if (this.typingTimer) clearInterval(this.typingTimer)
  }

  private connectWs(): void {
    if (this.stopped) return
    const url = this.deps.api.wsUrl()
    this.ws = new WsClient(url, this.deps.session.token, {
      onSignal: (signal) => void this.onSignal(signal),
      onState: (connected) => this.emit({ type: 'presence', connected }),
      onAuthError: () => this.emit({ type: 'error', message: 'токен отозван — войдите заново' }),
    })
  }

  private async onSignal(signal: string): Promise<void> {
    if (signal.startsWith('typing:')) {
      const from = signal.slice('typing:'.length)
      this.typingSeen.set(from, Date.now())
      this.emit({ type: 'typing', chatId: from })
      return
    }
    if (signal.startsWith('delivered:') || signal.startsWith('read:')) {
      const peer = signal.startsWith('read:') ? signal.slice(5) : signal.split(':')[1] ?? ''
      this.emit({ type: 'chat', chatId: peer })
      return
    }
    // "newmsg": забираем очередь
    await this.drainAll()
  }

  // ─── приём ─────────────────────────────────────────────────────────────

  // посев дедупа хвостом журнала: после перезапуска уже обработанные блобы
  // не должны обрабатываться повторно
  private async seedDedup(): Promise<void> {
    for (const chatId of await this.deps.journal.chatIds()) {
      const records = await this.deps.journal.history(chatId, 64)
      for (const record of records) this.dedup.remember(`${chatId}:${record.timestamp}`)
    }
  }

  async drainAll(): Promise<number> {
    if (this.draining) return 0
    this.draining = true
    let saved = 0
    try {
      let after = 0
      let pages = 0
      while (true) {
        const page = await this.deps.api.drainPage(this.deps.session.token, after)
        if (page.messages.length === 0) break
        const ack: number[] = []
        for (const message of page.messages) {
          try {
            if (await this.handleIncoming(message)) saved++
          } catch (error) {
            // одно битое сообщение не должно останавливать дрейн очереди
            this.emit({ type: 'error', message: `сообщение пропущено: ${(error as Error).message}` })
          }
          if (message.serverId > 0) ack.push(message.serverId)
        }
        // подтверждаем ТОЛЬКО после обработки страницы: сбой не теряет записи
        if (ack.length > 0) {
          try {
            await this.deps.api.ackMessages(this.deps.session.token, ack)
          } catch {
            // сбой подтверждения не критичен: сервер отдаст снова, дедуп снимет
          }
        }
        if (!page.more) break
        const last = page.messages[page.messages.length - 1]?.serverId ?? 0
        if (last <= after || ++pages > DRAIN_MAX_PAGES) break
        after = last
      }
    } finally {
      this.draining = false
    }
    if (saved > 0) this.emit({ type: 'chat', chatId: '' })
    return saved
  }

  private async handleIncoming(message: RelayMessage): Promise<boolean> {
    const key = await this.deps.session.dedupKey(message.from, message.blob)
    if (this.dedup.remember(key)) return false

    let content: Uint8Array
    try {
      content = await this.deps.session.identity.open(message.blob)
    } catch {
      // не нам или подделано: молча пропускаем
      return false
    }

    if (message.kind === 'transfer') {
      // перенос истории принимается ТОЛЬКО от своего логина
      if (message.from !== this.deps.session.login) return false
      await this.receiveTransfer(content)
      return true
    }

    const envelope = Env.decode(content)
    if (envelope) {
      switch (envelope.type) {
        case Env.TYPE_CALL: {
          const event = CallFormat.decode(envelope.payload)
          if (!event) return false
          const self = message.from === this.deps.session.login
          const verdict = this.callGate.decide(self, event)
          if (verdict.kind === 'missed') {
            await this.recordMissedCall(message.from, event)
          }
          this.emit({ type: 'call', from: message.from, self, verdict })
          return true
        }
        case Env.TYPE_SYNC: {
          // копия своего сообщения с другого устройства
          if (message.from !== this.deps.session.login) return false
          const sync = SyncFormat.decode(envelope.payload)
          if (!sync) return false
          const innerKey = await this.deps.session.dedupKey(sync.chatId, sync.content)
          if (this.dedup.remember(innerKey)) return false
          await this.applySyncedContent(sync.chatId, sync.content)
          this.emit({ type: 'chat', chatId: sync.chatId })
          return true
        }
        case Env.TYPE_BIO: {
          const bio = BioFormat.decode(envelope.payload)
          if (!bio) return false
          await this.deps.profiles.patch(message.from, { bio: bio.text, birthday: bio.birthday })
          this.emit({ type: 'chat', chatId: message.from })
          return true
        }
        case Env.TYPE_DRAFT: {
          if (message.from !== this.deps.session.login) return false
          const draft = DraftFormat.decode(envelope.payload)
          if (!draft) return false
          const existing = await this.deps.drafts.get(draft.chatId)
          if (!existing || draft.at > existing.at) await this.deps.drafts.set(draft.chatId, draft.text, draft.at)
          this.emit({ type: 'chat', chatId: draft.chatId })
          return true
        }
        case Env.TYPE_FOLDERS:
          // папок в web-клиенте нет: событие валидное, но неприменимое
          return true
        case Env.TYPE_EDIT: {
          const edit = EditFormat.decode(envelope.payload)
          if (!edit) return false
          const chatId = await this.chatIdForIncoming(message.from, content)
          const ok = await applyEdit(this.deps.journal, chatId, message.from, {
            targetRef: edit.targetRef,
            targetTs: edit.targetTs,
            newContent: edit.newContent,
          })
          if (ok) this.emit({ type: 'chat', chatId })
          return ok
        }
        case Env.TYPE_DELETE: {
          const del = DeleteFormat.decode(envelope.payload)
          if (!del) return false
          const chatId = await this.chatIdForIncoming(message.from, content)
          const group = await this.deps.groups.get(chatId)
          const ok = await applyDelete(
            this.deps.journal,
            chatId,
            message.from,
            { targetRef: del.targetRef, targetTs: del.targetTs },
            new Set(group?.admins ?? []),
          )
          if (ok) this.emit({ type: 'chat', chatId })
          return ok
        }
        case Env.TYPE_PIN: {
          const pin = PinFormat.decode(envelope.payload)
          if (!pin) return false
          const chatId = await this.chatIdForIncoming(message.from, content)
          const refs = await this.deps.pins.get(chatId)
          const target = pin.targetRef ?? `ts:${pin.targetTs}`
          const next = pin.pinned
            ? [...refs.filter((r) => r !== target), target]
            : refs.filter((r) => r !== target)
          await this.deps.pins.set(chatId, next)
          this.emit({ type: 'chat', chatId })
          return true
        }
        default:
          break
      }
    }

    // обычная запись: определяем чат и пишем в журнал
    const chatId = await this.chatIdForIncoming(message.from, content)
    const group = parse(content).group
    if (group) await this.deps.groups.apply(group.info)

    // аватар-медиа в журнал не пишется — применяется к профилю
    const parsed = parse(content, false)
    if (parsed.kind === 'content' && parsed.content.kind === 'media') {
      const info = parsed.content.info
      const owner = avatarOwnerOf(info)
      if (owner) {
        await this.deps.profiles.patch(owner === 'grp' ? chatId : owner, {
          avatarId: info.id,
          avatarKey: owner === 'grp' ? undefined : undefined,
          avatarEmoji: avatarEmojiOf(info),
        })
        this.emit({ type: 'chat', chatId })
        return true
      }
    }

    await this.deps.journal.append(chatId, {
      from: message.from,
      timestamp: Date.now(),
      content,
    })
    await this.markDelivered(message.from)
    this.emit({ type: 'chat', chatId })
    return true
  }

  // чат входящего: группа — по конверту, иначе — отправитель
  private async chatIdForIncoming(from: string, content: Uint8Array): Promise<string> {
    const group = parse(content).group
    return group ? group.info.id : from
  }

  private async markDelivered(from: string): Promise<void> {
    if (from === this.deps.session.login) return
    try {
      await this.deps.api.confirmDelivered(this.deps.session.token, from, this.deps.session.deviceId)
    } catch {
      // статус доставки не критичен
    }
  }

  // копия своего сообщения с другого устройства
  private async applySyncedContent(chatId: string, content: Uint8Array): Promise<void> {
    const group = parse(content).group
    if (group) await this.deps.groups.apply(group.info)
    await this.deps.journal.append(chatId, {
      from: this.deps.session.login,
      timestamp: Date.now(),
      content,
    })
  }

  private async recordMissedCall(from: string, event: CallEvent): Promise<void> {
    await this.deps.journal.append(from, {
      from,
      timestamp: Date.now(),
      content: CallFormat.encodeRecord(event.callId, 'missed'),
    })
    await this.deps.callLog.add({
      callId: event.callId,
      peer: from,
      outgoing: false,
      status: 'missed',
      at: Date.now(),
      seconds: 0,
    })
  }

  // ─── перенос истории ───────────────────────────────────────────────────

  private async receiveTransfer(content: Uint8Array): Promise<void> {
    const items = decodeChunk(content, this.deps.session.login)
    for (const item of items) {
      const group = parse(item.content).group
      if (group) await this.deps.groups.apply(group.info)
      await this.deps.journal.append(item.chat, {
        from: item.from,
        timestamp: item.ts,
        content: item.content,
      })
    }
    this.emit({ type: 'chat', chatId: '' })
  }

  // выгрузка своей истории на другое устройство аккаунта
  async transferHistoryTo(targetDevice: string, onProgress?: (done: number, total: number) => void): Promise<number> {
    const devices = await this.devicesFor(this.deps.session.login, true)
    const target = devices.find((d) => d.deviceId === targetDevice)
    if (!target) throw new RelayError(404, null, 'устройство не привязано к аккаунту')
    const chatIds = await this.deps.journal.chatIds()
    const all: TransferItem[] = []
    for (const chatId of chatIds) {
      for (const record of await this.deps.journal.history(chatId, Number.MAX_SAFE_INTEGER)) {
        all.push({ chat: chatId, from: record.from, ts: record.timestamp, content: record.content })
      }
    }
    let done = 0
    for (const chunk of chunkItems(all)) {
      const payload = encodeChunk(chunk)
      const blob = await this.deps.session.identity.seal(target.pubSpki, payload)
      await this.deps.api.send(this.deps.session.token, this.deps.session.login, 'transfer', [[targetDevice, blob]])
      done += chunk.length
      onProgress?.(done, all.length)
    }
    return all.length
  }

  // ─── отправка ──────────────────────────────────────────────────────────

  // получатели контента: для группы — участники кроме меня, иначе собеседник
  private async recipientsOf(chatId: string): Promise<string[]> {
    const group = await this.deps.groups.get(chatId)
    if (group) return group.members.filter((m) => m !== this.deps.session.login)
    return [chatId]
  }

  // сброс кэша ключей: после привязки нового устройства пользователь
  // должен увидеть предупреждение сразу, а не через минуту TTL
  invalidateKeys(peer?: string): void {
    if (peer) this.keyCache.delete(peer)
    else this.keyCache.clear()
  }

  private async devicesFor(login: string, excludeSelfDevice = true): Promise<DeviceKey[]> {
    const cached = this.keyCache.get(login)
    if (cached && Date.now() - cached.at < KEY_TTL_MS) {
      return excludeSelfDevice && login === this.deps.session.login
        ? cached.devices.filter((d) => d.deviceId !== this.deps.session.deviceId)
        : cached.devices
    }
    const devices = await this.deps.api.peerKeys(login)
    this.keyCache.set(login, { at: Date.now(), devices })
    return excludeSelfDevice && login === this.deps.session.login
      ? devices.filter((d) => d.deviceId !== this.deps.session.deviceId)
      : devices
  }

  // TOFU: смена ключа известного устройства или новое устройство блокируют
  // отправку до явного подтверждения пользователем
  private async checkTofu(peers: string[]): Promise<void> {
    for (const peer of peers) {
      const devices = await this.devicesFor(peer, peer === this.deps.session.login)
      if (devices.length === 0) continue
      const known = await this.deps.keys.known(peer)
      const current: Array<[string, Uint8Array]> = devices.map((d) => [d.deviceId, d.pubSpki])
      const result = await tofuVerdict(known, current)
      if (result.kind === 'changed') {
        await this.deps.keys.remember(peer, current, { reverifyRequired: true })
        throw new KeyChangedError(peer, result.devices, false)
      }
      if (result.kind === 'newDevice') {
        await this.deps.keys.remember(peer, current, { reverifyRequired: true })
        throw new KeyChangedError(peer, result.devices, true)
      }
      await this.deps.keys.remember(peer, current)
    }
  }

  // основная отправка: конверт уходит на каждое устройство каждого получателя
  private async dispatch(chatId: string, content: Uint8Array, options: { sync?: boolean; kind?: 'chat' | 'transfer' } = {}): Promise<void> {
    const recipients = await this.recipientsOf(chatId)
    await this.checkTofu(recipients)
    const batch: BatchRecipient[] = []
    for (const recipient of recipients) {
      const devices = await this.devicesFor(recipient)
      if (devices.length === 0) continue
      batch.push({ to: recipient, blobs: await this.deps.session.sealFor(devices, content) })
    }
    for (let i = 0; i < batch.length; i += BATCH_CHUNK) {
      const chunk = batch.slice(i, i + BATCH_CHUNK)
      if (chunk.length === 1) {
        const only = chunk[0]
        await this.deps.api.send(this.deps.session.token, only.to, options.kind ?? 'chat', only.blobs)
      } else {
        const errors = await this.deps.api.sendBatch(this.deps.session.token, options.kind ?? 'chat', chunk)
        if (errors.size > 0) {
          const failed = [...errors.keys()].join(', ')
          throw new RelayError(0, null, `не доставлено: ${failed}`)
        }
      }
    }
    // копия своего сообщения на свои другие устройства
    if (options.sync !== false && chatId !== this.deps.session.login) {
      const own = await this.devicesFor(this.deps.session.login)
      if (own.length > 0) {
        const syncPayload = SyncFormat.encode(chatId, content)
        await this.deps.api.send(
          this.deps.session.token,
          this.deps.session.login,
          'chat',
          await this.deps.session.sealFor(own, syncPayload),
        )
      }
    }
  }

  // сообщение: сначала в журнал и outbox, потом в сеть — обрыв не теряет текст
  private async sendWithJournal(chatId: string, content: Uint8Array, options: { sync?: boolean } = {}): Promise<void> {
    await this.deps.journal.append(chatId, {
      from: this.deps.session.login,
      timestamp: Date.now(),
      content,
    })
    const pendingId = await refOf(content)
    const entry: Omit<PendingSend, 'attempts'> = {
      id: pendingId,
      chatId,
      recipients: await this.recipientsOf(chatId),
      kind: 'chat',
      contentB64: Outbox.pack(content),
      sync: options.sync !== false,
      localRecord: true,
      createdAt: Date.now(),
    }
    await this.outbox.enqueue(entry)
    this.emit({ type: 'chat', chatId })
    try {
      await this.dispatch(chatId, content, { sync: options.sync })
      for (const item of await this.outbox.all()) {
        if (item.id === pendingId) await this.outbox.remove(item.key)
      }
    } catch (error) {
      if (error instanceof KeyChangedError) {
        this.emit({ type: 'keys-changed', peer: error.peer, devices: error.devices, isNewDevice: error.isNewDevice })
        throw error
      }
      // остальное доиграет flushOutbox: сообщение уже в журнале
    }
  }

  async flushOutbox(): Promise<void> {
    // stopped проверяем только у таймера: разовая доигровка очереди
    // должна работать и до start() (тесты и первый запуск)
    for (const entry of await this.outbox.all()) {
      try {
        const content = await this.outbox.contentOf(entry)
        await this.dispatch(entry.chatId, content, { sync: entry.sync, kind: entry.kind })
        await this.outbox.remove(entry.key)
      } catch (error) {
        await this.outbox.bump(entry.key, (error as Error).message)
      }
    }
  }

  async sendText(chatId: string, value: string, options: { replyTo?: { ref: string; author: string; quote: string; ts: number }; silent?: boolean } = {}): Promise<void> {
    const trimmed = value.slice(0, 4096)
    if (!trimmed) return
    let content: Uint8Array
    if (options.replyTo) {
      content = ReplyFormat.encode(
        options.replyTo.author,
        options.replyTo.quote,
        options.replyTo.ref,
        options.replyTo.ts,
        trimmed,
        options.silent === true,
      )
    } else if (options.silent) {
      content = ReplyFormat.encodeSilent(trimmed)
    } else {
      content = Env.escapeText(trimmed)
    }
    await this.sendWithJournal(chatId, await this.wrapGroup(chatId, content))
  }

  // групповой конверт несёт определение группы в каждом сообщении
  private async wrapGroup(chatId: string, inner: Uint8Array): Promise<Uint8Array> {
    const group = await this.deps.groups.get(chatId)
    if (!group) return inner
    return GroupFormat.encode(group, inner)
  }

  async sendMedia(chatId: string, info: MediaInfo, options: { silent?: boolean } = {}): Promise<void> {
    const withFlags = { ...info, silent: options.silent ?? info.silent }
    const content = await this.wrapGroup(chatId, MediaJson.message(withFlags))
    await this.sendWithJournal(chatId, content)
  }

  async sendGeo(chatId: string, lat: number, lng: number): Promise<void> {
    await this.sendWithJournal(chatId, await this.wrapGroup(chatId, GeoFormat.encode(lat, lng)))
  }

  async sendContact(chatId: string, login: string, name?: string): Promise<void> {
    await this.sendWithJournal(chatId, await this.wrapGroup(chatId, ContactFormat.encode(login, name)))
  }

  async sendPoll(chatId: string, question: string, options: string[], anonymous: boolean, correctIndex = -1, explanation?: string, multi = false): Promise<void> {
    const content = PollFormat.encode(question, options, anonymous, correctIndex, explanation, multi)
    await this.sendWithJournal(chatId, await this.wrapGroup(chatId, content))
  }

  async react(chatId: string, target: { ref?: string; ts?: number }, emoji: string): Promise<void> {
    const content = ReactionFormat.encode({ ref: target.ref, ts: target.ts }, emoji)
    await this.sendWithJournal(chatId, await this.wrapGroup(chatId, content))
  }

  async vote(chatId: string, pollRef: string, choice: number, remove = false): Promise<void> {
    const content = remove ? VoteFormat.encode(pollRef, -1, true) : VoteFormat.encode(pollRef, choice)
    await this.sendWithJournal(chatId, await this.wrapGroup(chatId, content))
  }

  // правка: конверт TYPE_EDIT уходит собеседникам, локально применяется сразу
  async editMessage(chatId: string, target: MessageRecord, newText: string): Promise<void> {
    const newContent = await this.wrapGroup(chatId, Env.encodeBytes(Env.TYPE_EDITED, new TextEncoder().encode(newText.slice(0, 4096))))
    const event = EditFormat.encode(await refOf(target.content), target.timestamp, newContent, target.content)
    await this.sendWithJournal(chatId, await this.wrapGroup(chatId, event))
    await applyEdit(this.deps.journal, chatId, this.deps.session.login, {
      targetRef: await refOf(target.content),
      targetTs: target.timestamp,
      newContent,
    })
    this.emit({ type: 'chat', chatId })
  }

  async deleteMessage(chatId: string, target: MessageRecord): Promise<void> {
    const event = DeleteFormat.encode(await refOf(target.content), target.timestamp)
    await this.sendWithJournal(chatId, await this.wrapGroup(chatId, event))
    await applyDelete(this.deps.journal, chatId, this.deps.session.login, {
      targetRef: await refOf(target.content),
      targetTs: target.timestamp,
    })
    this.emit({ type: 'chat', chatId })
  }

  async pinMessage(chatId: string, target: MessageRecord, pinned: boolean): Promise<void> {
    const ref = await refOf(target.content)
    const event = PinFormat.encode(ref, target.timestamp, pinned)
    await this.sendWithJournal(chatId, await this.wrapGroup(chatId, event))
    const refs = await this.deps.pins.get(chatId)
    await this.deps.pins.set(chatId, pinned ? [...new Set([...refs, ref])] : refs.filter((r) => r !== ref))
    this.emit({ type: 'chat', chatId })
  }

  // ─── звонки ────────────────────────────────────────────────────────────

  // событие звонка уходит собеседнику обычным sealed-блобом; в журнал не
  // пишется и в outbox не ставится: устаревший offer хуже потерянного
  async sendCallEvent(peer: string, content: Uint8Array): Promise<void> {
    await this.dispatch(peer, content, { sync: true })
  }

  // запись о завершённом звонке в локальный журнал звонков
  async logCall(entry: CallLogEntry): Promise<void> {
    await this.deps.callLog.add(entry)
    this.emit({ type: 'chat', chatId: entry.peer })
  }

  async callLog(chatId?: string): Promise<CallLogEntry[]> {
    return chatId ? this.deps.callLog.forChat(chatId) : this.deps.callLog.all()
  }

  // ─── статусы, набор, профиль ───────────────────────────────────────────

  async sendTyping(chatId: string): Promise<void> {
    const last = this.typingSent.get(chatId) ?? 0
    if (Date.now() - last < TYPING_THROTTLE_MS) return
    this.typingSent.set(chatId, Date.now())
    await this.deps.api.typing(this.deps.session.token, chatId)
  }

  isTyping(chatId: string): boolean {
    const at = this.typingSeen.get(chatId)
    return at !== undefined && Date.now() - at < 5_000
  }

  async markRead(chatId: string): Promise<void> {
    await this.deps.marks.patch(chatId, { readAt: Date.now(), deliveredAt: Date.now() })
    try {
      await this.deps.api.confirmRead(this.deps.session.token, chatId)
    } catch {
      // прочитано — не критично: повторим при следующем открытии
    }
  }

  async setDraft(chatId: string, value: string): Promise<void> {
    await this.deps.drafts.set(chatId, value)
    if (chatId === this.deps.session.login) return
    // черновик синхронизируется на свои устройства (в журнал не пишется)
    try {
      const own = await this.devicesFor(this.deps.session.login)
      if (own.length === 0) return
      const payload = DraftFormat.encode(chatId, value, Date.now())
      await this.deps.api.send(
        this.deps.session.token,
        this.deps.session.login,
        'chat',
        await this.deps.session.sealFor(own, payload),
      )
    } catch {
      // синк черновика не критичен
    }
  }

  async setBio(value: string, birthday?: string): Promise<void> {
    await this.deps.profiles.patch(this.deps.session.login, { bio: value.slice(0, 70), birthday })
    const payload = BioFormat.encode(value.slice(0, 70), birthday)
    const own = await this.devicesFor(this.deps.session.login)
    if (own.length > 0) {
      await this.deps.api.send(
        this.deps.session.token,
        this.deps.session.login,
        'chat',
        await this.deps.session.sealFor(own, payload),
      )
    }
  }

  // аватар уходит всем чатам отдельным конвертом (как sendStoryToAll в Android)
  async setAvatar(info: MediaInfo, blobs: Uint8Array): Promise<void> {
    const mediaId = await this.deps.api.uploadMedia(this.deps.session.token, blobs)
    const descriptor = { ...info, id: mediaId, size: blobs.length }
    await this.deps.profiles.patch(this.deps.session.login, { avatarId: mediaId })
    const chatIds = await this.deps.journal.chatIds()
    const payload = MediaJson.message(descriptor)
    for (const chatId of chatIds) {
      try {
        await this.sendWithJournal(chatId, await this.wrapGroup(chatId, payload))
      } catch {
        // не доставили одному чату — остальные всё равно получат
      }
    }
  }

  // ─── группы ────────────────────────────────────────────────────────────

  async createGroup(name: string, members: string[]): Promise<string> {
    const id = `grp_${randomGroupSuffix()}`
    const info: GroupInfo = {
      id,
      name: name.slice(0, 64),
      members: [...new Set([this.deps.session.login, ...members])].slice(0, 50),
      rev: 1,
      desc: '',
      slowMode: 0,
      noForward: false,
      admins: [this.deps.session.login],
      noReactions: false,
    }
    await this.deps.groups.apply(info)
    await this.sendWithJournal(id, SystemFormat.encodeChange({ sender: this.deps.session.login, added: info.members, removed: [], avatar: false }))
    this.emit({ type: 'chat', chatId: id })
    return id
  }

  private async groupChange(chatId: string, change: Parameters<typeof SystemFormat.encodeChange>[0]): Promise<void> {
    const group = await this.deps.groups.get(chatId)
    if (!group) throw new Error('группа неизвестна')
    await this.deps.journal.append(chatId, {
      from: this.deps.session.login,
      timestamp: Date.now(),
      content: SystemFormat.encodeChange(change),
    })
    const payload = SystemFormat.encodeChange(change)
    await this.sendWithJournal(chatId, await this.wrapGroup(chatId, payload))
  }

  async addMembers(chatId: string, logins: string[]): Promise<void> {
    const group = await this.deps.groups.get(chatId)
    if (!group) throw new Error('группа неизвестна')
    const added = logins.filter((l) => !group.members.includes(l))
    if (added.length === 0) return
    await this.deps.groups.apply({ ...group, members: [...group.members, ...added].slice(0, 50), rev: group.rev + 1 })
    await this.groupChange(chatId, { sender: this.deps.session.login, added, removed: [], avatar: false })
  }

  async removeMember(chatId: string, login: string): Promise<void> {
    const group = await this.deps.groups.get(chatId)
    if (!group) throw new Error('группа неизвестна')
    const members = group.members.filter((m) => m !== login)
    await this.deps.groups.apply({ ...group, members, rev: group.rev + 1 })
    await this.groupChange(chatId, { sender: this.deps.session.login, added: [], removed: [login], avatar: false })
  }

  async renameGroup(chatId: string, name: string): Promise<void> {
    const group = await this.deps.groups.get(chatId)
    if (!group) throw new Error('группа неизвестна')
    await this.deps.groups.apply({ ...group, name: name.slice(0, 64), rev: group.rev + 1 })
    await this.groupChange(chatId, {
      sender: this.deps.session.login,
      added: [],
      removed: [],
      renameTo: name.slice(0, 64),
      avatar: false,
    })
  }

  async setGroupDescription(chatId: string, desc: string): Promise<void> {
    const group = await this.deps.groups.get(chatId)
    if (!group) throw new Error('группа неизвестна')
    await this.deps.groups.apply({ ...group, desc: desc.slice(0, 255), rev: group.rev + 1 })
    await this.groupChange(chatId, {
      sender: this.deps.session.login,
      added: [],
      removed: [],
      descTo: desc.slice(0, 255),
      avatar: false,
    })
  }

  // ─── чтение состояния ──────────────────────────────────────────────────

  async messages(chatId: string, limit = 100): Promise<MessageRecord[]> {
    return this.deps.journal.history(chatId, limit)
  }

  async chatSummaries(): Promise<ChatSummary[]> {
    const [chatIds, drafts, profiles, groups, marks] = await Promise.all([
      this.deps.journal.chatIds(),
      this.deps.drafts.all(),
      this.deps.profiles.all(),
      this.deps.groups.all(),
      this.deps.marks.all(),
    ])
    const groupMap = new Map(groups.map((g) => [g.id, g]))
    const extra = new Set<string>([...groupMap.keys(), this.deps.session.login])
    const out: ChatSummary[] = []
    for (const chatId of new Set([...chatIds, ...extra])) {
      const records = await this.deps.journal.history(chatId, 200)
      const lastRecord = records[records.length - 1] ?? null
      const lastKind = lastRecord ? parse(lastRecord.content, false).kind === 'content' ? (parse(lastRecord.content, false) as { content: Kind }).content : null : null
      const mark = marks.get(chatId)
      const readAt = mark?.readAt ?? 0
      const unread = records.filter((r) => r.from !== this.deps.session.login && r.timestamp > readAt).length
      const group = groupMap.get(chatId)
      out.push({
        chatId,
        title: group?.name ?? chatId,
        isGroup: group !== undefined,
        group,
        lastRecord,
        lastKind,
        lastTs: lastRecord?.timestamp ?? 0,
        unread,
        draft: drafts.get(chatId)?.text ?? '',
        pinned: await this.deps.pins.get(chatId),
        typing: this.isTyping(chatId),
        members: group?.members.length ?? 2,
        profileBio: profiles.get(chatId)?.bio ?? '',
      })
    }
    // пустые системные чаты (без истории) в списке не нужны, кроме «Избранного»
    return out
      .filter((chat) => chat.lastRecord !== null || chat.chatId === this.deps.session.login || chat.draft !== '')
      .sort((a, b) => b.lastTs - a.lastTs)
  }

  async reactionsFor(chatId: string, targetRef: string, targetTs: number): Promise<ReturnType<typeof aggregateReactions>> {
    const records = await this.deps.journal.history(chatId, 500)
    const entries: ReactionEntry[] = []
    for (const record of records) {
      const parsed = parse(record.content, false)
      if (parsed.kind !== 'reaction') continue
      const matchesRef = parsed.targetRef !== undefined && parsed.targetRef === targetRef
      const matchesTs = parsed.targetRef === undefined && parsed.targetTs === targetTs
      if (matchesRef || matchesTs) entries.push({ ts: record.timestamp, author: record.from, emoji: parsed.emoji })
    }
    return aggregateReactions(entries, this.deps.session.login)
  }

  async votesFor(chatId: string, pollRef: string, options: number, pollAuthor: string): Promise<ReturnType<typeof aggregateVotes>> {
    const records = await this.deps.journal.history(chatId, 500)
    const entries: VoteEntry[] = []
    for (const record of records) {
      const parsed = parse(record.content, false)
      if (parsed.kind !== 'vote') continue
      if (parsed.vote.targetRef !== pollRef) continue
      entries.push({ ts: record.timestamp, author: record.from, choice: parsed.vote.choice, stop: parsed.vote.stop })
    }
    return aggregateVotes(entries, options, pollAuthor, this.deps.session.login)
  }

  // медиа: сервер отдаёт блоб один раз, дальше играем из локального кэша
  async ensureMedia(info: MediaInfo): Promise<Uint8Array | null> {
    const cached = await this.deps.media.get(info.id)
    if (cached) return cached
    try {
      const blob = await this.deps.api.downloadMedia(this.deps.session.token, info.id)
      await this.deps.media.put(info.id, blob)
      return blob
    } catch {
      return null
    }
  }

  async uploadMedia(data: Uint8Array, onProgress?: (percent: number) => void): Promise<string> {
    return this.deps.api.uploadMedia(this.deps.session.token, data, onProgress)
  }

  async checkOnline(peer: string): Promise<{ online: boolean; lastSeenUnix: number } | null> {
    try {
      return await this.deps.api.checkOnline(this.deps.session.token, peer)
    } catch {
      return null
    }
  }
}

// аватар: поле ava в дескрипторе медиа
function avatarOwnerOf(info: MediaInfo): string | null {
  const raw = info as MediaInfo & { avatarOwner?: string; avatarEmoji?: string }
  if (raw.avatarEmoji) return 'grp'
  return raw.avatarOwner ?? null
}

function avatarEmojiOf(info: MediaInfo): string | undefined {
  const raw = info as MediaInfo & { avatarEmoji?: string }
  return raw.avatarEmoji
}

function randomGroupSuffix(): string {
  const raw = new Uint8Array(8)
  globalThis.crypto.getRandomValues(raw)
  return [...raw].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// полезно UI: отпечаток устройства для экрана безопасности
export async function deviceFingerprint(pub: Uint8Array): Promise<string> {
  const { toHex } = await import('../util/bytes.js')
  const { sha256 } = await import('../crypto/primitives.js')
  return toHex(await sha256(pub)).slice(0, 32)
}

export type { DeviceKeyPair }
