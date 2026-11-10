// Звонки 1:1 в браузере: RTCPeerConnection + getUserMedia, сигналинг —
// обычные sealed-блобы TYPE_CALL через очередь релея (сервер их не вскрывает).
//
// Отличия от Android (осознанные, из платформы):
//   • TURN обязателен: UDP-мост CallPipeBridge в браузере невозможен,
//     а сотовые сети и симметричный NAT без TURN звонок не пропускают;
//   • нет foreground-сервиса: звонок живёт, пока вкладка на переднем плане,
//     поэтому на время разговора берём Screen Wake Lock;
//   • нет CallKit: системного экрана вызова и ответа с локскрина не будет.
import { CallFormat, type CallEvent } from '../protocol/formats.js'
import { acceptedIncoming, acceptedOutgoing, callDuration, ended, IDLE, incoming, isBusy, outgoing, reset, type CallState } from '../domain/callmachine.js'
import type { Messenger } from '../domain/messenger.js'
import type { Prefs } from '../store/prefs.js'

export interface CallView {
  state: CallState
  muted: boolean
  speaker: boolean
  connection: RTCPeerConnectionState | 'new'
  error: string | null
  startedAt: number
}

// вызов без ответа обрывается сам: у собеседника давно не будет ринга
const RING_TIMEOUT_MS = 45_000
const ICE_GATHER_TIMEOUT_MS = 2_500
const DISCONNECTED_GRACE_MS = 5_000

export class CallManager {
  private state: CallState = { ...IDLE }
  private peerConnection: RTCPeerConnection | null = null
  private localStream: MediaStream | null = null
  private remoteAudio: HTMLAudioElement | null = null
  private pendingCandidates: RTCIceCandidateInit[] = []
  private readonly earlyCandidates = new Map<string, RTCIceCandidateInit[]>()
  private remoteDescriptionSet = false
  private wakeLock: WakeLockSentinel | null = null
  private ringtone: { stop(): void } | null = null
  private audioContext: AudioContext | null = null
  private muted = false
  private error: string | null = null
  private callTimeout: ReturnType<typeof setTimeout> | null = null
  private disconnectTimer: ReturnType<typeof setTimeout> | null = null
  private readonly listeners = new Set<(view: CallView) => void>()

  constructor(
    private readonly messenger: Messenger,
    private readonly loadPrefs: () => Promise<Prefs>,
  ) {}

  get view(): CallView {
    return {
      state: this.state,
      muted: this.muted,
      speaker: false,
      connection: this.peerConnection?.connectionState ?? 'new',
      error: this.error,
      startedAt: this.state.startedAt,
    }
  }

