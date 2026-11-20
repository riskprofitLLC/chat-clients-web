// PIN-блокировка (P-W5): чистые правила кода и паузы после неудач,
// плюс векторная проверка PBKDF2-HMAC-SHA256 на WebCrypto.
import { describe, expect, it } from 'vitest'
import { PIN_ITERATIONS, derivePbkdf2, newPinSalt, pinHash } from '../src/crypto/pbkdf2.js'
import { backoffMs, decide, formatRemaining, isValidPin, sanitizePin } from '../src/domain/pin.js'
import { hmacSha256 } from '../src/crypto/primitives.js'
import { concat, utf8 } from '../src/util/bytes.js'
import { toHex } from '../src/util/bytes.js'


// эталон PBKDF2 на HMAC-SHA256 (RFC 8018) — сверка вывода WebCrypto
async function reference(password: Uint8Array, salt: Uint8Array, iterations: number, keyLen: number): Promise<Uint8Array> {
  const out = new Uint8Array(keyLen)
  let offset = 0
  let block = 1
  while (offset < keyLen) {
    const counter = new Uint8Array([(block >>> 24) & 255, (block >>> 16) & 255, (block >>> 8) & 255, block & 255])
    let u = await hmacSha256(password, concat(salt, counter))
    const t = u.slice()
    for (let i = 1; i < iterations; i++) {
      u = await hmacSha256(password, u)
      for (let j = 0; j < t.length; j++) t[j] ^= u[j]
    }
    const take = Math.min(t.length, keyLen - offset)
    out.set(t.subarray(0, take), offset)
    offset += take
    block++
  }
  return out
}

describe('PBKDF2-HMAC-SHA256 (P-W5)', () => {
  it('совпадает с известными векторами', async () => {
    // «password»/«salt», c=1 и c=4096, dklen=32
    expect(toHex(await derivePbkdf2(utf8('password'), utf8('salt'), 1))).toBe(
      '120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b',
    )
    expect(toHex(await derivePbkdf2(utf8('password'), utf8('salt'), 4096))).toBe(
      'c5e478d59288c841aa530db6845c4c8d962893a001ce4e11a4963873aa98134a',
    )
  })

  it('вывод не зависит от разбиения на блоки (dkLen > 32)', async () => {
    const password = utf8('pin-вектор')
    const salt = utf8('соль-вектор')
    const long = await derivePbkdf2(password, salt, 64, 64)
    const expected = await reference(password, salt, 64, 64)
    expect(toHex(long)).toBe(toHex(expected))
  })

  it('600k итераций — значение по умолчанию', async () => {
    expect(PIN_ITERATIONS).toBe(600_000)
    const salt = newPinSalt()
    const first = await pinHash('123456', salt)
    const second = await pinHash('123456', salt)
    expect(first).toBe(second)
    expect(await pinHash('123457', salt)).not.toBe(first)
  })
})

describe('правила PIN (P-W5)', () => {
  it('ввод фильтруется до шести цифр', () => {
    expect(sanitizePin('12a34б56')).toBe('123456')
    expect(sanitizePin('1234567890')).toBe('123456')
    expect(isValidPin(sanitizePin('12a34б56'))).toBe(true)
    expect(isValidPin('12345')).toBe(false)
    expect(isValidPin('12345a')).toBe(false)
  })

  it('пауза после неудач растёт по шагам и упирается в потолок', () => {
    expect(backoffMs(0)).toBe(0)
    expect(backoffMs(1)).toBe(0)
    expect(backoffMs(2)).toBe(0)
    expect(backoffMs(3)).toBe(30_000)
    expect(backoffMs(4)).toBe(60_000)
    expect(backoffMs(5)).toBe(300_000)
    expect(backoffMs(6)).toBe(900_000)
    expect(backoffMs(7)).toBe(3_600_000)
    expect(backoffMs(99)).toBe(3_600_000)
  })

  it('в паузе ввод запрещён и возвращается остаток', () => {
    const now = 1_000_000
    expect(decide(0, 0, now)).toEqual({ allowed: true, remainingMs: 0 })
    expect(decide(
 3, now + 30_000, now)).toEqual({ allowed: false, remainingMs: 30_000 })
    expect(decide(3, now - 1, now)).toEqual({ allowed: true, remainingMs: 0 })
  })

  it('остаток показывается как мм:сс', () => {
    expect(formatRemaining(0)).toBe('00:00')
    expect(formatRemaining(1_500)).toBe('00:02')
    expect(formatRemaining(65_000)).toBe('01:05')
    expect(formatRemaining(3_600_000)).toBe('60:00')
  })
})
