// Форматы конвертов — порт domain/MessageFormats.kt, CallFormat.kt,
// SyncFormat.kt, PollFormat.kt, ContactFormat.kt, GeoFormat.kt, DraftFormat.kt,
// BioFormat.kt. Поля и потолки те же: сервер байты не разбирает, но
// собеседник на Android обязан понять всё, что мы шлём.
import { fromBase64, toBase64 } from '../util/b64.js'
import { text, utf8 } from '../util/bytes.js'
import * as Env from './envelope.js'
import { validLogin } from './validators.js'

// ─── медиа ───────────────────────────────────────────────────────────────

export interface MediaInfo {
  id: string
  key: Uint8Array
  size: number
  width: number
  height: number
  thumb: string
  name?: string
  mime?: string
  type: 'media' | 'file' | 'voice'
  duration: number
  waveform?: Uint8Array
  spoiler: boolean
  sticker: boolean
  videoNote: boolean
  forwardFrom?: string
  album?: string
  silent: boolean
  viewOnce: boolean
  storyExp?: number
  storyCaption?: string
}

export function mediaInfo(partial: Partial<MediaInfo> & { id: string; key: Uint8Array }): MediaInfo {
  return {
    size: 0,
    width: 0,
    height: 0,
    thumb: '',
    type: 'media',
    duration: 0,
    spoiler: false,
    sticker: false,
    videoNote: false,
    silent: false,
    viewOnce: false,
    ...partial,
  }
}

const mediaIdRe = /^[0-9a-f]{64}$/
const albumRe = /^[0-9a-f]{4,32}$/
const MAX_BLOB = 10 * 1024 * 1024
const MAX_THUMB = 131_072
const MAX_WAVEFORM = 8_640

export const MediaJson = {
  encode(info: MediaInfo): string {
    const json: Record<string, unknown> = {
      type: info.type,
      id: info.id,
      key: toBase64(info.key),
      size: info.size,
    }
    if (info.type === 'file') {
      json.name = info.name ?? 'file'
      json.mime = info.mime ?? 'application/octet-stream'
      if (info.mime?.startsWith('video/')) {
        if (info.width > 0) json.w = info.width
        if (info.height > 0) json.h = info.height
        if (info.thumb) json.thumb = info.thumb
        if (info.duration > 0) json.dur = info.duration
      }
      if (info.videoNote) json.vn = 1
    } else if (info.type === 'voice') {
      json.duration = info.duration
      if (info.waveform && info.waveform.length > 0) json.wf = toBase64(info.waveform)
    } else {
      json.w = info.width
      json.h = info.height
      json.thumb = info.thumb
      if (info.spoiler) json.sp = 1
      if (info.sticker) json.stk = 1
      if (info.album) json.al = info.album
    }
    if (info.forwardFrom) json.fwd = info.forwardFrom
    if (info.silent) json.sl = 1
    if (info.viewOnce) json.vo = 1
    if (info.storyExp) json.st = info.storyExp
    if (info.storyCaption) json.sc = info.storyCaption.slice(0, 200)
    return JSON.stringify(json)
  },

  message(info: MediaInfo): Uint8Array {
    return Env.encode(Env.TYPE_MEDIA, MediaJson.encode(info))
  },

  parse(content: Uint8Array): MediaInfo | null {
    return MediaJson.parseText(text(content))
  },

  parseText(raw: string): MediaInfo | null {
    if (!raw.startsWith('{')) return null
    let json: Record<string, unknown>
    try {
      json = JSON.parse(raw) as Record<string, unknown>
    } catch {
      return null
    }
    const type = String(json.type ?? '')
    if (type !== 'media' && type !== 'file' && type !== 'voice') return null
    const id = String(json.id ?? '')
    if (!mediaIdRe.test(id)) return null
    const key = fromBase64(String(json.key ?? ''))
    if (!key || key.length !== 32) return null
    const size = Number(json.size ?? -1)
    if (!Number.isFinite(size) || size < 0 || size > MAX_BLOB) return null
    const width = Number(json.w ?? -1)
    const height = Number(json.h ?? -1)
    if (type === 'media' && (width < 0 || height < 0 || width > 100_000 || height > 100_000)) return null
    const thumb = String(json.thumb ?? '')
    if (thumb.length > MAX_THUMB) return null
    const wfRaw = String(json.wf ?? '')
    const waveform = wfRaw ? fromBase64(wfRaw) : null
    if (waveform && (waveform.length === 0 || waveform.length > MAX_WAVEFORM)) return null
    const fwdRaw = String(json.fwd ?? '')
    const forwardFrom = fwdRaw && validLogin(fwdRaw) ? fwdRaw : undefined
    const alRaw = String(json.al ?? '')
    const album = albumRe.test(alRaw) ? alRaw : undefined
    const silent = Number(json.sl ?? 0) === 1
    const viewOnce = Number(json.vo ?? 0) === 1
    const storyExp = Number(json.st ?? 0) > 0 ? Number(json.st) : undefined
    const storyCaption = String(json.sc ?? '').slice(0, 200) || undefined

    const base = {
      id,
      key,
      size,
      width,
      height,
      thumb,
      type: type as MediaInfo['type'],
      silent,
      viewOnce,
      storyExp,
      storyCaption,
    }
    if (type === 'file') {
      const name = String(json.name ?? '')
      const mime = String(json.mime ?? 'application/octet-stream')
      if (!name || name.length > 256 || mime.length > 128) return null
      const duration = Number(json.dur ?? 0)
      if (duration < 0 || duration > 86_400) return null
      return mediaInfo({
        ...base,
        name,
        mime,
        duration,
        videoNote: Number(json.vn ?? 0) === 1,
        forwardFrom,
      })
    }
    if (type === 'voice') {
      const duration = Number(json.duration ?? 0)
      if (duration < 0 || duration > 86_400) return null
      return mediaInfo({
        ...base,
        duration,
        waveform: waveform ?? undefined,
        forwardFrom,
      })
    }
    return mediaInfo({
      ...base,
      spoiler: Number(json.sp ?? 0) === 1,
      sticker: Number(json.stk ?? 0) === 1,
      forwardFrom,
      album,
    })
  },
}

