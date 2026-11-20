// PIN-блокировка приложения (P-W5): установка и проверка кода, счётчик
// неудач и растущая пауза. Соль/хэш и состояние троттлинга — в префах,
// поэтому перезапуск вкладки блокировку не снимает. Сброс — выход из
// аккаунта (prefs-записи удаляются вместе с данными).
import { equals } from '../util/bytes.js'
import { fromBase64 } from '../util/b64.js'
import { newPinSalt, pinHash } from '../crypto/pbkdf2.js'
import { backoffMs, decide, isValidPin } from '../domain/pin.js'
import type { PrefsStore } from './prefs.js'

export interface PinState {
  enabled: boolean
  hasPin: boolean
  failCount: number
}

export type PinVerdict =
  | { ok: true }
  | { ok: false; remainingMs: number }

export class PinLock {
  constructor(private readonly prefsStore: PrefsStore) {}

  async state(): Promise<PinState> {
    const prefs = await this.prefsStore.load()
    return {
      enabled: prefs.lockEnabled && prefs.pinHash !== null,
      hasPin: prefs.pinHash !== null,
      failCount: prefs.pinFailCount,
    }
  }

  // установка кода: соль и хэш пишутся сразу вместе с флагом — после
  // перезапуска блокировка не «пропадает» без кода
  async setPin(pin: string): Promise<void> {
    if (!isValidPin(pin)) throw new Error('PIN должен быть шестью цифрами')
    const salt = newPinSalt()
    await this.prefsStore.patch({
      pinSalt: salt,
      pinHash: await pinHash(pin, salt),
      lockEnabled: true,
      pinFailCount: 0,
      pinLockedUntil: 0,
    })
  }

  // выключение блокировки: хэш остаётся, включение обратно не требует нового кода
  async disable(): Promise<void> {
    await this.prefsStore.patch({ lockEnabled: false, pinFailCount: 0, pinLockedUntil: 0 })
  }

  async remainingMs(): Promise<number> {
    const prefs = await this.prefsStore.load()
    return decide(prefs.pinFailCount, prefs.pinLockedUntil, Date.now()).remainingMs
  }

  // проверка кода: в паузе — отказ без вычисления PBKDF2; успех сбрасывает
  // счётчик и паузу, неудача растит счётчик и включает следующую паузу
  async verify(pin: string): Promise<PinVerdict> {
    const prefs = await this.prefsStore.load()
    if (!prefs.pinHash || !prefs.pinSalt) return { ok: false, remainingMs: 0 }
    const decision = decide(prefs.pinFailCount, prefs.pinLockedUntil, Date.now())
    if (!decision.allowed) return { ok: false, remainingMs: decision.remainingMs }
    const expected = fromBase64(prefs.pinHash)
    const candidate = expected ? fromBase64(await pinHash(pin, prefs.pinSalt)) : null
    if (expected && candidate && equals(expected, candidate)) {
      await this.prefsStore.patch({ pinFailCount: 0, pinLockedUntil: 0 })
      return { ok: true }
    }
    const failCount = prefs.pinFailCount + 1
    const pause = backoffMs(failCount)
    await this.prefsStore.patch({
      pinFailCount: failCount,
      pinLockedUntil: pause > 0 ? Date.now() + pause : 0,
    })
    return { ok: false, remainingMs: pause }
  }
}
