import { describe, expect, it } from 'vitest'
import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  ecdh,
  generateKeyPair,
  hmacSha256,
  sha256,
  SPKI_SIZE,
} from '../src/crypto/primitives.js'
import { derive } from '../src/crypto/hkdf.js'
import { generateIdentity, identityFromKeys } from '../src/crypto/identity.js'
import { open as sealedOpen } from '../src/crypto/sealedbox.js'
import { safetyCode } from '../src/crypto/safetycode.js'

function hex(s: string): Uint8Array {
  const clean = s.replace(/\s/g, '')
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  return out
}

// base64 без зависимостей: atob/btoa есть и в браузере, и в node 22
function fromB64(text: string): Uint8Array {
  const raw = atob(text)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

function toB64(data: Uint8Array): string {
  let raw = ''
  for (const b of data) raw += String.fromCharCode(b)
  return btoa(raw)
}

function hexOf(data: Uint8Array): string {
  return [...data].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// PKCS8/SPKI для P-256 собираются вручную: WebCrypto не умеет импортировать
// голый скаляр, а векторы RFC 5903 заданы именно скалярами и точками.
function pkcs8P256(scalar: Uint8Array, x: Uint8Array, y: Uint8Array): Uint8Array {
  const body = [
    '308187020100301306072a8648ce3d020106082a8648ce3d030107046d306b0201010420',
    hexOf(scalar),
    'a14403420004',
    hexOf(x),
    hexOf(y),
  ].join('')
  return hex(body)
}

function spkiP256(x: Uint8Array, y: Uint8Array): Uint8Array {
  return hex(['3059301306072a8648ce3d020106082a8648ce3d03010703420004', hexOf(x), hexOf(y)].join(''))
}

const RFC5903 = {
  i: hex('C88F01F510D9AC3F70A292DAA2316DE544E9AAB8AFE84049C62A9C57862D1433'),
  iX: hex('DAD0B65394221CF9B051E1FECA5787D098DFE637FC90B9EF945D0C3772581180'),
  iY: hex('5271A0461CDB8252D61F1C456FA3E59AB1F45B33ACCF5F58389E0577B8990BB3'),
  r: hex('C6EF9C5D78AE012A011164ACB397CE2088685D8F06BF9BE0B283AB46476BEE53'),
  rX: hex('D12DFB5289C8D4F81208B70270398C342296970A0BCCB74C736FC7554494BF63'),
  rY: hex('56FBF3CA366CC23E8157854C13C58D6AAC23F046ADA30F8353E74F33039872AB'),
  shared: hex('D6840F6B42F6EDAFD13116E0E12565202FEF8E9ECE7DCE03812464D04B9442DE'),
}

describe('примитивы (векторы как в Kotlin)', () => {
  it('sha256("abc")', async () => {
    expect(hexOf(await sha256(new TextEncoder().encode('abc')))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })

  it('HMAC-SHA256, RFC 4231 case 1', async () => {
    const key = new Uint8Array(20).fill(0x0b)
    expect(hexOf(await hmacSha256(key, new TextEncoder().encode('Hi There')))).toBe(
      'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7',
    )
  })

  it('HKDF-SHA256, RFC 5869 case 1', async () => {
    const okm = await derive(
      new Uint8Array(22).fill(0x0b),
      hex('000102030405060708090a0b0c'),
      hex('f0f1f2f3f4f5f6f7f8f9'),
      42,
    )
    expect(hexOf(okm)).toBe(
      '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865',
    )
  })

  it('AES-GCM, McGrew-Viega case 1 (пустой текст — только тег)', async () => {
    const sealed = await aesGcmEncrypt(new Uint8Array(16), new Uint8Array(12), new Uint8Array(0), new Uint8Array(0))
    expect(hexOf(sealed)).toBe('58e2fccefa7e3061367f1d57a4e7455a')
    expect((await aesGcmDecrypt(new Uint8Array(16), new Uint8Array(12), sealed, new Uint8Array(0))).length).toBe(0)
  })

  it('ECDH P-256, RFC 5903 (обе стороны дают одну x-координату)', async () => {
    const iPriv = pkcs8P256(RFC5903.i, RFC5903.iX, RFC5903.iY)
    const rPub = spkiP256(RFC5903.rX, RFC5903.rY)
    const rPriv = pkcs8P256(RFC5903.r, RFC5903.rX, RFC5903.rY)
    const iPub = spkiP256(RFC5903.iX, RFC5903.iY)
    expect(hexOf(await ecdh(iPriv, rPub))).toBe(hexOf(RFC5903.shared))
    expect(hexOf(await ecdh(rPriv, iPub))).toBe(hexOf(RFC5903.shared))
  })
})

describe('схема', () => {
  it('публичный ключ — SPKI 91 байт', async () => {
    const blobs = await generateKeyPair()
    expect(blobs.publicSpki.length).toBe(SPKI_SIZE)
  })

  it('round-trip sealed box, включая пустое и большое сообщение', async () => {
    const alice = await generateIdentity()
    const bob = await generateIdentity()
    const text = new TextEncoder().encode('привет, мир')
    expect(await bob.open(await alice.seal(bob.publicKey(), text))).toEqual(text)
    expect((await bob.open(await alice.seal(bob.publicKey(), new Uint8Array(0)))).length).toBe(0)
    const big = new Uint8Array(1_000_000).map((_, i) => i % 251)
    const restored = await bob.open(await alice.seal(bob.publicKey(), big))
    // побайтовое сравнение мегабайта через toEqual в разы дороже самой крипты
    expect(hexOf(await sha256(restored))).toBe(hexOf(await sha256(big)))
  })

  it('самому себе и после восстановления из блобов', async () => {
    const blobs = await generateKeyPair()
    const restored = identityFromKeys(blobs.secretPkcs8, blobs.publicSpki)
    const self = new TextEncoder().encode('self')
    expect(await restored.open(await restored.seal(restored.publicKey(), self))).toEqual(self)
  })

  it('подмена тега/заголовка и чужой получатель — ошибка', async () => {
    const a = await generateIdentity()
    const b = await generateIdentity()
    const c = await generateIdentity()
    const sealed = await a.seal(b.publicKey(), new TextEncoder().encode('тест'))
    const tag = sealed.slice()
    tag[tag.length - 1] ^= 1
    await expect(b.open(tag)).rejects.toThrow()
    const head = sealed.slice()
    head[10] ^= 1
    await expect(b.open(head)).rejects.toThrow()
    await expect(c.open(sealed)).rejects.toThrow()
  })

  it('код сверки симметричен и шестизначен', async () => {
    const a = (await generateIdentity()).publicKey()
    const b = (await generateIdentity()).publicKey()
    const code = await safetyCode(a, b)
    expect(code).toBe(await safetyCode(b, a))
    expect(code).toMatch(/^\d{6}$/)
  })
})

// ─── кросс-языковая совместимость wire-формата ───────────────────────────
// Фикстура сгенерирована Java/JCA (тем же провайдером, что и Android/JVM):
// /tmp/wire/Fixture.java повторяет SealedBox.kt и Hkdf.kt байт-в-байт.
// Проверка двусторонняя (сделана вручную при разработке): Java-блоб
// открывается TS, TS-блоб открывается Java. Здесь закреплён первый конец,
// чтобы смена схемы в TS не разошлась с Kotlin молча.
const KOTLIN_FIXTURE = {
  spki: 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEMbC4x1XKhxa7k6o/C8KoWJAOLAnP4dqoI8+IFYozZY8DHlZNPfZBEdqGbsGLheNNs6CkF+7LFVh1IZdmfAD+OQ==',
  pkcs8: 'MEECAQAwEwYHKoZIzj0CAQYIKoZIzj0DAQcEJzAlAgEBBCB99zWqa13gly4Hc/FWj1TJyJEDZQGO+Iev0CbKN4GNsQ==',
  sealed:
    'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEpczMZDhIsiUuQWaq+bv2iwUeoiz6igrNY7UPv/My/bhJ/LVj7lOLL1DmoPo6WIeatg4xVSDMftu7tCgHuGHVcPpYJmBoiURbXY+VJbEuke33/J2RcBnV+oI2YDE5y+UeTfCrRw3AXGgqRhRRdJuxdQBYfhs=',
  plain: '0L/RgNC40LLQtdGCINC+0YIgS290bGlu', // «привет от Kotlin»
}

describe('кросс-язык с Kotlin/JCA', () => {
  it('блоб, запечатанный JCA, открывается в браузерной крипте', async () => {
    const bob = identityFromKeys(fromB64(KOTLIN_FIXTURE.pkcs8), fromB64(KOTLIN_FIXTURE.spki))
    const plain = await bob.open(fromB64(KOTLIN_FIXTURE.sealed))
    expect(toB64(plain)).toBe(KOTLIN_FIXTURE.plain)
    expect(new TextDecoder().decode(plain)).toBe('привет от Kotlin')
  })

  it('свой блоб имеет ту же раскладку: [SPKI 91][IV 12][ct||tag]', async () => {
    const bob = identityFromKeys(fromB64(KOTLIN_FIXTURE.pkcs8), fromB64(KOTLIN_FIXTURE.spki))
    const plain = new TextEncoder().encode('раскладка')
    const sealed = await bob.seal(fromB64(KOTLIN_FIXTURE.spki), plain)
    expect(sealed.length).toBe(91 + 12 + plain.length + 16)
    // открывается родной реализацией получателя (он же отправитель)
    const opened = await sealedOpen(fromB64(KOTLIN_FIXTURE.pkcs8), fromB64(KOTLIN_FIXTURE.spki), sealed)
    expect(new TextDecoder().decode(opened)).toBe('раскладка')
  })
})
