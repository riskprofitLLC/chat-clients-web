// @vitest-environment happy-dom
// WebRTC-менеджер звонков на фейках RTCPeerConnection/getUserMedia:
// состояния машины, offer/answer/ice/bye по сигналингу, таймауты и TURN-ошибка.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CallManager } from '../src/calls/manager.js'
import { CallFormat } from '../src/protocol/formats.js'
import * as Env from '../src/protocol/envelope.js'
import type { Messenger } from '../src/domain/messenger.js'
import type { Prefs } from '../src/store/prefs.js'

const prefs = { iceServers: [{ urls: 'stun:stun.test' }, { urls: 'turn:turn.test', username: 'u', credential: 'p' }] } as unknown as Prefs

interface Signal {
  peer: string
  ev: string
  callId: string
  sdp?: string
  cands: string[]
}

interface FakeTrack {
  enabled: boolean
  stopped: boolean
  stop(): void
}

class FakePeerConnection {
  static instances: FakePeerConnection[] = []
  connectionState: RTCPeerConnectionState = 'new'
  iceGatheringState = 'gathering'
  closed = false
  addedCandidates: unknown[] = []
  restartIceCalls = 0
  localDescription: unknown = null
  remoteDescription: unknown = null
  offerShouldFail = false
  answerShouldFail = false
  tracks: FakeTrack[] = []
  listeners = new Map<string, Set<() => void>>()
  onicecandidate: ((event: { candidate: { toJSON(): unknown } | null }) => void) | null = null
  ontrack: ((event: { streams: MediaStream[]; track: unknown }) => void) | null = null
  onconnectionstatechange: (() => void) | null = null

  constructor(readonly configuration: RTCConfiguration) {
    FakePeerConnection.instances.push(this)
  }

  addTrack(track: FakeTrack): void {
    this.tracks.push(track)
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    if (this.offerShouldFail) throw new Error('нет камеры')
    return { type: 'offer', sdp: 'offer-sdp' }
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    if (this.answerShouldFail) throw new Error('сломанный offer')
    return { type: 'answer', sdp: 'answer-sdp' }
  }

  async setLocalDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.localDescription = description
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.remoteDescription = description
  }

  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    this.addedCandidates.push(candidate)
  }

  close(): void {
    this.closed = true
  }

  restartIce(): void {
    this.restartIceCalls++
  }

  addEventListener(type: string, listener: () => void): void {
    const set = this.listeners.get(type) ?? new Set()
    set.add(listener)
    this.listeners.set(type, set)
  }

  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener)
  }

  // эмуляция сбора ICE: complete или таймаут — решает тест
  gatherComplete(): void {
    this.iceGatheringState = 'complete'
    for (const listener of this.listeners.get('icegatheringstatechange') ?? []) listener()
  }
}

interface Harness {
  manager: CallManager
  signals: Signal[]
  logs: Array<Record<string, unknown>>
  peer(): FakePeerConnection
  audioContexts: FakeAudioContext[]
}

class FakeAudioContext {
  static created: FakeAudioContext[] = []
  state = 'running'
  currentTime = 0
  destination = {}

  constructor() {
    FakeAudioContext.created.push(this)
  }
  gains: Array<{ gain: { value: number; setValueAtTime: () => void; exponentialRampToValueAtTime: () => void }; connect: () => void; disconnect: () => void }> = []
  oscillators: Array<{ type: string; frequency: { value: number }; connect: () => void; start: () => void; stop: () => void }> = []
  // GainNode настоящего WebAudio имеет вложенный AudioParam .gain
  createGain(): FakeAudioContext['gains'][number] {
    const param = { value: 0, setValueAtTime: () => undefined, exponentialRampToValueAtTime: () => undefined }
    const node = { gain: param, connect: () => undefined, disconnect: () => undefined }
    this.gains.push(node)
    return node
  }

  createOscillator(): FakeAudioContext['oscillators'][number] {
    const osc = { type: '', frequency: { value: 0 }, connect: () => undefined, start: () => undefined, stop: () => undefined }
    this.oscillators.push(osc)
    return osc
  }

  async resume(): Promise<void> {
    this.state = 'running'
  }
}

// рингтон поднимаем через фейковый AudioContext: набор созданных контекстов
function stubAudio(): void {
  vi.stubGlobal('AudioContext', FakeAudioContext)
}

