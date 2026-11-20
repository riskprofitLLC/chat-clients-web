// PIN-блокировка: чистые правила — длина кода и растущая пауза после неудач
// (аналог domain/PinThrottle.kt). Всё состояние живёт в префах, поэтому
// убийство вкладки не снимает блокировку.

export const PIN_LENGTH = 6

// из ввода оставляем только цифры и не длиннее шести (A7)
export function sanitizePin(raw: string): string {
  return raw.replace(/\D/g, '').slice(0, PIN_LENGTH)
}

export function isValidPin(pin: string): boolean {
  return pin.length === PIN_LENGTH && /^\d+$/.test(pin)
}

// пауза после count-й неудачи подряд: без паузы / без паузы / 30с / 1м /
// 5м / 15м / 1ч (потолок). Первые две попытки не блокируют ввод.
const BACKOFF_STEPS_MS = [0, 0, 30_000, 60_000, 300_000, 900_000, 3_600_000]

export function backoffMs(failCount: number): number {
  if (failCount < 1) return 0
  return BACKOFF_STEPS_MS[Math.min(failCount - 1, BACKOFF_STEPS_MS.length - 1)]
}

export interface PinDecision {
  allowed: boolean
  remainingMs: number
}

// решение по вводу: пока идёт пауза — отказ с остатком (PBKDF2 не считаем)
export function decide(failCount: number, lockedUntil: number, now: number): PinDecision {
  // failCount не влияет на решение напрямую: пауза уже записана в lockedUntil
  void failCount
  const remaining = lockedUntil - now
  return remaining > 0 ? { allowed: false, remainingMs: remaining } : { allowed: true, remainingMs: 0 }
}

// «мм:сс» для обратного отсчёта на экране блокировки
export function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const minutes = Math.floor(total / 60)
  return `${String(minutes).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}