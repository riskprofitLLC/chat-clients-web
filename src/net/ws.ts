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
}

const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000]

export class WsClient {
  private socket: WebSocket | null = null
  private attempt = 0
  private generation = 0
  private timer: ReturnType<typeof setTimeout> | null = null
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
    }
    socket.onmessage = (event) => {
      if (this.closed || this.socket !== socket) return
      this.handlers.onSignal(typeof event.data === 'string' ? event.data : '')
    }
    socket.onerror = () => {
      if (this.closed || this.socket !== socket) return
      // 401/403 браузер не показывает: считаем частые ошибки поводом
      // перепроверить токен — при отзыве устройства реконнект бессмыслен
    }
    socket.onclose = (event) => {
      if (this.closed || this.socket !== socket) return
      this.handlers.onState(false)
      if (event.code === 1008 || event.code === 4401 || event.code === 4403) {
        this.closed = true
        this.handlers.onAuthError?.()
        return
      }
      this.scheduleReconnect()
    }
  }

  private scheduleReconnect(): void {
    if (this.closed) return
    const delay = BACKOFF_MS[Math.min(this.attempt++, BACKOFF_MS.length - 1)]
    const generation = ++this.generation
    this.timer = setTimeout(() => {
      if (!this.closed && this.generation === generation) this.connect()
    }, delay)
  }

  reconnectNow(): void {
    if (this.closed) return
    this.attempt = 0
    const current = this.socket
    this.socket = null
    current?.close()
    this.scheduleReconnect()
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    if (this.timer) clearTimeout(this.timer)
    const current = this.socket
    this.socket = null
    current?.close()
    this.handlers.onState(false)
  }
}