// ─── ответ / пересылка / тихий текст ─────────────────────────────────────

export interface Reply {
  author: string
  quote: string
  targetRef?: string
  targetTs?: number
  text: string
  fwd?: string
  silent: boolean
}

export const ReplyFormat = {
  encode(author: string, quote: string, targetRef: string, targetTs: number | null, value: string, silent = false): Uint8Array {
    return Env.encode(
      Env.TYPE_REPLY,
      JSON.stringify({
        a: author,
        q: quote.slice(0, 200),
        i: targetRef,
        s: targetTs,
        t: value,
        ...(silent ? { sl: 1 } : {}),
      }),
    )
  },

  encodeForward(author: string, value: string): Uint8Array {
    return Env.encode(Env.TYPE_REPLY, JSON.stringify({ t: value, fwd: author }))
  },

  encodeSilent(value: string): Uint8Array {
    return Env.encode(Env.TYPE_REPLY, JSON.stringify({ t: value, sl: 1 }))
  },

  decode(payload: Uint8Array): Reply | null {
    try {
      const json = JSON.parse(text(payload)) as Record<string, unknown>
      const body = String(json.t ?? '')
      if (!body) return null
      const fwdRaw = String(json.fwd ?? '')
      const ref = String(json.i ?? '')
      return {
        author: String(json.a ?? '').slice(0, 128),
        quote: String(json.q ?? '').slice(0, 256),
        targetRef: ref && ref.length <= 128 ? ref : undefined,
        targetTs: json.s === null || json.s === undefined ? undefined : Number(json.s) > 0 ? Number(json.s) : undefined,
        text: body,
        fwd: fwdRaw && validLogin(fwdRaw) ? fwdRaw : undefined,
        silent: Number(json.sl ?? 0) === 1,
      }
    } catch {
      return null
    }
  },
}

// ─── реакции ─────────────────────────────────────────────────────────────

export const REACTION_EMOJIS = [
  '👍', '❤️', '🔥', '🥰', '👏', '😁', '🤔', '🤯', '😱', '🤬', '😢', '😂',
  '🎉', '🤩', '🤮', '🙏', '👀', '💯', '😮', '🥲', '😇', '😍', '😎', '🤝',
  '⚡', '🌚', '🤡', '💔',
]