  onUpdate(listener: (view: CallView) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private update(): void {
    const view = this.view
    for (const listener of this.listeners) listener(view)
  }

  duration(): number {
    return callDuration(this.state)
  }

  // ─── исходящий звонок ──────────────────────────────────────────────────

  async startCall(peer: string): Promise<void> {
    if (isBusy(this.state)) throw new Error('уже есть активный звонок')
    // после прошлого звонка фаза 'ended': без сброса offer уходил бы
    // с новым callId при старом состоянии
    if (this.state.phase === 'ended') this.state = reset()
    const callId = CallFormat.newCallId()
    this.error = null
    this.state = outgoing(this.state, callId, peer, Date.now())
    this.update()
    this.armCallTimeout()
    try {
      await this.setupPeer()
      const offer = await this.peerConnection!.createOffer({ offerToReceiveAudio: true })
      await this.peerConnection!.setLocalDescription(offer)
      await this.sendSignal(peer, callId, 'offer', offer.sdp)
      // кандидаты собираются до конца gathering и уходят одним событием:
      // иначе получатель видит ICE раньше offer и отбрасывает его
      const candidates = await this.gatherCandidates()
      await this.sendSignal(peer, callId, 'ice', undefined, candidates)
      this.startRingtone('outgoing')
    } catch (error) {
      this.fail(`не удалось начать звонок: ${(error as Error).message}`)
      await this.sendSignal(peer, callId, 'cancel')
      this.teardown()
    }
  }

  // ─── входящий звонок ───────────────────────────────────────────────────

  // вызывается из обработчика события звонка мессенджера
  async onCallEvent(from: string, event: CallEvent, self: boolean): Promise<void> {
    // свои устройства: синхронизация ринга, не звонок
    if (self) {
      if (event.ev === 'bye' || event.ev === 'cancel') this.teardown()
      return
    }
    switch (event.ev) {
      case 'offer': {
        if (isBusy(this.state)) {
          await this.sendSignal(from, event.callId, 'busy')
          return
        }
        if (this.state.phase === 'ended') this.state = reset()
        this.pendingOffer = { sdp: event.sdp ?? '', callId: event.callId }
        this.state = incoming(this.state, event.callId, from, Date.now())
        this.startRingtone('incoming')
        this.armCallTimeout()
        this.update()
        return
      }
      case 'answer': {
        if (this.state.callId !== event.callId || !this.peerConnection) return
        await this.peerConnection.setRemoteDescription({ type: 'answer', sdp: event.sdp ?? '' })
        this.remoteDescriptionSet = true
        await this.flushCandidates(event.callId)
        this.state = acceptedOutgoing(this.state, event.callId, Date.now())
        this.clearCallTimeout()
        this.stopRingtone()
        await this.acquireWakeLock()
        this.update()
        return
      }
      case 'ice': {
        // кандидаты могут прийти раньше offer: буферизуем по callId, а не теряем
        if (this.state.callId !== event.callId || !this.remoteDescriptionSet) {
          const buffer = this.earlyCandidates.get(event.callId) ?? []
          for (const candidate of event.cands) {
            const init = safeCandidate(candidate)
            if (init) buffer.push(init)
          }
          this.earlyCandidates.set(event.callId, buffer)
          return
        }
        for (const candidate of event.cands) {
          const init = safeCandidate(candidate)
          if (!init) continue
          if (!this.remoteDescriptionSet) this.pendingCandidates.push(init)
          else await this.peerConnection?.addIceCandidate(init).catch(() => {})
        }
        return
      }
      case 'accept': {
        // собеседник принял: медиа пойдёт после ICE, состояние — активное
        if (this.state.callId !== event.callId) return
        this.state = acceptedOutgoing(this.state, event.callId, Date.now())
        this.clearCallTimeout()
        this.stopRingtone()
        await this.acquireWakeLock()
        this.update()
        return
      }
      case 'busy': {
        if (this.state.callId !== event.callId) return
        this.error = 'собеседник занят'
        this.finish('declined')
        return
      }
      case 'cancel':
      case 'bye': {
        if (this.state.callId !== null && this.state.callId !== event.callId) return
        this.finish(this.state.phase === 'ringing' ? 'missed' : 'completed')
        return
      }
    }
  }

  private pendingOffer: { sdp: string; callId: string } | null = null

  // ─── управление ────────────────────────────────────────────────────────

  async accept(): Promise<void> {
    const offer = this.pendingOffer
    if (!offer || this.state.phase !== 'ringing') return
    this.clearCallTimeout()
    this.stopRingtone()
    try {
      await this.setupPeer()
      await this.peerConnection!.setRemoteDescription({ type: 'offer', sdp: offer.sdp })
      this.remoteDescriptionSet = true
      await this.flushCandidates(offer.callId)
      const answer = await this.peerConnection!.createAnswer()
      await this.peerConnection!.setLocalDescription(answer)
      await this.sendSignal(this.state.peer ?? '', offer.callId, 'answer', answer.sdp)
      await this.sendSignal(this.state.peer ?? '', offer.callId, 'accept')
      const candidates = await this.gatherCandidates()
      await this.sendSignal(this.state.peer ?? '', offer.callId, 'ice', undefined, candidates)
      this.state = acceptedIncoming(this.state, Date.now())
      await this.acquireWakeLock()
      this.update()
    } catch (error) {
      this.fail(`не удалось принять звонок: ${(error as Error).message}`)
      await this.sendSignal(this.state.peer ?? '', offer.callId, 'bye')
      this.teardown()
    }
  }

  async decline(): Promise<void> {
    const peer = this.state.peer
    const callId = this.state.callId
    this.finish('declined')
    if (peer && callId) await this.sendSignal(peer, callId, 'busy')
  }

  async hangup(): Promise<void> {
    const peer = this.state.peer
    const callId = this.state.callId
    const wasActive = this.state.phase === 'active'
    this.finish(wasActive ? 'completed' : 'canceled')
    if (peer && callId) await this.sendSignal(peer, callId, wasActive ? 'bye' : 'cancel')
  }

  toggleMute(): void {
    this.muted = !this.muted
    for (const track of this.localStream?.getAudioTracks() ?? []) track.enabled = !this.muted
    this.update()
  }

  private finish(status: 'completed' | 'declined' | 'canceled' | 'missed'): void {
    const peer = this.state.peer
    const callId = this.state.callId
    const seconds = this.duration()
    const outgoingCall = this.state.side === 'outgoing'
    if (peer && callId) {
      void this.messenger.logCall({ callId, peer, outgoing: outgoingCall, status, seconds, at: Date.now() })
    }
    this.teardown()
  }

  private fail(message: string): void {
    this.error = message
    this.teardown()
  }

  private teardown(): void {
    this.stopRingtone()
    this.clearCallTimeout()
    if (this.disconnectTimer) clearTimeout(this.disconnectTimer)
    this.disconnectTimer = null
    void this.releaseWakeLock()
    this.peerConnection?.close()
    this.peerConnection = null
    for (const track of this.localStream?.getTracks() ?? []) track.stop()
    this.localStream = null
    if (this.remoteAudio) {
      this.remoteAudio.srcObject = null
      this.remoteAudio.remove()
      this.remoteAudio = null
    }
    this.pendingCandidates = []
    this.earlyCandidates.clear()
    this.remoteDescriptionSet = false
    this.pendingOffer = null
    this.muted = false
    this.state = ended(this.state, null)
    this.update()
  }

  dismiss(): void {
    this.error = null
    this.state = reset()
    this.update()
  }

  // вызов без ответа не должен звонить вечно
  private armCallTimeout(): void {
    this.clearCallTimeout()
    this.callTimeout = setTimeout(() => {
      if (this.state.phase === 'outgoing') {
        void this.sendSignal(this.state.peer ?? '', this.state.callId ?? '', 'cancel')
        this.finish('missed')
      } else if (this.state.phase === 'ringing') {
        void this.sendSignal(this.state.peer ?? '', this.state.callId ?? '', 'busy')
        this.finish('missed')
      }
    }, RING_TIMEOUT_MS)
  }

  private clearCallTimeout(): void {
    if (this.callTimeout) clearTimeout(this.callTimeout)
    this.callTimeout = null
  }

  // ─── WebRTC ────────────────────────────────────────────────────────────

  private async setupPeer(): Promise<void> {
    const prefs = await this.loadPrefs()
    const configuration: RTCConfiguration = {
      iceServers: prefs.iceServers.map((server) => ({
        urls: server.urls,
        ...(server.username ? { username: server.username } : {}),
        ...(server.credential ? { credential: server.credential } : {}),
      })),
    }
    const connection = new RTCPeerConnection(configuration)
    this.peerConnection = connection

    connection.onicecandidate = (event) => {
      if (!event.candidate) return
      const callId = this.state.callId
      if (!callId) return
      // сбор идёт до gathering complete: отдельные события не нужны
      this.pendingCandidates.push(event.candidate.toJSON())
    }
    connection.ontrack = (event) => {
      this.attachRemote(event.streams[0] ?? new MediaStream([event.track]))
    }
    connection.onconnectionstatechange = () => {
      this.update()
      if (connection.connectionState === 'disconnected') {
        // не рвём сразу: сеть может вернуться; пробуем ICE-restart
        if (!this.disconnectTimer) {
          this.disconnectTimer = setTimeout(() => {
            this.disconnectTimer = null
            if (connection.connectionState === 'disconnected') connection.restartIce()
          }, DISCONNECTED_GRACE_MS)
        }
      } else {
        if (this.disconnectTimer) clearTimeout(this.disconnectTimer)
        this.disconnectTimer = null
      }
      if (connection.connectionState === 'failed') {
        this.error = 'соединение не установлено (нужен TURN для этой сети)'
        const callId = this.state.callId
        if (callId) void this.sendSignal(this.state.peer ?? '', callId, 'bye')
        this.teardown()
      }
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    })
    this.localStream = stream
    for (const track of stream.getAudioTracks()) connection.addTrack(track, stream)
    this.update()
  }

