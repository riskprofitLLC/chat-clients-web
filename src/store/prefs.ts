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
  // сортировка контактов: по имени или по времени захода (аналог Telegram)
  contactsSort: 'name' | 'lastSeen'
  // блокировка приложения PIN-кодом (P-W5): соль и хэш PBKDF2 лежат здесь,
  // состояние троттлинга — тоже, поэтому пауза переживает перезапуск
  lockEnabled: boolean
  pinSalt: string | null
  pinHash: string | null
  pinFailCount: number
  pinLockedUntil: number
  // автоблокировка по бездействию в секундах; 0 — выключена
  autoLockSec: number
}

export const DEFAULT_SERVER = 'https://ednar.duckdns.org'

// свой STUN релея: без сторонних серверов в установке соединения
export const DEFAULT_STUN_URL = 'stun:ednar.duckdns.org:3478'

export const DEFAULT_PREFS: Prefs = {
  serverUrl: DEFAULT_SERVER,
  iceServers: [{ urls: DEFAULT_STUN_URL }],
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
  contactsSort: 'name',
  lockEnabled: false,
  pinSalt: null,
  pinHash: null,
  pinFailCount: 0,
  pinLockedUntil: 0,
  autoLockSec: 0,
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
