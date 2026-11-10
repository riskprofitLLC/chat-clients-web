// Гейт звонков — порт domain/CallEventGate.kt/CallGate.
// Терминальные события (accept/busy/cancel/bye) идемпотентны по (callId, ev):
// второе accept от родственного устройства той же гонки не проходит.
// События от себя (между своими устройствами) записей не дают.
import { DedupIndex } from './dedup.js'
import { CallFormat, type CallEvent } from '../protocol/formats.js'

export type CallVerdict =
  | { kind: 'live'; event: CallEvent }
  | { kind: 'missed'; event: CallEvent }
  | { kind: 'mute' }

const TERMINAL = new Set(['accept', 'busy', 'cancel', 'bye'])

export class CallGate {
  private readonly once = new DedupIndex(256)

  decide(self: boolean, event: CallEvent, now = Date.now()): CallVerdict {
    if (TERMINAL.has(event.ev) && this.once.remember(`${event.callId}:${event.ev}`)) {
      return { kind: 'mute' }
    }
    if (self) return { kind: 'live', event }
    if (event.ev === 'cancel') return { kind: 'missed', event }
    if (event.ev === 'offer' && now - event.ts > CallFormat.STALE_MS) return { kind: 'missed', event }
    return { kind: 'live', event }
  }

  reset(): void {
    this.once.clear()
  }
}
