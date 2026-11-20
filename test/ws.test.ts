// WebSocket-слой релея на фейковом сокете: подпротокольный токен,
// бэкофф реконнекта со джиттером, пинг-таймаут и коды отказа авторизации.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WS_AUTH_PREFIX, WsClient, type WsHandlers } from '../src/net/ws.js'

interface Seen {
  signals: string[]
  states: boolean[]
  authErrors: number
}

let failConnect = false

class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: ((event: { code: number }) => void) | null = null
  closedByClient = false

  constructor(readonly url: string, readonly protocols: string[] = []) {
    if (failConnect) throw new Error('нет сети')
    FakeWebSocket.instances.push(this)
  }

  close(): void {
    this.closedByClient = true
  }
}

interface Timer {
  id: number
  fn: () => void
  ms: number
}

// таймеры перехватываем: бэкофф проверяем по запланированным задержкам,
// не ожидая реальных секунд
let timers: Timer[] = []
let nextId = 1

// scheduleReconnect с проверкой токена асинхронный — прокручиваем микрозадачи
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

function pendingDelays(): number[] {
  return timers.map((timer) => timer.ms)
}

// выполняет последний запланированный таймер (реконнект или пинг)
function runLastTimer(): void {
  const timer = timers.at(-1)!
  timers = timers.filter((item) => item !== timer)
  timer.fn()
}

function current(): FakeWebSocket {
  return FakeWebSocket.instances.at(-1)!
}

function open(index = FakeWebSocket.instances.length - 1): void {
  FakeWebSocket.instances[index]!.onopen!()
}

function makeHandlers(extra?: { checkAuth?: () => Promise<boolean> }): { handlers: WsHandlers; seen: Seen } {
  const seen: Seen = { signals: [], states: [], authErrors: 0 }
  const handlers = {
    onSignal(text: string): void {
      seen.signals.push(text)
    },
    onState(connected: boolean): void {
      seen.states.push(connected)
    },
    onAuthError(): void {
      seen.authErrors++
    },
    ...(extra?.checkAuth ? { checkAuth: extra.checkAuth } : {}),
  }
  return { handlers, seen }
}

