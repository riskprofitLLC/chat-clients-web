// Конверт служебных сообщений — порт domain/Envelope.kt (байт-в-байт).
//
// v2: [0xC5 0xA5 '2'][тип][payload]
// v3: [0xC5 0xA5 '3'][тип][id 8Б][payload] — уникальный id у каждого
// нового сообщения, поэтому ref (sha256 содержимого) уникален даже для
// двух одинаковых «ок». v2 читается для старых записей.
import { randomBytes } from '../crypto/primitives.js'
import { concat, text, utf8 } from '../util/bytes.js'

export const B0 = 0xc5
export const B1 = 0xa5
export const VERSION = '3'
export const LEGACY_VERSION = '2'
const ID_SIZE = 8

export const TYPE_MEDIA = 'm'
export const TYPE_GROUP = 'g'
export const TYPE_REPLY = 'r'
export const TYPE_REACTION = 'x'
export const TYPE_TEXT = 't'
export const TYPE_DEVICE = 'd'
export const TYPE_SYSTEM = 's'
export const TYPE_EDIT = 'e'
export const TYPE_EDITED = 'y'
export const TYPE_PIN = 'p'
export const TYPE_DELETE = 'D'
export const TYPE_SYNC = 'z'
export const TYPE_POLL = 'o'
export const TYPE_VOTE = 'v'
export const TYPE_BIO = 'b'
export const TYPE_CONTACT = 'c'
export const TYPE_GEO = 'l'
export const TYPE_DRAFT = 'w'
export const TYPE_CALL = 'k'
export const TYPE_FOLDERS = 'F'

export interface Decoded {
  type: string
  payload: Uint8Array
  id: Uint8Array | null
}

export function encode(type: string, json: string): Uint8Array {
  return encodeBytes(type, utf8(json))
}

// Байты id — только печатный ASCII (0x21..0x7E): конверт остаётся
// безопасным для встраивания в групповой JSON-конверт
export function encodeBytes(type: string, payload: Uint8Array): Uint8Array {
  const raw = randomBytes(ID_SIZE)
  const id = new Uint8Array(ID_SIZE)
  for (let i = 0; i < ID_SIZE; i++) id[i] = 0x21 + (raw[i] % 0x5e)
  return concat(new Uint8Array([B0, B1, VERSION.charCodeAt(0), type.charCodeAt(0)]), id, payload)
}

// null — префикса нет (старый v1-формат)
export function decode(content: Uint8Array): Decoded | null {
  if (content.length < 5) return null
  if (content[0] !== B0 || content[1] !== B1) return null
  const version = String.fromCharCode(content[2])
  const type = String.fromCharCode(content[3])
  if (version === VERSION) {
    if (content.length < 5 + ID_SIZE) return null
    return { type, payload: content.subarray(4 + ID_SIZE), id: content.subarray(4, 4 + ID_SIZE) }
  }
  if (version === LEGACY_VERSION) {
    return { type, payload: content.subarray(4), id: null }
  }
  return null
}

export function isEnvelope(content: Uint8Array): boolean {
  return content.length >= 4 && content[0] === B0 && content[1] === B1
}

// нужен ли побег: байты текста выглядят как конверт или JSON
export function needsEscape(value: string): boolean {
  const bytes = utf8(value)
  if (bytes.length >= 2 && bytes[0] === B0 && bytes[1] === B1) return true
  return bytes.length > 0 && bytes[0] === 0x7b // '{'
}

export function escapeText(value: string): Uint8Array {
  return encodeBytes(TYPE_TEXT, utf8(value))
}

export function payloadText(payload: Uint8Array): string {
  return text(payload)
}
