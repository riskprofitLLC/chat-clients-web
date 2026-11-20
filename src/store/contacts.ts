// Контактная книга: имя, отображаемое в списке чатов, и email для дискавери.
// Локальные данные — на сервер уходят только хэши email (discover).
import { text, utf8 } from '../util/bytes.js'
import type { Kv } from './kv.js'

export interface Contact {
  login: string
  name: string
  email?: string
  updatedAt: number
}

export class ContactsStore {
  constructor(private readonly kv: Kv) {}

  private key(login: string): string {
    return `contact:${login}`
  }

  async get(login: string): Promise<Contact | null> {
    const raw = await this.kv.get(this.key(login))
    if (!raw) return null
    try {
      return JSON.parse(text(raw)) as Contact
    } catch {
      return null
    }
  }

  async put(contact: Contact): Promise<void> {
    await this.kv.put(this.key(contact.login), utf8(JSON.stringify(contact)))
  }

  async rename(login: string, name: string): Promise<void> {
    const existing = await this.get(login)
    await this.put({ login, name: name.slice(0, 64), email: existing?.email, updatedAt: Date.now() })
  }

  async remove(login: string): Promise<void> {
    await this.kv.delete(this.key(login))
  }

  async all(): Promise<Contact[]> {
    const entries = await this.kv.list('contact:')
    const out: Contact[] = []
    for (const entry of entries) {
      try {
        out.push(JSON.parse(text(entry.value)) as Contact)
      } catch {
        // битая запись не роняет список контактов
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name, 'ru'))
  }

  async byName(login: string): Promise<string> {
    return (await this.get(login))?.name || login
  }
}