// любой эмодзи-кластер 1..16 code points из эмодзи-областей (AH7)
export function isValidEmoji(emoji: string): boolean {
  if (!emoji || emoji.length > 64) return false
  const points = [...emoji]
  if (points.length < 1 || points.length > 16) return false
  let sawCore = false
  for (const ch of points) {
    const cp = ch.codePointAt(0)!
    const isCore =
      (cp >= 0x1f000 && cp <= 0x1faff) ||
      (cp >= 0x2600 && cp <= 0x27bf) ||
      (cp >= 0x2b00 && cp <= 0x2bff) ||
      (cp >= 0x2190 && cp <= 0x21ff) ||
      (cp >= 0x2300 && cp <= 0x23ff) ||
      (cp >= 0x25a0 && cp <= 0x25ff) ||
      (cp >= 0x2900 && cp <= 0x297f) ||
      cp === 0x00a9 || cp === 0x00ae || cp === 0x2122 ||
      cp === 0x3030 || cp === 0x303d || cp === 0x3297 || cp === 0x3299
    const isModifier = cp === 0x200d || cp === 0x20e3 || cp === 0xfe0e || cp === 0xfe0f
    if (!isCore && !isModifier) return false
    if (isCore) sawCore = true
  }
  return sawCore
}

export interface ReactionTarget {
  ref?: string
  ts?: number
}

export const ReactionFormat = {
  encode(target: ReactionTarget, emoji: string): Uint8Array {
    return Env.encode(
      Env.TYPE_REACTION,
      JSON.stringify({ i: target.ref ?? null, to: target.ts ?? 0, e: emoji }),
    )
  },

  decode(payload: Uint8Array): { target: ReactionTarget; emoji: string } | null {
    try {
      const json = JSON.parse(text(payload)) as Record<string, unknown>
      const emoji = String(json.e ?? '')
      if (emoji && !isValidEmoji(emoji)) return null
      const refRaw = String(json.i ?? '')
      const ref = refRaw && refRaw.length <= 128 ? refRaw : undefined
      const ts = Number(json.to ?? -1) > 0 ? Number(json.to) : undefined
      if (!ref && !ts) return null
      return { target: { ref, ts }, emoji }
    } catch {
      return null
    }
  },
}

// ─── правка / закреп / удаление ──────────────────────────────────────────

export const MAX_EDIT_CONTENT = 10 * 1024

export const EditFormat = {
  encode(targetRef: string, targetTs: number, newContent: Uint8Array, prev?: Uint8Array): Uint8Array {
    const json: Record<string, unknown> = {
      i: targetRef,
      to: targetTs,
      c: toBase64(newContent),
    }
    if (prev) json.pv = toBase64(prev)
    return Env.encode(Env.TYPE_EDIT, JSON.stringify(json))
  },

  decode(payload: Uint8Array): { targetRef?: string; targetTs?: number; newContent: Uint8Array; prev?: Uint8Array } | null {
    try {
      const json = JSON.parse(text(payload)) as Record<string, unknown>
      const refRaw = String(json.i ?? '')
      const ref = refRaw && refRaw.length <= 128 ? refRaw : undefined
      const ts = Number(json.to ?? -1) > 0 ? Number(json.to) : undefined
      const content = fromBase64(String(json.c ?? ''))
      if ((!ref && !ts) || !content || content.length === 0 || content.length > MAX_EDIT_CONTENT) return null
      const pvRaw = String(json.pv ?? '')
      const prev = pvRaw ? fromBase64(pvRaw) : null
      return {
        targetRef: ref,
        targetTs: ts,
        newContent: content,
        prev: prev && prev.length <= MAX_EDIT_CONTENT ? prev : undefined,
      }
    } catch {
      return null
    }
  },
}

export const PinFormat = {
  encode(targetRef: string, targetTs: number, pinned: boolean): Uint8Array {
    return Env.encode(Env.TYPE_PIN, JSON.stringify({ i: targetRef, to: targetTs, p: pinned }))
  },

  decode(payload: Uint8Array): { targetRef?: string; targetTs?: number; pinned: boolean } | null {
    try {
      const json = JSON.parse(text(payload)) as Record<string, unknown>
      const refRaw = String(json.i ?? '')
      const ref = refRaw && refRaw.length <= 128 ? refRaw : undefined
      const ts = Number(json.to ?? -1) > 0 ? Number(json.to) : undefined
      if (!ref && !ts) return null
      return { targetRef: ref, targetTs: ts, pinned: json.p !== false }
    } catch {
      return null
    }
  },
}

