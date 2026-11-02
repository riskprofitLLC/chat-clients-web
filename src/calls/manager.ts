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

export class CallManager {
  private state: CallState = { ...IDLE }
  private peerConnection: RTCPeerConnection | null = null
  private localStream: MediaStream | null = null
  private remoteAudio: HTMLAudioElement | null = null
  private pendingCandidates: RTCIceCandidateInit[] = []
  private remoteDescriptionSet = false
  private wakeLock: WakeLockSentinel | null = null
  private ringtone: { context: AudioContext; stop(): void } | null = null
  private muted = false
  private error: string | null = null
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
    const callId = CallFormat.newCallId()
    this.error = null
    this.state = outgoing(this.state, callId, peer, Date.now())
    this.update()
    try {
      await this.setupPeer(peer)
      const offer = await this.peerConnection!.createOffer({ offerToReceiveAudio: true })
      await this.peerConnection!.setLocalDescription(offer)
      await this.sendSignal(peer, callId, 'offer', offer.sdp)
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
        this.pendingOffer = { sdp: event.sdp ?? '', callId: event.callId }
        this.state = incoming(this.state, event.callId, from, Date.now())
        this.startRingtone('incoming')
        this.update()
        return
      }
      case 'answer': {
        if (this.state.callId !== event.callId || !this.peerConnection) return
        await this.peerConnection.setRemoteDescription({ type: 'answer', sdp: event.sdp ?? '' })
        this.remoteDescriptionSet = true
        await this.flushCandidates()
        this.state = acceptedOutgoing(this.state, event.callId, Date.now())
        this.stopRingtone()
        await this.acquireWakeLock()
        this.update()
        return
      }
      case 'ice': {
        if (this.state.callId !== event.callId) return
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
    this.stopRingtone()
    try {
      await this.setupPeer(this.state.peer ?? '')
      await this.peerConnection!.setRemoteDescription({ type: 'offer', sdp: offer.sdp })
      this.remoteDescriptionSet = true
      await this.flushCandidates()
      const answer = await this.peerConnection!.createAnswer()
      await this.peerConnection!.setLocalDescription(answer)
      await this.sendSignal(this.state.peer ?? '', offer.callId, 'answer', answer.sdp)
      await this.sendSignal(this.state.peer ?? '', offer.callId, 'accept')
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

  // ─── WebRTC ────────────────────────────────────────────────────────────

  private async setupPeer(peer: string): Promise<void> {
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
      void this.sendSignal(peer, callId, 'ice', undefined, [JSON.stringify(event.candidate.toJSON())])
    }
    connection.ontrack = (event) => {
      this.attachRemote(event.streams[0] ?? new MediaStream([event.track]))
    }
    connection.onconnectionstatechange = () => {
      if (connection.connectionState === 'failed') {
        this.fail('соединение не установлено (нужен TURN для этой сети)')
      }
      this.update()
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    })
    this.localStream = stream
    for (const track of stream.getAudioTracks()) connection.addTrack(track, stream)
    this.update()
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

  private async flushCandidates(): Promise<void> {
    for (const candidate of this.pendingCandidates) {
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

  // ─── вспомогательное ───────────────────────────────────────────────────

  // рингтон на WebAudio: без файлов и зависимостей
  private startRingtone(kind: 'incoming' | 'outgoing'): void {
    this.stopRingtone()
    try {
      const context = new AudioContext()
      const gain = context.createGain()
      gain.gain.value = 0.05
      gain.connect(context.destination)
      const osc = context.createOscillator()
      osc.type = 'sine'
      osc.frequency.value = kind === 'incoming' ? 440 : 330
      osc.connect(gain)
      osc.start()
      // прерывистый сигнал: у входящего чаще
      const period = kind === 'incoming' ? 1.0 : 2.0
      const timer = setInterval(() => {
        gain.gain.value = gain.gain.value > 0 ? 0 : 0.05
      }, (period * 1000) / 2)
      this.ringtone = {
        context,
        stop: () => {
          clearInterval(timer)
          try {
            osc.stop()
          } catch {
            // уже остановлен
          }
          void context.close()
        },
      }
    } catch {
      // звук не критичен: без него звонок работает
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