function harness(): Harness {
  const signals: Signal[] = []
  const logs: Array<Record<string, unknown>> = []
  const audioContexts: FakeAudioContext[] = []
  const messenger = {
    sendCallEvent: async (peer: string, content: Uint8Array) => {
      // сигналинг ходит конвертом: разворачиваем обёртку, как мессенджер
      const envelope = Env.decode(content)!
      const event = CallFormat.decode(envelope.payload)!
      signals.push({ peer, ev: event.ev, callId: event.callId, sdp: event.sdp, cands: event.cands })
    },
    logCall: async (entry: Record<string, unknown>) => void logs.push(entry),
  } as unknown as Messenger
  const manager = new CallManager(messenger, async () => prefs)
  managers.push(manager)
  return {
    manager,
    signals,
    logs,
    peer: () => FakePeerConnection.instances.at(-1)!,
    audioContexts,
  }
}

let stream: { getAudioTracks: () => FakeTrack[]; getTracks: () => FakeTrack[] }
// если задан — getUserMedia ждёт его разрешения (тест успевает сломать offer)
let mediaGate: Promise<void> | null = null

// несколько микротасков ждём вместо setTimeout: таймеры файла фейковые
async function tick(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

const managers: CallManager[] = []

beforeEach(() => {
  vi.useFakeTimers()
  FakePeerConnection.instances = []
  vi.stubGlobal('RTCPeerConnection', FakePeerConnection)
  const track: FakeTrack = {
    enabled: true,
    stopped: false,
    stop() {
      this.stopped = true
    },
  }
  stream = {
    getAudioTracks: () => [track],
    getTracks: () => [track],
  }
  vi.stubGlobal('navigator', {
    ...navigator,
    mediaDevices: {
      getUserMedia: async () => {
        if (mediaGate) await mediaGate
        return stream
      },
    },
    vibrate: () => undefined,
    wakeLock: { request: async () => ({ release: async () => undefined }) },
  })
})

afterEach(() => {
  mediaGate = null
  // рингтон и таймауты звонка не должны переживать тест
  for (const manager of managers.splice(0)) manager.dispose()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

// исходящий звонок до состояния «offer+ice отправлены»: сбор ICE закрываем вручную
async function startOutgoing(h: Harness): Promise<void> {
  const done = h.manager.startCall('bob')
  await tick()
  h.peer().gatherComplete()
  await done
}

describe('исходящий звонок', () => {
  it('.offer и кандиты уходят одним сигналом, состояние outgoing', async () => {
    stubAudio()
    const h = harness()
    await startOutgoing(h)
    expect(h.manager.view.state.phase).toBe('outgoing')
    expect(h.manager.view.state.peer).toBe('bob')
    expect(h.signals.map((signal) => signal.ev)).toEqual(['offer', 'ice'])
    expect(h.signals[0]!.sdp).toBe('offer-sdp')
    // рингтон исходящего: две ноты 440/554
    const context = FakeAudioContext.created.at(-1)!
    expect(context.oscillators.map((osc) => osc.frequency.value)).toEqual([440])
  })

  it('.повторный звонок при активном запрещён', async () => {
    const h = harness()
    await startOutgoing(h)
    await expect(h.manager.startCall('alice')).rejects.toThrow('уже есть активный звонок')
  })

  it('.сбой offer: ошибка на экране и cancel собеседнику', async () => {
    const h = harness()
    let release = (): void => undefined
    mediaGate = new Promise<void>((resolve) => {
      release = resolve
    })
    const done = h.manager.startCall('bob')
    // ждём создания соединения (setupPeer читает префы и строит RTCPeerConnection)
    await tick()
    h.peer().offerShouldFail = true
    release()
    await done
    expect(h.manager.view.error).toContain('не удалось начать звонок')
    expect(h.signals.map((signal) => signal.ev)).toEqual(['cancel'])
    expect(h.peer().closed).toBe(true)
  })
})

// входящий offer: кандидаты приходят раньше ответа и буферизуются
async function incoming(h: Harness, cands: string[] = []): Promise<void> {
  await h.manager.onCallEvent('bob', { ev: 'offer', callId: 'call1234', ts: Date.now(), sdp: 'offer-sdp', cands }, false)
  if (cands.length > 0) {
    await h.manager.onCallEvent('bob', { ev: 'ice', callId: 'call1234', ts: Date.now(), cands }, false)
  }
}

describe('входящий звонок', () => {
  it('.offer ставит ringing и буферизует ранние кандидаты', async () => {
    const h = harness()
    await incoming(h, ['{"candidate":"early"}'])
    expect(h.manager.view.state.phase).toBe('ringing')
    expect(h.manager.view.state.side).toBe('incoming')
    // кандидат пришёл до setRemoteDescription — в PeerConnection его нет
    expect(h.peer()).toBeUndefined()
  })

  it('.accept: answer+accept+ice и состояние active', async () => {
    stubAudio()
    const h = harness()
    await incoming(h, ['{"candidate":"early"}'])
    const done = h.manager.accept()
    await tick()
    h.peer().gatherComplete()
    await done
    expect(h.manager.view.state.phase).toBe('active')
    expect(h.signals.map((signal) => signal.ev)).toEqual(['answer', 'accept', 'ice'])
    expect(h.signals[0]!.sdp).toBe('answer-sdp')
    // буферизованный кандидат доехал после setRemoteDescription
    expect(h.peer().addedCandidates).toEqual([{ candidate: 'early' }])
  })

  it('.accept без offer ничего не делает', async () => {
    const h = harness()
    await h.manager.accept()
    expect(h.manager.view.state.phase).toBe('idle')
    expect(h.signals).toEqual([])
  })

  it('.offer при занятом линии — busy собеседнику', async () => {
    const h = harness()
    await startOutgoing(h)
    await h.manager.onCallEvent('alice', { ev: 'offer', callId: 'call9999', ts: Date.now(), sdp: 'x', cands: [] }, false)
    expect(h.signals.at(-1)!.ev).toBe('busy')
    expect(h.signals.at(-1)!.peer).toBe('alice')
    // свой звонок не сломался
    expect(h.manager.view.state.phase).toBe('outgoing')
  })
})

describe('сигналинг активного звонка', () => {
  it('.answer переводит исходящий в active и буферизованные кандидаты уходят', async () => {
    const h = harness()
    await startOutgoing(h)
    await h.manager.onCallEvent('bob', { ev: 'answer', callId: h.manager.view.state.callId!, ts: Date.now(), sdp: 'answer-sdp', cands: [] }, false)
    expect(h.manager.view.state.phase).toBe('active')
    expect(h.peer().remoteDescription).toEqual({ type: 'answer', sdp: 'answer-sdp' })
  })

  it('.answer чужого callId игнорируется', async () => {
    const h = harness()
    await startOutgoing(h)
    await h.manager.onCallEvent('bob', { ev: 'answer', callId: 'other123', ts: Date.now(), sdp: 'x', cands: [] }, false)
    expect(h.manager.view.state.phase).toBe('outgoing')
  })

  it('.accept-сигнал тоже активирует исходящий (без SDP)', async () => {
    const h = harness()
    await startOutgoing(h)
    await h.manager.onCallEvent('bob', { ev: 'accept', callId: h.manager.view.state.callId!, ts: Date.now(), cands: [] }, false)
    expect(h.manager.view.state.phase).toBe('active')
  })
})

describe('ICE-кандидаты', () => {
  it('.мусорный кандидат отбрасывается, валидный буферизуется', async () => {
    const h = harness()
    await incoming(h)
    await h.manager.onCallEvent(
      'bob',
      { ev: 'ice', callId: 'call1234', ts: Date.now(), cands: ['не json', '{"no":"candidate"}', '{"candidate":"ok"}'] },
      false,
    )
    // до accept кандидаты только копятся: проверяем их состав после ответа
    const done = h.manager.accept()
    await tick()
    h.peer().gatherComplete()
    await done
    expect(h.peer().addedCandidates).toEqual([{ candidate: 'ok' }])
  })

  it('.ice активного звонка сразу уходит в PeerConnection', async () => {
    const h = harness()
    await startOutgoing(h)
    await h.manager.onCallEvent('bob', { ev: 'answer', callId: h.manager.view.state.callId!, ts: Date.now(), sdp: 'a', cands: [] }, false)
    await h.manager.onCallEvent('bob', { ev: 'ice', callId: h.manager.view.state.callId!, ts: Date.now(), cands: ['{"candidate":"live"}'] }, false)
    expect(h.peer().addedCandidates).toEqual([{ candidate: 'live' }])
  })
})

describe('завершение звонка', () => {
  it('.busy от собеседника: ошибка и запись declined', async () => {
    const h = harness()
    await startOutgoing(h)
    await h.manager.onCallEvent('bob', { ev: 'busy', callId: h.manager.view.state.callId!, ts: Date.now(), cands: [] }, false)
    expect(h.manager.view.error).toBe('собеседник занят')
    expect(h.manager.view.state.phase).toBe('ended')
    expect(h.logs.at(-1)).toMatchObject({ status: 'declined', outgoing: true })
  })

  it('.bye в ringing — missed, bye в active — completed', async () => {
    const h = harness()
    await incoming(h)
    await h.manager.onCallEvent('bob', { ev: 'bye', callId: 'call1234', ts: Date.now(), cands: [] }, false)
    expect(h.logs.at(-1)).toMatchObject({ status: 'missed', outgoing: false })

    const second = harness()
    await startOutgoing(second)
    await second.manager.onCallEvent('bob', { ev: 'answer', callId: second.manager.view.state.callId!, ts: Date.now(), sdp: 'a', cands: [] }, false)
    await second.manager.onCallEvent('bob', { ev: 'bye', callId: second.manager.view.state.callId!, ts: Date.now(), cands: [] }, false)
    expect(second.logs.at(-1)).toMatchObject({ status: 'completed' })
  })

  it('.bye чужого звонка не трогает текущий', async () => {
    const h = harness()
    await startOutgoing(h)
    await h.manager.onCallEvent('bob', { ev: 'bye', callId: 'other999', ts: Date.now(), cands: [] }, false)
    expect(h.manager.view.state.phase).toBe('outgoing')
    expect(h.logs).toEqual([])
  })
})

describe('управление и свои устройства', () => {
  it('.decline: busy собеседнику и declined в журнале', async () => {
    const h = harness()
    await incoming(h)
    await h.manager.decline()
    expect(h.signals.at(-1)).toMatchObject({ ev: 'busy', peer: 'bob' })
    expect(h.logs.at(-1)).toMatchObject({ status: 'declined' })
  })

  it('.hangup активного — bye/completed, исходящего — cancel/canceled', async () => {
    const h = harness()
    await startOutgoing(h)
    await h.manager.hangup()
    expect(h.signals.at(-1)).toMatchObject({ ev: 'cancel' })
    expect(h.logs.at(-1)).toMatchObject({ status: 'canceled' })

    const second = harness()
    await startOutgoing(second)
    await second.manager.onCallEvent('bob', { ev: 'answer', callId: second.manager.view.state.callId!, ts: Date.now(), sdp: 'a', cands: [] }, false)
    await second.manager.hangup()
    expect(second.signals.at(-1)).toMatchObject({ ev: 'bye' })
    expect(second.logs.at(-1)).toMatchObject({ status: 'completed' })
  })

  it('.свои устройства: bye/cancel только снимают звонок, без сигналов', async () => {
    const h = harness()
    await incoming(h)
    await h.manager.onCallEvent('bob', { ev: 'bye', callId: 'call1234', ts: Date.now(), cands: [] }, true)
    expect(h.signals).toEqual([])
    expect(h.manager.view.state.phase).toBe('ended')
  })
})

describe('микрофон, таймауты и состояние соединения', () => {
  it('.toggleMute глушит трек и отражается в view', async () => {
    const h = harness()
    await startOutgoing(h)
    expect(h.manager.view.muted).toBe(false)
    h.manager.toggleMute()
    expect(h.manager.view.muted).toBe(true)
    expect(stream.getAudioTracks()[0]!.enabled).toBe(false)
    h.manager.toggleMute()
    expect(stream.getAudioTracks()[0]!.enabled).toBe(true)
  })

  it('.вызов без ответа: outgoing уходит в missed по таймауту', async () => {
    const h = harness()
    const done = h.manager.startCall('bob')
    await tick()
    // ICE не собирается: звонок висит до таймаута rings
    await vi.advanceTimersByTimeAsync(45_000)
    await done
    expect(h.signals.at(-1)).toMatchObject({ ev: 'cancel' })
    expect(h.logs.at(-1)).toMatchObject({ status: 'missed' })
  })

  it('.входящий без ответа: busy и missed по таймауту', async () => {
    const h = harness()
    await incoming(h)
    await vi.advanceTimersByTimeAsync(45_000)
    expect(h.signals.at(-1)).toMatchObject({ ev: 'busy' })
    expect(h.logs.at(-1)).toMatchObject({ status: 'missed' })
  })
})

describe('состояние PeerConnection', () => {
  it('.failed: ошибка про TURN, bye и разбор соединения', async () => {
    const h = harness()
    await startOutgoing(h)
    h.peer().connectionState = 'failed'
    h.peer().onconnectionstatechange!()
    expect(h.manager.view.error).toContain('TURN')
    expect(h.signals.at(-1)!.ev).toBe('bye')
    expect(h.peer().closed).toBe(true)
  })

  it('.disconnected: ICE-restart только после паузы', async () => {
    const h = harness()
    await startOutgoing(h)
    h.peer().connectionState = 'disconnected'
    h.peer().onconnectionstatechange!()
    // сразу не рвём: сеть может вернуться
    expect(h.peer().restartIceCalls).toBe(0)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(h.peer().restartIceCalls).toBe(1)
  })

  it('.возврат в connected снимает таймер разрыва', async () => {
    const h = harness()
    await startOutgoing(h)
    h.peer().connectionState = 'disconnected'
    h.peer().onconnectionstatechange!()
    h.peer().connectionState = 'connected'
    h.peer().onconnectionstatechange!()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(h.peer().restartIceCalls).toBe(0)
  })
})

describe('удалённое аудио и уборка', () => {
  it('.трек собеседника вешается в audio, отказ автоплея — подсказка', async () => {
    const h = harness()
    await startOutgoing(h)
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockRejectedValue(new Error('нет жеста'))
    h.peer().ontrack!({ streams: [], track: {} })
    await tick()
    expect(document.querySelector('audio')).not.toBeNull()
    expect(h.manager.view.error).toContain('нажмите на страницу')
    play.mockRestore()
  })

  it('.dismiss снимает ошибку и состояние, dispose возвращает idle', async () => {
    const h = harness()
    await startOutgoing(h)
    h.manager.dismiss()
    expect(h.manager.view.state.phase).toBe('idle')
    h.manager.dispose()
    expect(h.manager.view.state.phase).toBe('idle')
    expect(h.manager.view.error).toBeNull()
    // после ended новый звонок начинает с чистого состояния
    await startOutgoing(h)
    expect(h.manager.view.state.callId).not.toBeNull()
  })

  it('.onUpdate присылает view на каждое изменение', async () => {
    const h = harness()
    const seen: string[] = []
    const off = h.manager.onUpdate((view) => seen.push(view.state.phase))
    await startOutgoing(h)
    off()
    h.manager.dismiss()
    expect(seen).toContain('outgoing')
    // после отписи событий нет
    expect(seen.filter((phase) => phase === 'idle')).toHaveLength(0)
  })
})

describe('крайние случаи', () => {
  it('.сбой createAnswer: ошибка, bye и разбор соединения', async () => {
    const h = harness()
    await incoming(h)
    let release = (): void => undefined
    mediaGate = new Promise<void>((resolve) => {
      release = resolve
    })
    const done = h.manager.accept()
    await tick()
    // медиа ещё не отдано — createAnswer упадёт
    h.peer().answerShouldFail = true
    release()
    await done
    expect(h.manager.view.error).toContain('не удалось принять звонок')
    expect(h.signals.at(-1)!.ev).toBe('bye')
    expect(h.peer().closed).toBe(true)
  })

  it('.кандидат с события onicecandidate уходит в общем ICE-сигнале', async () => {
    const h = harness()
    const done = h.manager.startCall('bob')
    await tick()
    // браузер прислал кандидата до конца сбора
    h.peer().onicecandidate!({ candidate: { toJSON: () => ({ candidate: 'local' }) } })
    h.peer().gatherComplete()
    await done
    expect(h.signals.at(-1)!.cands).toEqual(['{"candidate":"local"}'])
  })

  it('.resumeAudio без созданного контекста не падает', async () => {
    const h = harness()
    expect(() => h.manager.resumeAudio()).not.toThrow()
  })
})