export const DeleteFormat = {
  encode(targetRef: string, targetTs: number): Uint8Array {
    return Env.encode(Env.TYPE_DELETE, JSON.stringify({ i: targetRef, to: targetTs }))
  },

  decode(payload: Uint8Array): { targetRef?: string; targetTs?: number } | null {
    try {
      const json = JSON.parse(text(payload)) as Record<string, unknown>
      const refRaw = String(json.i ?? '')
      const ref = refRaw && refRaw.length <= 128 ? refRaw : undefined
      const ts = Number(json.to ?? -1) > 0 ? Number(json.to) : undefined
      if (!ref && !ts) return null
      return { targetRef: ref, targetTs: ts }
    } catch {
      return null
    }
  },
}

// ─── группы ──────────────────────────────────────────────────────────────

export const MAX_GROUP_MEMBERS = 50
const groupIdRe = /^grp_[a-z0-9_-]{1,48}$/

export interface GroupInfo {
  id: string
  name: string
  members: string[]
  rev: number
  broadcast?: string
  desc: string
  slowMode: number
  noForward: boolean
  admins: string[]
  noReactions: boolean
}

export const GroupFormat = {
  encodeJson(info: GroupInfo, inner: Uint8Array): string {
    const json: Record<string, unknown> = {
      g: info.id,
      n: info.name.slice(0, 64),
      m: info.members,
      v: info.rev,
      c: text(inner),
    }
    if (info.broadcast) json.bc = info.broadcast
    if (info.desc) json.gd = info.desc.slice(0, 255)
    if (info.slowMode > 0) json.sm = info.slowMode
    if (info.noForward) json.nf = 1
    if (info.admins.length > 0) json.ad = info.admins
    if (info.noReactions) json.nr = 1
    return JSON.stringify(json)
  },

  encode(info: GroupInfo, inner: Uint8Array): Uint8Array {
    return Env.encode(Env.TYPE_GROUP, GroupFormat.encodeJson(info, inner))
  },

  decode(payload: Uint8Array): { group: GroupInfo; inner: Uint8Array } | null {
    return GroupFormat.decodeText(text(payload))
  },

  decodeText(raw: string): { group: GroupInfo; inner: Uint8Array } | null {
    if (!raw.startsWith('{')) return null
    let json: Record<string, unknown>
    try {
      json = JSON.parse(raw) as Record<string, unknown>
    } catch {
      return null
    }
    const id = String(json.g ?? '')
    const name = String(json.n ?? '')
    const membersRaw = json.m
    const inner = String(json.c ?? '')
    if (!groupIdRe.test(id) || !name || name.length > 64 || !Array.isArray(membersRaw) || !inner) return null
    const members = membersRaw.map((m) => String(m))
    if (members.length < 1 || members.length > MAX_GROUP_MEMBERS) return null
    if (members.some((m) => !validLogin(m))) return null
    const rev = Math.max(0, Number(json.v ?? 0))
    let broadcast: string | undefined
    if ('bc' in json) {
      const bc = String(json.bc ?? '')
      if (bc && !validLogin(bc)) return null
      broadcast = bc || undefined
    }
    const adminsRaw = Array.isArray(json.ad) ? (json.ad as unknown[]) : []
    const admins = adminsRaw.map((a) => String(a)).filter((a) => validLogin(a) && members.includes(a))
    return {
      group: {
        id,
        name,
        members,
        rev,
        broadcast,
        desc: 'gd' in json ? String(json.gd ?? '').slice(0, 255) : '',
        slowMode: 'sm' in json ? Number(json.sm ?? 0) : 0,
        noForward: 'nf' in json ? Number(json.nf ?? 0) === 1 : false,
        admins,
        noReactions: 'nr' in json ? Number(json.nr ?? 0) === 1 : false,
      },
      inner: utf8(inner),
    }
  },
}

// изменение состава группы: локальная системная запись, локализуется при показе
export interface GroupChange {
  sender: string
  added: string[]
  removed: string[]
  renameTo?: string
  avatar: boolean
  broadcast?: string
  descTo?: string
  slowModeTo?: number
  noForwardTo?: boolean
  adminsTo?: string[]
  noReactionsTo?: boolean
}

