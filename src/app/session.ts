// Активная сессия: логин, токен, устройство, идентичность, API и сторы.
// Порт data/Session.kt: та же схема fan-out (seal для каждого устройства).
import { sha256 } from '../crypto/primitives.js'
import type { E2E } from '../crypto/identity.js'
import { concat, toHex, utf8 } from '../util/bytes.js'
import type { RelayApi } from '../net/api.js'

export interface DeviceKeyPair {
  deviceId: string
  pubSpki: Uint8Array
}

export class SessionInfo {
  constructor(
    readonly login: string,
    readonly token: string,
    readonly deviceId: string,
    readonly identity: E2E,
    readonly api: RelayApi,
  ) {}

  // seal одного payload для набора устройств (fan-out)
  async sealFor(devices: DeviceKeyPair[], payload: Uint8Array): Promise<Array<[string, Uint8Array]>> {
    const out: Array<[string, Uint8Array]> = []
    for (const device of devices) {
      out.push([device.deviceId, await this.identity.seal(device.pubSpki, payload)])
    }
    return out
  }

  // ключ дедупликации входящего блоба: отправитель + байты
  async dedupKey(from: string, blob: Uint8Array): Promise<string> {
    return toHex(await sha256(concat(utf8(from), blob)))
  }
}
