// WebSocket wake-сигналов: сервер шлёт "newmsg" при появлении сообщения в
// очереди, "typing:<peer>", "delivered:<peer>:<device>", "read:<peer>".
// Отправлять нечего — только слушаем; содержимое по WS не ходит.
//
// Токен едет подпротоколом: браузер не умеет ставить заголовок Authorization
// на WebSocket, а query-параметр попал бы в логи доступа. Сервер подтверждает
// подпротокол эхом (см. go/ws.go).
export const WS_AUTH_PREFIX = 'chat.bearer.'

export interface WsHandlers {
  onSignal(text: string): void
  onState(connected: boolean): void
  onAuthError?(): void
  // дешёвая проверка токена: браузер не отдаёт код 401/403 на WS,
  // поэтому после серии неудач спрашиваем сервер обычным запросом
  checkAuth?(): Promise<boolean>
}

const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000]
// сервер шлёт ping; если pong не пришёл — соединение «мертво» и надо переподключиться
const PING_TIMEOUT_MS = 45_000

export class WsClient {
  private socket: WebSocket | null = null
  private attempt = 0
  private generation = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private pingTimer: ReturnType<typeof setTimeout> | null = null
  private closed = false

  constructor(
    private readonly wsUrl: string,
    private readonly token: string,
    private readonly handlers: WsHandlers,
  ) {
    this.connect()
  }

  private connect(): void {
    if (this.closed) return
    const previous = this.socket
    let socket: WebSocket
    try {
      socket = new WebSocket(this.wsUrl, [`${WS_AUTH_PREFIX}${this.token}`])
    } catch {
      this.scheduleReconnect()
      return
    }
    this.socket = socket
    // события старого сокета отбрасываются проверкой !== this.socket
    previous?.close()
    socket.onopen = () => {
      if (this.closed || this.socket !== socket) return
      this.attempt = 0
      this.handlers.onState(true)
      this.armPing()
    }
    socket.onmessage = (event) => {
      if (this.closed || this.socket !== socket) return
      this.armPing()
      this.handlers.onSignal(typeof event.data === 'string' ? event.data : '')
    }
    socket.onerror = () => {
      // браузер не показывает код ошибки: разбираемся по серии неудач
    }
    socket.onclose = (event) => {
      if (this.closed || this.socket !== socket) return
      this.disarmPing()
      this.handlers.onState(false)
      if (event.code === 1008 || event.code === 4401 || event.code === 4403) {
        this.closed = true
        this.handlers.onAuthError?.()
        return
      }
      void this.scheduleReconnect()
    }
  }

  // соединение без pong дольше таймаута считаем мёртвым
  private armPing(): void {
    this.disarmPing()
    this.pingTimer = setTimeout(() => {
      if (this.closed) return
      const current = this.socket
      this.socket = null
      current?.close()
      void this.scheduleReconnect()
    }, PING_TIMEOUT_MS)
  }

  private disarmPing(): void {
    if (this.pingTimer) clearTimeout(this.pingTimer)
    this.pingTimer = null
  }

  private async scheduleReconnect(): Promise<void> {
    if (this.closed) return
    const attempt = this.attempt++
    // jitter: устройства не переподключаются синхронно и не бьют по серверу
    const base = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]
    const delay = base + Math.floor(Math.random() * Math.min(1_000, base))
    // после серии неудач проверяем токен обычным запросом
    if (attempt > 0 && attempt % 4 === 0 && this.handlers.checkAuth) {
      const alive = await this.handlers.checkAuth().catch(() => true)
      if (this.closed) return
      if (!alive) {
        this.closed = true
        this.handlers.onAuthError?.()
        return
      }
    }
    const generation = ++this.generation
    this.timer = setTimeout(() => {
      if (!this.closed && this.generation === generation) this.connect()
    }, delay)
  }

  reconnectNow(): void {
    if (this.closed) return
    this.attempt = 0
    this.disarmPing()
    if (this.timer) clearTimeout(this.timer)
    const current = this.socket
    this.socket = null
    current?.close()
    void this.scheduleReconnect()
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    if (this.timer) clearTimeout(this.timer)
    this.disarmPing()
    const current = this.socket
    this.socket = null
    current?.close()
    this.handlers.onState(false)
  }
}