  // ждём iceGatheringState === 'complete' (с потолком), собираем кандидатов
  private async gatherCandidates(): Promise<string[]> {
    const connection = this.peerConnection
    if (!connection) return []
    if (connection.iceGatheringState !== 'complete') {
      await new Promise<void>((resolve) => {
        const done = (): void => {
          connection.removeEventListener('icegatheringstatechange', onChange)
          clearTimeout(timer)
          resolve()
        }
        const onChange = (): void => {
          if (connection.iceGatheringState === 'complete') done()
        }
        const timer = setTimeout(done, ICE_GATHER_TIMEOUT_MS)
        connection.addEventListener('icegatheringstatechange', onChange)
      })
    }
    return this.pendingCandidates.map((candidate) => JSON.stringify(candidate))
  }

  private attachRemote(stream: MediaStream): void {
    if (!this.remoteAudio) {
      const audio = document.createElement('audio')
      audio.autoplay = true
      audio.setAttribute('playsinline', 'true')
      document.body.appendChild(audio)
      this.remoteAudio = audio
    }
    this.remoteAudio.srcObject = stream
    void this.remoteAudio.play().catch(() => {
      // автоплей может быть заблокирован до жеста пользователя
      this.error = 'нажмите на страницу, чтобы слышать собеседника'
      this.update()
    })
  }