export const SystemFormat = {
  encode(value: string): Uint8Array {
    return Env.encode(Env.TYPE_SYSTEM, JSON.stringify({ t: value }))
  },

  decode(payload: Uint8Array): string | null {
    try {
      const json = JSON.parse(text(payload)) as Record<string, unknown>
      if ('mc' in json) return null
      const value = String(json.t ?? '')
      if (!value || value.length > 256) return null
      return value
    } catch {
      return null
    }
  },

  encodeChange(change: GroupChange): Uint8Array {
    const mc: Record<string, unknown> = {
      a: change.sender,
      add: change.added,
      rem: change.removed,
    }
    if (change.renameTo) mc.rn = change.renameTo
    if (change.avatar) mc.ava = 1
    if (change.broadcast !== undefined) mc.bc = change.broadcast
    if (change.descTo !== undefined) mc.gd = change.descTo
    if (change.slowModeTo !== undefined) mc.sm = change.slowModeTo
    if (change.noForwardTo !== undefined) mc.nf = change.noForwardTo ? 1 : 0
    if (change.noReactionsTo !== undefined) mc.nr = change.noReactionsTo ? 1 : 0
    if (change.adminsTo !== undefined) mc.ad = change.adminsTo
    return Env.encode(Env.TYPE_SYSTEM, JSON.stringify({ mc }))
  },

  decodeChange(payload: Uint8Array): GroupChange | null {
    let json: Record<string, unknown>
    try {
      json = JSON.parse(text(payload)) as Record<string, unknown>
    } catch {
      return null
    }
    const mc = json.mc as Record<string, unknown> | undefined
    if (!mc) return null
    const sender = String(mc.a ?? '')
    if (!sender || sender.length > 64) return null
    const readList = (key: string): string[] | null => {
      const arr = mc[key]
      if (arr === undefined) return []
      if (!Array.isArray(arr)) return null
      const out = arr.map((x) => String(x))
      return out.every(validLogin) ? out : null
    }
    const added = readList('add')
    const removed = readList('rem')
    if (!added || !removed) return null
    if (added.length > 50 || removed.length > 50) return null
    const renameRaw = String(mc.rn ?? '')
    const renameTo = renameRaw && renameRaw.length <= 64 ? renameRaw : undefined
    const avatar = Number(mc.ava ?? 0) === 1
    let broadcast: string | undefined
    if ('bc' in mc) {
      const bc = String(mc.bc ?? '')
      if (bc && !validLogin(bc)) return null
      broadcast = bc
    }
    const descTo = 'gd' in mc ? String(mc.gd ?? '').slice(0, 255) : undefined
    const slowModeTo = 'sm' in mc ? Number(mc.sm ?? -1) : undefined
    const noForwardTo = 'nf' in mc ? Number(mc.nf ?? 0) === 1 : undefined
    const noReactionsTo = 'nr' in mc ? Number(mc.nr ?? 0) === 1 : undefined
    const adminsPresent = 'ad' in mc
    const adminsTo = adminsPresent ? readList('ad') : undefined
    if (adminsPresent && !adminsTo) return null
    const meaningful =
      avatar ||
      renameTo !== undefined ||
      broadcast !== undefined ||
      descTo !== undefined ||
      slowModeTo !== undefined ||
      noForwardTo !== undefined ||
      noReactionsTo !== undefined ||
      adminsPresent ||
      added.length + removed.length > 0
    if (!meaningful) return null
    return {
      sender,
      added,
      removed,
      renameTo,
      avatar,
      broadcast,
      descTo,
      slowModeTo,
      noForwardTo,
      adminsTo: adminsTo ?? undefined,
      noReactionsTo,
    }
  },
}

// ─── устройства, синк, черновики, папки ──────────────────────────────────

export const DeviceFormat = {
  encode(deviceId: string, fingerprint: string): Uint8Array {
    return Env.encode(Env.TYPE_DEVICE, JSON.stringify({ id: deviceId, fp: fingerprint }))
  },

  decode(payload: Uint8Array): { deviceId: string; fingerprint: string } | null {
    try {
      const json = JSON.parse(text(payload)) as Record<string, unknown>
      const id = String(json.id ?? '')
      const fp = String(json.fp ?? '')
      if (!id || id.length > 128 || fp.length > 128) return null
      return { deviceId: id, fingerprint: fp }
    } catch {
      return null
    }
  },
}

export const MAX_SYNC_CONTENT = 256 * 1024

export const SyncFormat = {
  encode(chatId: string, content: Uint8Array): Uint8Array {
    return Env.encode(Env.TYPE_SYNC, JSON.stringify({ c: chatId, d: toBase64(content) }))
  },

  decode(payload: Uint8Array): { chatId: string; content: Uint8Array } | null {
    try {
      const json = JSON.parse(text(payload)) as Record<string, unknown>
      const chatId = String(json.c ?? '')
      const data = fromBase64(String(json.d ?? ''))
      if (!chatId || chatId.length > 64 || !data) return null
      if (data.length === 0 || data.length > MAX_SYNC_CONTENT) return null
      return { chatId, content: data }
    } catch {
      return null
    }
  },
}

