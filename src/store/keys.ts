// TOFU-память: отпечатки ключей устройств собеседника.
// Первый контакт запоминается молча, смена ключа известного устройства
// требует подтверждения пользователем (как KeyChangedException в Android).
import { text, utf8 } from '../util/bytes.js'
import { digestOf } from '../domain/tofu.js'
import type { Kv } from './kv.js'

export interface KnownPeer {
  devices: Record<string, string>
  // ключ сверки, подтверждённый пользователем (SafetyCodes)
  verified?: boolean
  reverifyRequired?: boolean
  updatedAt: number
}

export class KeysStore {
  constructor(private readonly kv: Kv) {}

  private key(peer: string): string {
    return `tofu:${peer}`
  }

  async get(peer: string): Promise<KnownPeer | null> {
    const raw = await this.kv.get(this.key(peer))
    if (!raw) return null
    try {
      return JSON.parse(text(raw)) as KnownPeer
    } catch {
      return null
    }
  }

  async known(peer: string): Promise<Map<string, string>> {
    const entry = await this.get(peer)
    return new Map(Object.entries(entry?.devices ?? {}))
  }

  async remember(peer: string, devices: Array<[string, Uint8Array]>, options?: { verified?: boolean; reverifyRequired?: boolean }): Promise<void> {
    const existing = await this.get(peer)
    const map: Record<string, string> = {}
    for (const [deviceId, pub] of devices) map[deviceId] = await digestOf(pub)
    await this.kv.put(
      this.key(peer),
      utf8(
        JSON.stringify({
          devices: map,
          verified: options?.verified ?? existing?.verified ?? false,
          reverifyRequired: options?.reverifyRequired ?? false,
          updatedAt: Date.now(),
        } satisfies KnownPeer),
      ),
    )
  }

  async markVerified(peer: string): Promise<void> {
    const existing = await this.get(peer)
    if (!existing) return
    await this.kv.put(
      this.key(peer),
      utf8(JSON.stringify({ ...existing, verified: true, reverifyRequired: false } satisfies KnownPeer)),
    )
  }

  async forget(peer: string): Promise<void> {
    await this.kv.delete(this.key(peer))
  }

  async peers(): Promise<string[]> {
    const entries = await this.kv.list('tofu:')
    return entries.map((e) => e.key.slice(5))
  }
}
