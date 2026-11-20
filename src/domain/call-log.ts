// Логика списка звонков для экрана «Звонки»: сортировка, группировка по
// дню, формат записи. Чистые функции — UI только отображает результат.
import type { CallLogEntry } from '../store/chat-state.js'

export const STATUS_COMPLETED = 'completed'
export const STATUS_DECLINED = 'declined'
export const STATUS_CANCELED = 'canceled'
export const STATUS_MISSED = 'missed'

export interface CallDayGroup {
  dayStart: number
  entries: CallLogEntry[]
}

const DAY_MS = 24 * 60 * 60 * 1000

// полночь дня метки at (по локальной зоне браузера)
export function dayStart(at: number): number {
  const d = new Date(at)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

// свежие сверху, дубль по callId не показываем
export function sortCalls(entries: readonly CallLogEntry[]): CallLogEntry[] {
  const seen = new Set<string>()
  const out: CallLogEntry[] = []
  for (const entry of [...entries].sort((a, b) => b.at - a.at)) {
    if (seen.has(entry.callId)) continue
    seen.add(entry.callId)
    out.push(entry)
  }
  return out
}

export function groupByDay(entries: readonly CallLogEntry[]): CallDayGroup[] {
  const groups = new Map<number, CallLogEntry[]>()
  for (const entry of sortCalls(entries)) {
    const day = dayStart(entry.at)
    const list = groups.get(day)
    if (list) list.push(entry)
    else groups.set(day, [entry])
  }
  return [...groups.entries()].sort((a, b) => b[0] - a[0]).map(([day, items]) => ({ dayStart: day, entries: items }))
}

// «1:05»; звонок без связи — null
export function formatDuration(seconds: number): string | null {
  if (!Number.isFinite(seconds) || seconds <= 0) return null
  const total = Math.floor(seconds)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

export function formatTime(at: number): string {
  const d = new Date(at)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// «Сегодня» / «Вчера» / дата; now — опорный момент (тесты дают свой)
export function dayLabel(dayStartMs: number, now: number): string {
  const today = dayStart(now)
  if (dayStartMs === today) return 'Сегодня'
  if (dayStartMs === today - DAY_MS) return 'Вчера'
  const d = new Date(dayStartMs)
  return `${d.getDate()} ${monthName(d.getMonth())}`
}

function monthName(month: number): string {
  const names = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря']
  return names[month] ?? ''
}

// статус записи текстом для строки списка
export function statusText(entry: CallLogEntry): string {
  switch (entry.status) {
    case STATUS_MISSED:
      return entry.outgoing ? 'Нет ответа' : 'Пропущенный'
    case STATUS_DECLINED:
      return entry.outgoing ? 'Отклонён' : 'Отклонённый'
    case STATUS_CANCELED:
      return entry.outgoing ? 'Отменён' : 'Отменённый'
    default:
      return formatDuration(entry.seconds) ?? 'Завершённый'
  }
}