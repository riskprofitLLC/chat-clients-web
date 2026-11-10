// Профили собеседников: «О себе» (TYPE_BIO), аватар (медиа с полем ava),
// день рождения. В журнал эти события не пишутся — они применяются к профилю.
import { text, utf8 } from '../util/bytes.js'
import type { Kv } from './kv.js'

export interface Profile {
  login: string
  bio: string
  birthday?: string
  // id медиа-блоба аватара; '' — аватара нет (снятие)
  avatarId: string
  avatarKey?: string
  avatarEmoji?: string
  updatedAt: number
}

export class ProfilesStore {
  constructor(private readonly kv: Kv) {}

  private key(login: string): string {
    return `profile:${login}`
  }

  async get(login: string): Promise<Profile | null> {
    const raw = await this.kv.get(this.key(login))
    if (!raw) return null
    try {
      return JSON.parse(text(raw)) as Profile
    } catch {
      return null
    }
  }

  async patch(login: string, changes: Partial<Profile>): Promise<Profile> {
    const existing =
      (await this.get(login)) ??
      ({ login, bio: '', avatarId: '', updatedAt: 0 } satisfies Profile)
    const next: Profile = { ...existing, ...changes, login, updatedAt: Date.now() }
    await this.kv.put(this.key(login), utf8(JSON.stringify(next)))
    return next
  }

  async all(): Promise<Map<string, Profile>> {
    const out = new Map<string, Profile>()
    for (const entry of await this.kv.list('profile:')) {
      try {
        out.set(entry.key.slice(8), JSON.parse(text(entry.value)) as Profile)
      } catch {
        // битый профиль не роняет список
      }
    }
    return out
  }
}