export const DraftFormat = {
  encode(chatId: string, value: string, at: number): Uint8Array {
    return Env.encode(Env.TYPE_DRAFT, JSON.stringify({ c: chatId, t: value, a: at }))
  },

  decode(payload: Uint8Array): { chatId: string; text: string; at: number } | null {
    try {
      const json = JSON.parse(text(payload)) as Record<string, unknown>
      const chatId = String(json.c ?? '')
      if (!chatId || chatId.length > 64) return null
      const at = Number(json.a ?? 0)
      if (!Number.isFinite(at) || at <= 0) return null
      return { chatId, text: String(json.t ?? '').slice(0, 4096), at }
    } catch {
      return null
    }
  },
}

export const BioFormat = {
  encode(bio: string, birthday?: string): Uint8Array {
    const json: Record<string, unknown> = { t: bio.slice(0, 70) }
    if (birthday) json.bd = birthday
    return Env.encode(Env.TYPE_BIO, JSON.stringify(json))
  },

  decode(payload: Uint8Array): { text: string; birthday?: string } | null {
    try {
      const json = JSON.parse(text(payload)) as Record<string, unknown>
      const value = String(json.t ?? '')
      if (value.length > 70) return null
      const bd = String(json.bd ?? '')
      return { text: value, birthday: bd || undefined }
    } catch {
      return null
    }
  },
}

// ─── опросы ──────────────────────────────────────────────────────────────

export const PollFormat = {
  MAX_QUESTION: 256,
  MAX_OPTION: 100,
  MAX_OPTIONS: 10,
  MIN_OPTIONS: 2,

  encode(question: string, options: string[], anonymous: boolean, correctIndex = -1, explanation?: string, multi = false): Uint8Array {
    const json: Record<string, unknown> = {
      q: question.slice(0, 256),
      o: options.map((o) => o.slice(0, 100)),
      a: anonymous ? 1 : 0,
    }
    if (correctIndex >= 0) json.k = correctIndex
    const hint = (explanation ?? '').trim()
    if (hint) json.x = hint.slice(0, 200)
    if (multi && correctIndex < 0) json.m = 1
    return Env.encode(Env.TYPE_POLL, JSON.stringify(json))
  },

  decode(payload: Uint8Array): { question: string; options: string[]; anonymous: boolean; correctIndex: number; explanation?: string; multi: boolean } | null {
    try {
      const json = JSON.parse(text(payload)) as Record<string, unknown>
      const question = String(json.q ?? '')
      if (!question || question.length > 256) return null
      const arr = json.o
      if (!Array.isArray(arr) || arr.length < 2 || arr.length > 10) return null
      const options = arr.map((o) => String(o))
      if (options.some((o) => !o || o.length > 100)) return null
      const explanation = String(json.x ?? '').trim().slice(0, 200) || undefined
      const rawCorrect = Number(json.k ?? -1)
      const correctIndex = rawCorrect >= 0 && rawCorrect < options.length ? rawCorrect : -1
      return {
        question,
        options,
        anonymous: Number(json.a ?? 1) === 1,
        correctIndex,
        explanation,
        multi: correctIndex < 0 && Number(json.m ?? 0) === 1,
      }
    } catch {
      return null
    }
  },
}

export const VoteFormat = {
  encode(pollRef: string, choice: number, remove = false): Uint8Array {
    const json: Record<string, unknown> = { i: pollRef, c: choice }
    if (remove) json.r = 1
    return Env.encode(Env.TYPE_VOTE, JSON.stringify(json))
  },

  encodeStop(pollRef: string): Uint8Array {
    return Env.encode(Env.TYPE_VOTE, JSON.stringify({ i: pollRef, st: 1 }))
  },

  decode(payload: Uint8Array): { targetRef: string; choice: number; stop: boolean; remove: boolean } | null {
    try {
      const json = JSON.parse(text(payload)) as Record<string, unknown>
      const ref = String(json.i ?? '')
      if (!ref) return null
      if (Number(json.st ?? 0) === 1) return { targetRef: ref, choice: -1, stop: true, remove: false }
      const choice = Number(json.c ?? -2)
      if (!Number.isInteger(choice) || choice < -1) return null
      return { targetRef: ref, choice, stop: false, remove: Number(json.r ?? 0) === 1 }
    } catch {
      return null
    }
  },
}

