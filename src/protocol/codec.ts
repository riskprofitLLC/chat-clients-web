// Единый разбор содержимого записи истории в модель для UI — порт
// domain/MessageCodec.kt. Порядок: конверт v3/v2 → служебное по типу;
// групповой конверт разбирается рекурсивно (глубина 1); остальное — текст.
import { text, utf8 } from '../util/bytes.js'
import * as Env from './envelope.js'
import {
  CallFormat,
  ContactFormat,
  DeleteFormat,
  DeviceFormat,
  EditFormat,
  GeoFormat,
  GroupFormat,
  MediaJson,
  PinFormat,
  PollFormat,
  ReactionFormat,
  ReplyFormat,
  SystemFormat,
  VoteFormat,
  type GroupInfo,
  type MediaInfo,
} from './formats.js'

export const MAX_TEXT = 16 * 1024

export type Kind =
  | { kind: 'text'; text: string; edited: boolean }
  | { kind: 'reply'; reply: ReturnType<typeof ReplyFormat.decode> & object }
  | { kind: 'media'; info: MediaInfo }
  | { kind: 'poll'; poll: NonNullable<ReturnType<typeof PollFormat.decode>> }
  | { kind: 'contact'; login: string; name?: string }
  | { kind: 'geo'; lat: number; lng: number }
  | { kind: 'system'; text: string; change?: ReturnType<typeof SystemFormat.decodeChange>; call?: { callId: string; status: string } }
  | { kind: 'unsupported' }

export interface Group {
  info: GroupInfo
  inner: Kind
}

export type Parsed =
  | { kind: 'content'; content: Kind; group?: Group }
  | { kind: 'reaction'; targetRef?: string; targetTs?: number; emoji: string; group?: Group }
  | { kind: 'vote'; vote: NonNullable<ReturnType<typeof VoteFormat.decode>>; group?: Group }

// декод текста с потолком: хвост сверх потолка не декодируется вовсе
function decodeTextCapped(data: Uint8Array): string {
  const limit = Math.min(data.length, MAX_TEXT * 4)
  const slice = data.length <= limit ? data : data.subarray(0, limit)
  const value = text(slice)
  return value.length <= MAX_TEXT ? value : value.slice(0, MAX_TEXT)
}

export function parse(content: Uint8Array, allowLegacy = true): Parsed {
  return parseEnvelope(content, allowLegacy, 0)
}

function parseEnvelope(content: Uint8Array, allowLegacy: boolean, depth: number): Parsed {
  const envelope = Env.decode(content)
  if (envelope) {
    const payload = envelope.payload
    switch (envelope.type) {
      case Env.TYPE_MEDIA: {
        const info = MediaJson.parse(payload)
        return info ? contentOf({ kind: 'media', info }) : unsupported()
      }
      case Env.TYPE_REPLY: {
        const reply = ReplyFormat.decode(payload)
        return reply ? contentOf({ kind: 'reply', reply }) : unsupported()
      }
      case Env.TYPE_GROUP: {
        const decoded = GroupFormat.decode(payload)
        if (!decoded) return unsupported()
        return parseInner(decoded, allowLegacy, depth)
      }
      case Env.TYPE_REACTION: {
        const reaction = ReactionFormat.decode(payload)
        if (!reaction) return unsupported()
        return { kind: 'reaction', targetRef: reaction.target.ref, targetTs: reaction.target.ts, emoji: reaction.emoji }
      }
      case Env.TYPE_POLL: {
        const poll = PollFormat.decode(payload)
        return poll ? contentOf({ kind: 'poll', poll }) : unsupported()
      }
      case Env.TYPE_VOTE: {
        const vote = VoteFormat.decode(payload)
        return vote ? { kind: 'vote', vote } : unsupported()
      }
      case Env.TYPE_CONTACT: {
        const contact = ContactFormat.decode(payload)
        return contact ? contentOf({ kind: 'contact', login: contact.login, name: contact.name }) : unsupported()
      }
      case Env.TYPE_GEO: {
        const point = GeoFormat.decode(payload)
        return point ? contentOf({ kind: 'geo', lat: point.lat, lng: point.lng }) : unsupported()
      }
      case Env.TYPE_TEXT:
        return contentOf({ kind: 'text', text: decodeTextCapped(payload), edited: false })
      case Env.TYPE_EDITED:
        return contentOf({ kind: 'text', text: decodeTextCapped(payload), edited: true })
      case Env.TYPE_DEVICE: {
        const device = DeviceFormat.decode(payload)
        return device ? contentOf({ kind: 'system', text: `device:${device.deviceId}` }) : unsupported()
      }
      case Env.TYPE_SYSTEM: {
        const change = SystemFormat.decodeChange(payload)
        if (change) return contentOf({ kind: 'system', text: '', change })
        const call = CallFormat.recordDecode(payload)
        if (call) return contentOf({ kind: 'system', text: '', call })
        const value = SystemFormat.decode(payload)
        return value ? contentOf({ kind: 'system', text: value }) : unsupported()
      }
      // события, которые в журнал не пишутся: применяются на приёме
      case Env.TYPE_EDIT:
      case Env.TYPE_PIN:
      case Env.TYPE_DELETE:
      case Env.TYPE_BIO:
      case Env.TYPE_CALL:
      case Env.TYPE_FOLDERS:
        return unsupported()
      default:
        return unsupported()
    }
  }
  // новые входящие без конверта — только текст (v1-декодеры отключены)
  if (!allowLegacy) return contentOf({ kind: 'text', text: decodeTextCapped(content), edited: false })
  return contentOf(parsePlain(content))
}

