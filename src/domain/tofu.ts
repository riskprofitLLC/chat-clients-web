// Чистая логика TOFU: сравнение известных ключей устройства собеседника
// с текущим составом. Вердикт решает, молча запомнить, продолжать или
// блокировать отправку до подтверждения пользователем.
import { sha256 } from '../crypto/primitives.js'
import { toHex } from '../util/bytes.js'

export type TofuVerdict =
  | { kind: 'firstSeen' }
  | { kind: 'ok' }
  | { kind: 'changed'; devices: string[] }
  | { kind: 'newDevice'; devices: string[] }

export async function digestOf(pub: Uint8Array): Promise<string> {
  return toHex(await sha256(pub))
}

// нужна ли повторная сверка кода после обновления состава устройств:
// сброс — если ключ известного устройства изменился ИЛИ появилось новое
export async function requiresReverify(
  previous: Map<string, string>,
  current: Array<[string, Uint8Array]>,
): Promise<boolean> {
  if (previous.size === 0) return false
  for (const [deviceId, pub] of current) {
    const digest = await digestOf(pub)
    const was = previous.get(deviceId)
    if (was === undefined) return true
    if (was !== digest) return true
  }
  return false
}

export async function verdict(
  known: Map<string, string>,
  current: Array<[string, Uint8Array]>,
): Promise<TofuVerdict> {
  if (known.size === 0) return { kind: 'firstSeen' }
  const changed: string[] = []
  const added: string[] = []
  for (const [deviceId, pub] of current) {
    const digest = await digestOf(pub)
    const stored = known.get(deviceId)
    if (stored === undefined) added.push(deviceId)
    else if (stored !== digest) changed.push(deviceId)
  }
  if (changed.length > 0) return { kind: 'changed', devices: changed }
  if (added.length > 0) return { kind: 'newDevice', devices: added }
  return { kind: 'ok' }
}
