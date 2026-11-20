// PinLock (P-W5): установка и проверка кода, счётчик неудач и пауза.
// Состояние — в префах поверх MemoryKv, поэтому перезапуск стора
// блокировку не снимает.
import { describe, expect, it } from 'vitest'
import { MemoryKv } from '../src/store/kv.js'
import { PrefsStore } from '../src/store/prefs.js'
import { PinLock } from '../src/store/pin.js'

async function makeLock(): Promise<{ lock: PinLock; prefs: PrefsStore }> {
  const kv = new MemoryKv()
  const prefs = new PrefsStore(kv)
  return { lock: new PinLock(prefs), prefs }
}

describe('PinLock', () => {
  it('после установки кода блокировка включена', async () => {
    const { lock } = await makeLock()
    expect((await lock.state()).enabled).toBe(false)
    await lock.setPin('123456')
    const state = await lock.state()
    expect(state.enabled).toBe(true)
    expect(state.hasPin).toBe(true)
    expect(await lock.verify('123456')).toEqual({ ok: true })  })

  it('неверный код растит счётчик, верный его сбрасывает', async () => {
    const { lock } = await makeLock()
    await lock.setPin('123456')
    expect(await lock.verify('111111')).toEqual({ ok: false, remainingMs: 0 })
    expect((await lock.state()).failCount).toBe(1)
    expect(await lock.verify('123456')).toEqual({ ok: true })
    expect((await lock.state()).failCount).toBe(0)
  })

  it('с третьей неудачи включается пауза и ввод в ней не проверяется', async () => {
    const { lock, prefs } = await makeLock()
    await lock.setPin('123456')
    await lock.verify('111111')
    await lock.verify('222222')
    const verdict = await lock.verify('333333')
    expect(verdict.ok).toBe(false)
    expect(verdict.ok === false && verdict.remainingMs).toBeGreaterThan(0)
    // в паузе даже верный код не принимается
    expect((await lock.verify('123456')).ok).toBe(false)
    // остаток виден экрану блокировки
    expect(await lock.remainingMs()).toBeGreaterThan(0)
    // пауза истекла — верный код снова работает и счётчик обнулён
    await prefs.patch({ pinLockedUntil: Date.now() - 1_000 })
    expect(await lock.verify('123456')).toEqual({ ok: true })
    expect((await lock.state()).failCount).toBe(0)
  })

  it('выключение снимает блокировку, но сохраняет код для повторного включения', async () => {
    const { lock } = await makeLock()
    await lock.setPin('123456')
    await lock.disable()
    expect((await lock.state()).enabled).toBe(false)
    expect((await lock.state()).hasPin).toBe(true)
  })

  it('некорректный код не устанавливается', async () => {
    const { lock } = await makeLock()
    await expect(lock.setPin('12345')).rejects.toThrow()
    await expect(lock.setPin('12345a')).rejects.toThrow()
    expect((await lock.state()).hasPin).toBe(false)
  })
})