function parseInner(decoded: { group: GroupInfo; inner: Uint8Array }, allowLegacy: boolean, depth: number): Parsed {
  if (depth >= 1) {
    return { kind: 'content', content: { kind: 'unsupported' }, group: { info: decoded.group, inner: { kind: 'unsupported' } } }
  }
  const inner = parseEnvelope(decoded.inner, allowLegacy, depth + 1)
  const info = decoded.group
  if (inner.kind === 'content') return { kind: 'content', content: inner.content, group: { info, inner: inner.content } }
  if (inner.kind === 'reaction') {
    return { kind: 'reaction', targetRef: inner.targetRef, targetTs: inner.targetTs, emoji: inner.emoji, group: { info, inner: { kind: 'unsupported' } } }
  }
  return { kind: 'vote', vote: inner.vote, group: { info, inner: { kind: 'unsupported' } } }
}

function contentOf(content: Kind, group?: Group): Parsed {
  return group ? { kind: 'content', content, group } : { kind: 'content', content }
}

function unsupported(): Parsed {
  return contentOf({ kind: 'unsupported' })
}

// старые записи: медиа-JSON или reply-JSON без конверта
function parsePlain(content: Uint8Array): Kind {
  const info = MediaJson.parse(content)
  if (info) return { kind: 'media', info }
  const value = decodeTextCapped(content)
  if (value.startsWith('{')) {
    try {
      const json = JSON.parse(value) as Record<string, unknown>
      const quote = String(json.r ?? '')
      const body = String(json.t ?? '')
      if (quote && body && quote.length <= 200) {
        return {
          kind: 'reply',
          reply: {
            author: '',
            quote,
            text: body,
            silent: false,
          },
        }
      }
    } catch {
      // не JSON — обычный текст
    }
  }
  return { kind: 'text', text: value, edited: false }
}

export function groupOf(content: Uint8Array, allowLegacy = true): Group | null {
  const parsed = parse(content, allowLegacy)
  return parsed.group ?? null
}

// разворачивает групповой конверт до «сырого» внутреннего содержимого
export function innerContent(content: Uint8Array): Uint8Array {
  const envelope = Env.decode(content)
  if (envelope?.type === Env.TYPE_GROUP) {
    const decoded = GroupFormat.decode(envelope.payload)
    if (decoded) return decoded.inner
  }
  return content
}

export const MessageCodec = {
  parse,
  groupOf,
  innerContent,
  editOf: editOf,
  pinOf: pinOf,
  deleteOf: deleteOf,
  reactionOf: reactionOf,
  voteOf: voteOf,
  MAX_TEXT,
}

export function editOf(content: Uint8Array): ReturnType<typeof EditFormat.decode> {
  const envelope = Env.decode(content)
  if (envelope?.type !== Env.TYPE_EDIT) return null
  return EditFormat.decode(envelope.payload)
}

export function pinOf(content: Uint8Array): ReturnType<typeof PinFormat.decode> {
  const envelope = Env.decode(content)
  if (envelope?.type !== Env.TYPE_PIN) return null
  return PinFormat.decode(envelope.payload)
}

export function deleteOf(content: Uint8Array): ReturnType<typeof DeleteFormat.decode> {
  const envelope = Env.decode(content)
  if (envelope?.type !== Env.TYPE_DELETE) return null
  return DeleteFormat.decode(envelope.payload)
}

export function reactionOf(content: Uint8Array): ReturnType<typeof ReactionFormat.decode> {
  const envelope = Env.decode(content)
  if (envelope?.type !== Env.TYPE_REACTION) return null
  return ReactionFormat.decode(envelope.payload)
}

export function voteOf(content: Uint8Array): ReturnType<typeof VoteFormat.decode> {
  const envelope = Env.decode(content)
  if (envelope?.type !== Env.TYPE_VOTE) return null
  return VoteFormat.decode(envelope.payload)
}

// текст конверта — для отладки и превью
export function payloadString(content: Uint8Array): string {
  return text(utf8(text(content)))
}
