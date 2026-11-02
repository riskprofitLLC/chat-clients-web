// Стейт-машина звонка — порт domain/CallStateMachine.kt.
// IDLE → OUTGOING (мы позвонили) / RINGING (нам звонят) → ACTIVE → ENDED.
// Угон: новый входящий при активном звонке отклоняется как busy.
// Чистая логика без WebRTC — тестируется без браузера.

export type CallPhase = 'idle' | 'outgoing' | 'ringing' | 'active' | 'ended'
export type CallSide = 'outgoing' | 'incoming'

export interface CallState {
  phase: CallPhase
  callId: string | null
  peer: string | null
  side: CallSide | null
  // момент перехода в ACTIVE — для таймера на экране
  startedAt: number
}

export const IDLE: CallState = { phase: 'idle', callId: null, peer: null, side: null, startedAt: 0 }

export function isBusy(state: CallState): boolean {
  return state.phase === 'outgoing' || state.phase === 'ringing' || state.phase === 'active'
}

export function outgoing(state: CallState, callId: string, peer: string, now: number): CallState {
  if (isBusy(state) || state.phase !== 'idle') return state
  return { phase: 'outgoing', callId, peer, side: 'outgoing', startedAt: now }
}

export function incoming(state: CallState, callId: string, peer: string, now: number): CallState {
  if (isBusy(state)) return state
  return { phase: 'ringing', callId, peer, side: 'incoming', startedAt: now }
}

export function acceptedOutgoing(state: CallState, callId: string, now: number): CallState {
  if (state.phase !== 'outgoing' || state.callId !== callId) return state
  return { ...state, phase: 'active', startedAt: now }
}

export function acceptedIncoming(state: CallState, now: number): CallState {
  if (state.phase !== 'ringing') return state
  return { ...state, phase: 'active', startedAt: now }
}

// завершение (bye/cancel/busy/ошибка): совпадение callId или сброс
export function ended(state: CallState, callId: string | null): CallState {
  if (state.phase === 'idle') return state
  if (callId === null || state.callId === null || state.callId === callId) {
    return { ...state, phase: 'ended' }
  }
  return state
}

export function reset(): CallState {
  return { ...IDLE }
}

export function callDuration(state: CallState, now = Date.now()): number {
  if (state.phase !== 'active' || state.startedAt === 0) return 0
  return Math.max(0, Math.round((now - state.startedAt) / 1000))
}
