// Логика списка звонков (domain/call-log): сортировка, группировка по дню,
// формат записи. Чистые функции — без DOM.
import { describe, expect, it } from 'vitest'
import type { CallLogEntry } from '../src/store/chat-state.js'
import { STATUS_CANCELED, STATUS_COMPLETED, STATUS_MISSED, dayLabel, formatDuration, formatTime, groupByDay, sortCalls, statusText } from '../src/domain/call-log.js'

function entry(over: Partial<CallLogEntry> & { callId: string; at?: number }): CallLogEntry {
  return { peer: 'bob', outgoing: true, status: STATUS_COMPLETED, seconds: 0, at: 0, ...over }
}

function at(dayOffset: number, hour: number, minute = 0): number {
  const d = new Date()
  d.setHours(hour, minute, 0, 0)
  d.setDate(d.getDate() + dayOffset)
  return d.getTime()
}

describe('sortCalls', () => {
  it('сортирует по времени и убирает дубль по callId', () => {
    const a = entry({ callId: 'aaa', at: at(-1, 10), seconds: 65 })
    const b = entry({ callId: 'bbb', peer: 'ann', outgoing: false, status: STATUS_MISSED, at: at(0, 9) })
    const dup = entry({ callId: 'aaa', at: at(-2, 23) })

    expect(sortCalls([a, b, dup]).map((e) => e.callId)).toEqual(['bbb', 'aaa'])
  })
})

describe('groupByDay', () => {
  it('группирует по дням и держит порядок внутри дня', () => {
    const groups = groupByDay([
      entry({ callId: 't1', peer: 'ann', outgoing: false, status: STATUS_MISSED, at: at(0, 8) }),
      entry({ callId: 'y1', status: STATUS_CANCELED, at: at(-1, 12) }),
      entry({ callId: 't2', peer: 'cid', at: at(0, 20), seconds: 125 }),
    ])

    expect(groups).toHaveLength(2)
    expect(groups[0].entries.map((e) => e.callId)).toEqual(['t2', 't1'])
    expect(groups[1].entries.map((e) => e.callId)).toEqual(['y1'])
    expect(groups[0].dayStart).toBeGreaterThan(groups[1].dayStart)
  })
})

describe('формат записи', () => {
  it('длительность округляет до минут', () => {
    expect(formatDuration(0)).toBeNull()
    expect(formatDuration(42)).toBe('0:42')
    expect(formatDuration(65)).toBe('1:05')
  })

  it('время — HH:mm', () => {
    expect(formatTime(at(0, 9))).toMatch(/^\d{2}:\d{2}$/)
    expect(formatTime(at(0, 9))).toBe('09:00')
  })

  it('статус зависит от направления и статуса', () => {
    expect(statusText(entry({ callId: 'm1', peer: 'ann', outgoing: false, status: STATUS_MISSED }))).toBe('Пропущенный')
    expect(statusText(entry({ callId: 'm2', status: STATUS_MISSED }))).toBe('Нет ответа')
    expect(statusText(entry({ callId: 'd1', seconds: 65 }))).toBe('1:05')
  })
})

describe('dayLabel', () => {
  it('различает сегодня вчера и дату', () => {
    const now = at(0, 15)
    const midnight = (offsetDays = 0): number => {
      const d = new Date(at(offsetDays, 15))
      d.setHours(0, 0, 0)
      return d.getTime()
    }
    expect(dayLabel(midnight(), now)).toBe('Сегодня')
    expect(dayLabel(midnight(-1), now)).toBe('Вчера')
    const old = dayLabel(midnight(-5), now)
    expect(old === 'Сегодня' || old === 'Вчера').toBe(false)
    expect(old).toMatch(/^\d+ \S+$/)
  })
})