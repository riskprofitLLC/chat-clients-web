// Общий бейдж непрочитанного: строка списка и таб «Чаты» одной логикой.
import { describe, expect, it } from 'vitest'
import { formatUnbadge, totalUnread } from '../src/ui/unbadge.js'

describe('formatUnbadge', () => {
  it('мелочь показываем как есть', () => {
    expect(formatUnbadge(0)).toBe('0')
    expect(formatUnbadge(7)).toBe('7')
  })

  it('99 — потолок точного числа', () => {
    expect(formatUnbadge(99)).toBe('99')
  })

  it('дальше 99 — счётчик «99+»', () => {
    expect(formatUnbadge(100)).toBe('99+')
    expect(formatUnbadge(4_000)).toBe('99+')
  })
})

describe('totalUnread', () => {
  it('сумма непрочитанного по чатам', () => {
    expect(totalUnread([{ unread: 3 }, { unread: 4 }, { unread: 0 }])).toBe(7)
  })

  it('пустой список — ноль', () => {
    expect(totalUnread([])).toBe(0)
  })

  it('отсутствующее поле считается нулём', () => {
    expect(totalUnread([{}, { unread: 2 }])).toBe(2)
  })
})