  private async flushCandidates(callId: string): Promise<void> {
    const early = this.earlyCandidates.get(callId) ?? []
    this.earlyCandidates.delete(callId)
    for (const candidate of [...early, ...this.pendingCandidates]) {
      await this.peerConnection?.addIceCandidate(candidate).catch(() => {})
    }
    this.pendingCandidates = []
  }

  private async sendSignal(peer: string, callId: string, ev: CallEvent['ev'], sdp?: string, cands: string[] = []): Promise<void> {
    try {
      await this.messenger.sendCallEvent(peer, CallFormat.encode(ev, callId, Date.now(), sdp, cands))
    } catch {
      // сигналинг не доставлен: звонок развалится по таймауту ICE
    }
  }

  // ─── звук ──────────────────────────────────────────────────────────────

  // AudioContext без жеста создаётся в состоянии suspended: рингтон был беззвучен.
  // Контекст создаём лениво и «разблокируем» по первому взаимодействию.
  private audio(): AudioContext | null {
    try {
      this.audioContext ??= new AudioContext()
      if (this.audioContext.state === 'suspended') void this.audioContext.resume()
      return this.audioContext
    } catch {
      return null
    }
  }

  // вызывается из UI по первому жесту/визибилити
  resumeAudio(): void {
    void this.audioContext?.resume()
  }

  // мелодия с каденцией: две ноты, чередование тонов, вибрация
  private startRingtone(kind: 'incoming' | 'outgoing'): void {
    this.stopRingtone()
    const context = this.audio()
    if (!context) return
    const master = context.createGain()
    master.gain.value = 0.0001
    master.connect(context.destination)
    const notes = kind === 'incoming' ? [660, 880] : [440, 554]
    const period = kind === 'incoming' ? 2.0 : 3.0
    let step = 0
    const beep = (): void => {
      const now = context.currentTime
      const osc = context.createOscillator()
      const gain = context.createGain()
      osc.type = 'sine'
      osc.frequency.value = notes[step % notes.length]
      gain.gain.setValueAtTime(0.0001, now)
      gain.gain.exponentialRampToValueAtTime(0.06, now + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.35)
      osc.connect(gain)
      gain.connect(master)
      osc.start(now)
      osc.stop(now + 0.4)
      step++
    }
    beep()
    const timer = setInterval(beep, (period * 1000) / 2)
    if (kind === 'incoming' && 'vibrate' in navigator) navigator.vibrate([400, 200, 400])
    this.ringtone = {
      stop: () => {
        clearInterval(timer)
        try {
          master.disconnect()
        } catch {
          // уже отключён
        }
        if ('vibrate' in navigator) navigator.vibrate(0)
      },
    }
  }

  private stopRingtone(): void {
    this.ringtone?.stop()
    this.ringtone = null
  }

  // экран не должен гаснуть во время разговора
  private async acquireWakeLock(): Promise<void> {
    try {
      const wakeLock = (navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<WakeLockSentinel> } }).wakeLock
      this.wakeLock = (await wakeLock?.request('screen')) ?? null
    } catch {
      // Wake Lock недоступен (или отказ) — звонок продолжается
    }
  }

  private async releaseWakeLock(): Promise<void> {
    try {
      await this.wakeLock?.release()
    } catch {
      // уже отпущен системой
    }
    this.wakeLock = null
  }
}

// ICE-кандидат из JSON строки; мусор от чужого клиента отбрасываем
function safeCandidate(raw: string): RTCIceCandidateInit | null {
  try {
    const parsed = JSON.parse(raw) as RTCIceCandidateInit
    if (!parsed || typeof parsed.candidate !== 'string') return null
    return parsed
  } catch {
    return null
  }
}