beforeEach(() => {
  FakeWebSocket.instances = []
  failConnect = false
  timers = []
  nextId = 1
  vi.stubGlobal('WebSocket', FakeWebSocket)
  vi.stubGlobal(
    'setTimeout',
    ((fn: () => void, ms?: number) => {
      const timer: Timer = { id: nextId++, fn, ms: ms ?? 0 }
      timers.push(timer)
      return timer.id
    }) as unknown as typeof setTimeout,
  )
  vi.stubGlobal('clearTimeout', ((id: number) => {
    timers = timers.filter((timer) => timer.id !== id)
  }) as unknown as typeof clearTimeout)
  // джиттер детерминирован: задержка равна базе бэкоффа
  vi.spyOn(Math, 'random').mockReturnValue(0)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('подключение', () => {
  it('.токен уходит подпротоколом, open даёт connected', () => {
    const { handlers, seen } = makeHandlers()
    void new WsClient('wss://relay.test/v1/ws', 'tok-1', handlers)
    expect(current().url).toBe('wss://relay.test/v1/ws')
    expect(current().protocols).toEqual([`${WS_AUTH_PREFIX}tok-1`])
    open()
    expect(seen.states).toEqual([true])
  })

  it('.кадры wake приходят в onSignal, не-строка — пустой текст', () => {
    const { handlers, seen } = makeHandlers()
    void new WsClient('wss://relay.test/v1/ws', 'tok-1', handlers)
    open()
    current().onmessage!({ data: 'newmsg' })
    current().onmessage!({ data: { not: 'string' } })
    expect(seen.signals).toEqual(['newmsg', ''])
  })

  it('.недоступный WebSocket не роняет клиент: планируется реконнект', () => {
    failConnect = true
    const { handlers } = makeHandlers()
    expect(() => new WsClient('wss://relay.test/v1/ws', 'tok-1', handlers)).not.toThrow()
    expect(pendingDelays()).toEqual([1_000])
  })
})

describe('реконнект', () => {
  it('.обычный close: disconnected и реконнект через базовый бэкофф', () => {
    const { handlers, seen } = makeHandlers()
    void new WsClient('wss://relay.test/v1/ws', 'tok-1', handlers)
    open()
    current().onclose!({ code: 1006 })
    expect(seen.states).toEqual([true, false])
    // пинг-таймер снят при обрыве, остался только реконнект
    expect(pendingDelays()).toEqual([1_000])
  })

  it('.серия неудач растёт по таблице бэкоффа до потолка 30 c', () => {
    const { handlers } = makeHandlers()
    void new WsClient('wss://relay.test/v1/ws', 'tok-1', handlers)
    current().onclose!({ code: 1006 })
    const delays: number[] = [timers.at(-1)!.ms]
    for (let attempt = 1; attempt < 6; attempt++) {
      // каждый реконнект создаёт новый сокет, который сразу обрывается
      runLastTimer()
      current().onclose!({ code: 1006 })
      delays.push(timers.at(-1)!.ms)
    }
    expect(delays).toEqual([1_000, 2_000, 5_000, 10_000, 30_000, 30_000])
  })

  it('.reconnectNow сбрасывает счётчик попыток', () => {
    const { handlers } = makeHandlers()
    const client = new WsClient('wss://relay.test/v1/ws', 'tok-1', handlers)
    open()
    current().onclose!({ code: 1006 })
    runLastTimer()
    current().onclose!({ code: 1006 })
    client.reconnectNow()
    // после ручного переподключения бэкофф снова базовый
    expect(pendingDelays().at(-1)).toBe(1_000)
  })
})

describe('отказ авторизации', () => {
  it('.коды 1008/4401/4403 гасят клиент и зовут onAuthError', () => {
    for (const code of [1008, 4401, 4403]) {
      FakeWebSocket.instances = []
      timers = []
      const { handlers, seen } = makeHandlers()
      void new WsClient('wss://relay.test/v1/ws', 'tok-1', handlers)
      open()
      current().onclose!({ code })
      expect(seen.authErrors).toBe(1)
      // реконнект не планируется — токен мёртв
      expect(pendingDelays()).toEqual([])
    }
  })

  it('.проверка токена на пятой неудаче: живой — работаем дальше', async () => {
    const { handlers, seen } = makeHandlers({ checkAuth: async () => true })
    void new WsClient('wss://relay.test/v1/ws', 'tok-1', handlers)
    current().onclose!({ code: 1006 })
    for (let attempt = 1; attempt <= 5 && timers.length > 0; attempt++) {
      runLastTimer()
      current().onclose!({ code: 1006 })
      await flush()
    }
    // токен живой: отмены нет, реконнект продолжается по таблице бэкоффа
    expect(seen.authErrors).toBe(0)
    expect(pendingDelays().at(-1)).toBe(30_000)
  })

  it('.проверка токена на пятой неудаче: мёртвый — стоп и onAuthError', async () => {
    const { handlers, seen } = makeHandlers({ checkAuth: async () => false })
    void new WsClient('wss://relay.test/v1/ws', 'tok-1', handlers)
    current().onclose!({ code: 1006 })
    for (let attempt = 1; attempt <= 5 && timers.length > 0; attempt++) {
      runLastTimer()
      current().onclose!({ code: 1006 })
      await flush()
    }
    expect(seen.authErrors).toBe(1)
    // новых попыток нет: клиент закрыт
    expect(pendingDelays()).toEqual([])
  })
})

describe('пинг и устаревшие сокеты', () => {
  it('.нет pong дольше таймаута: сокет закрыт, реконнект планируется', () => {
    const { handlers, seen } = makeHandlers()
    void new WsClient('wss://relay.test/v1/ws', 'tok-1', handlers)
    open()
    // пинг-таймер 45 c — после него соединение считается мёртвым
    runLastTimer()
    expect(current().closedByClient).toBe(true)
    // состояние не мигает: новое connected придёт после успешного open
    expect(seen.states).toEqual([true])
    expect(pendingDelays()).toEqual([1_000])
  })

  it('.кадры старого сокета отбрасываются', () => {
    const { handlers, seen } = makeHandlers()
    const client = new WsClient('wss://relay.test/v1/ws', 'tok-1', handlers)
    open()
    client.reconnectNow()
    const stale = current()
    runLastTimer()
    // старый сокет прислал кадр после переподключения — игнорируем
    stale.onmessage!({ data: 'old' })
    current().onmessage!({ data: 'fresh' })
    expect(seen.signals).toEqual(['fresh'])
  })

  it('.close: сокет закрыт, состояние false, второй вызов ничего не делает', () => {
    const { handlers, seen } = makeHandlers()
    const client = new WsClient('wss://relay.test/v1/ws', 'tok-1', handlers)
    open()
    client.close()
    expect(current().closedByClient).toBe(true)
    expect(seen.states.at(-1)).toBe(false)
    const states = seen.states.length
    client.close()
    expect(seen.states).toHaveLength(states)
  })
})
