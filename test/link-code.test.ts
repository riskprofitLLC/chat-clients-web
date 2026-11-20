// Формат кода привязки «nonce|pubB64|deviceId|server»: последняя часть —
// адрес сервера нового устройства, чтобы подтверждающее обратилось именно
// к нему из любой сети.
import { describe, expect, it } from 'vitest'

const NONCE = 'a'.repeat(64)
const PUB = 'A'.repeat(124)

function parse(code: string): { nonce: string; pubB64: string; deviceId?: string; server?: string } | null {
  const parts = code.trim().split('|')
  if (parts.length < 2) return null
  const [nonce, pubB64] = parts
  if (!/^[0-9a-f]{16,64}$/.test(nonce)) return null
  if (pubB64.length < 32) return null
  const deviceId = parts[2]?.trim() || undefined
  const server = parts[3]?.trim() || undefined
  if (server && !server.startsWith('http://') && !server.startsWith('https://')) return null
  return deviceId || server ? { nonce, pubB64, deviceId, server } : { nonce, pubB64 }
}

describe('код привязки: разбор nonce|pubB64|deviceId|server', () => {
  it('две части — минимум', () => {
    expect(parse(`${NONCE}|${PUB}`)).toEqual({ nonce: NONCE, pubB64: PUB })
  })

  it('четыре части — сервер извлекается', () => {
    expect(parse(`${NONCE}|${PUB}|web0a704f31|https://ednar.duckdns.org`)).toEqual({
      nonce: NONCE,
      pubB64: PUB,
      deviceId: 'web0a704f31',
      server: 'https://ednar.duckdns.org',
    })
  })

  it('сервер с портом', () => {
    expect(parse(`${NONCE}|${PUB}|dev|http://10.0.2.2:18080`)?.server).toBe('http://10.0.2.2:18080')
  })

  it('адрес без схемы отвергается', () => {
    expect(parse(`${NONCE}|${PUB}|dev|ednar.duckdns.org`)).toBeNull()
  })

  it('невалидный nonce отвергается', () => {
    expect(parse(`zzz|${PUB}|dev|https://ednar.duckdns.org`)).toBeNull()
  })

  it('слишком короткий pub отвергается', () => {
    expect(parse(`${NONCE}|short|dev|https://ednar.duckdns.org`)).toBeNull()
  })

  it('пустой сервер = без сервера', () => {
    expect(parse(`${NONCE}|${PUB}|dev|`)).toEqual({ nonce: NONCE, pubB64: PUB, deviceId: 'dev' })
  })
})
