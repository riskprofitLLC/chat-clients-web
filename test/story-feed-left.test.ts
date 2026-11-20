// Остаток жизни истории: часы и минуты без DOM — формат отдельно.
import { describe, expect, it } from 'vitest'
import { storyLeftParts } from '../src/domain/story-feed.js'

describe('storyLeftParts', () => {
  it('.меньше часа — только минуты', () => {
    expect(storyLeftParts(59_000)).toEqual({ hours: 0, minutes: 0 })
    expect(storyLeftParts(5 * 60_000)).toEqual({ hours: 0, minutes: 5 })
    expect(storyLeftParts(59 * 60_000 + 59_000)).toEqual({ hours: 0, minutes: 59 })
  })

  it('.часы и минуты, отрицательный остаток обрезается в ноль', () => {
    expect(storyLeftParts(12 * 3_600_000 + 5 * 60_000)).toEqual({ hours: 12, minutes: 5 })
    expect(storyLeftParts(-5_000)).toEqual({ hours: 0, minutes: 0 })
    // секунды в минуты не превращаются: 65 c — это ещё 1 минута
    expect(storyLeftParts(65_000)).toEqual({ hours: 0, minutes: 1 })
  })
})