// ─── контакт / гео ───────────────────────────────────────────────────────

export const ContactFormat = {
  encode(login: string, name?: string): Uint8Array {
    return Env.encode(Env.TYPE_CONTACT, JSON.stringify({ u: login, n: name?.slice(0, 64) ?? null }))
  },

  decode(payload: Uint8Array): { login: string; name?: string } | null {
    try {
      const json = JSON.parse(text(payload)) as Record<string, unknown>
      const login = String(json.u ?? '')
      if (!validLogin(login)) return null
      const name = json.n === null || json.n === undefined ? undefined : String(json.n)
      return { login, name: name && name.length <= 64 ? name : undefined }
    } catch {
      return null
    }
  },
}

export const GeoFormat = {
  encode(lat: number, lng: number): Uint8Array {
    const round6 = (v: number) => Math.round(v * 1_000_000) / 1_000_000
    return Env.encode(Env.TYPE_GEO, JSON.stringify({ la: round6(lat), lo: round6(lng) }))
  },

  decode(payload: Uint8Array): { lat: number; lng: number } | null {
    try {
      const json = JSON.parse(text(payload)) as Record<string, unknown>
      const lat = Number(json.la)
      const lng = Number(json.lo)
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
      if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null
      return { lat, lng }
    } catch {
      return null
    }
  },

  pointText(lat: number, lng: number): string {
    return `${lat.toFixed(5)}, ${lng.toFixed(5)}`
  },
}

// ─── звонки ──────────────────────────────────────────────────────────────

export const CALL_EVENTS = ['offer', 'answer', 'ice', 'accept', 'busy', 'cancel', 'bye'] as const
export type CallEventName = (typeof CALL_EVENTS)[number]

export interface CallEvent {
  ev: CallEventName
  callId: string
  ts: number
  sdp?: string
  cands: string[]
}

const callIdRe = /^[a-z0-9]{8,32}$/
const MAX_SDP = 64 * 1024
const MAX_CANDS = 64
const MAX_CAND = 512

export const CallFormat = {
  STALE_MS: 120_000,

  newCallId(): string {
    const raw = new Uint8Array(8)
    globalThis.crypto.getRandomValues(raw)
    return [...raw].map((b) => b.toString(16).padStart(2, '0')).join('')
  },

  encode(ev: CallEventName, callId: string, ts: number, sdp?: string, cands: string[] = []): Uint8Array {
    const json: Record<string, unknown> = { e: ev, id: callId, ts }
    if (sdp) json.s = sdp
    if (cands.length > 0) json.c = cands
    return Env.encode(Env.TYPE_CALL, JSON.stringify(json))
  },

  decode(payload: Uint8Array): CallEvent | null {
    try {
      const json = JSON.parse(text(payload)) as Record<string, unknown>
      const ev = String(json.e ?? '')
      const callId = String(json.id ?? '')
      const ts = Number(json.ts ?? 0)
      if (!CALL_EVENTS.includes(ev as CallEventName)) return null
      if (!callIdRe.test(callId) || !(ts > 0)) return null
      const sdpRaw = String(json.s ?? '')
      if (sdpRaw.length > MAX_SDP) return null
      const candsRaw = json.c
      const cands: string[] = []
      if (Array.isArray(candsRaw)) {
        if (candsRaw.length > MAX_CANDS) return null
        for (const c of candsRaw) {
          const value = String(c)
          if (!value || value.length > MAX_CAND) return null
          cands.push(value)
        }
      }
      return { ev: ev as CallEventName, callId, ts, sdp: sdpRaw || undefined, cands }
    } catch {
      return null
    }
  },

  encodeRecord(callId: string, status: string): Uint8Array {
    return Env.encode(Env.TYPE_SYSTEM, JSON.stringify({ cl: { id: callId, st: status } }))
  },

  recordDecode(payload: Uint8Array): { callId: string; status: string } | null {
    try {
      const json = JSON.parse(text(payload)) as Record<string, unknown>
      const cl = json.cl as Record<string, unknown> | undefined
      if (!cl) return null
      const id = String(cl.id ?? '')
      const st = String(cl.st ?? '')
      if (!callIdRe.test(id)) return null
      return { callId: id, status: st }
    } catch {
      return null
    }
  },
}
