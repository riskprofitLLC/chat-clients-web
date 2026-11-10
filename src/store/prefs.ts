// Настройки клиента: не секреты, поэтому лежат открытым JSON.
// Секреты (токен, PKCS8 идентичности, ключ данных) — в secrets.ts.
import { text, utf8 } from '../util/bytes.js'
import type { Kv } from './kv.js'

export interface TurnServer {
  urls: string
  username?: string
  credential?: string
}

export interface Prefs {
  serverUrl: string
  // TURN обязателен для web: UDP-мост, которым пользуется Android,
  // в браузере невозможен (нет доступа к сырым DTLS-пакетам)
  iceServers: TurnServer[]
  theme: 'auto' | 'light' | 'dark'
  // акцент: id пресета (см. ui/theme.ts)
  accent: string
  notifications: boolean
  notificationSound: boolean
  // текст сообщения в системном уведомлении: по умолчанию выключено (E2E)
  notificationText: boolean
  quickReaction: string
  presenceHidden: boolean
  readReceipts: boolean
  typingIndicator: boolean
  autoDownloadMedia: boolean
  // установка на домашний экран: на Safari без неё IndexedDB сносится
  // через 7 дней — клиент требует установку и предупреждает
  installPromptSeen: boolean
  lastChat: string | null
}

export const DEFAULT_SERVER = 'https://ednar.duckdns.org'

export const DEFAULT_PREFS: Prefs = {
  serverUrl: DEFAULT_SERVER,
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  theme: 'auto',
  accent: 'blue',
  notifications: true,
  notificationSound: true,
  notificationText: false,
  quickReaction: '❤️',
  presenceHidden: false,
  readReceipts: true,
  typingIndicator: true,
  autoDownloadMedia: true,
  installPromptSeen: false,
  lastChat: null,
}

const KEY = 'prefs'

export class PrefsStore {
  constructor(private readonly kv: Kv) {}

  async load(): Promise<Prefs> {
    const raw = await this.kv.get(KEY)
    if (!raw) return { ...DEFAULT_PREFS }
    try {
      const parsed = JSON.parse(text(raw)) as Partial<Prefs>
      // неизвестные поля игнорируем, недостающие берём из дефолтов:
      // старая версия настроек не ломает новый клиент
      return { ...DEFAULT_PREFS, ...parsed }
    } catch {
      return { ...DEFAULT_PREFS }
    }
  }

  async save(prefs: Prefs): Promise<void> {
    await this.kv.put(KEY, utf8(JSON.stringify(prefs)))
  }

  async patch(changes: Partial<Prefs>): Promise<Prefs> {
    const next = { ...(await this.load()), ...changes }
    await this.save(next)
    return next
  }
}
