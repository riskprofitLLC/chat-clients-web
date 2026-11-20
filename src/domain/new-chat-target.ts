// Новый чат: строка без «@» — логин, с «@» — email (дискавери по хэшу).
// Нормализация и хэш email байт-в-байт как в android (domain/EmailHash.kt):
// сырой email на сервер не уходит, уходит только SHA-256 hex.
import { validEmail, validLogin } from '../protocol/validators.js'
import { sha256 } from '../crypto/primitives.js'
import { toHex, utf8 } from '../util/bytes.js'

export type NewChatTarget =
  | { kind: 'login'; login: string }
  | { kind: 'email'; email: string }
  | { kind: 'invalid' }

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase().replace(/ /g, '')
}

export function classifyNewChat(raw: string): NewChatTarget {
  const value = normalizeEmail(raw)
  if (!value) return { kind: 'invalid' }
  if (value.includes('@')) {
    return validEmail(value) ? { kind: 'email', email: value } : { kind: 'invalid' }
  }
  return validLogin(value) ? { kind: 'login', login: value } : { kind: 'invalid' }
}

// SHA-256 hex от нормализованного адреса — тот же хэш, что шлёт android
export async function emailHash(email: string): Promise<string> {
  return toHex(await sha256(utf8(normalizeEmail(email))))
}