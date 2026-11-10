// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { qrMatrix } from '../src/util/qr.js'

// эталонные размеры: version * 4 + 17
describe('qrMatrix: размер и структура символа', () => {
  it('короткий код даёт версию 1 (21x21)', () => {
    const qr = qrMatrix('ab')
    expect(qr.size).toBe(21)
    expect(qr.modules).toHaveLength(21)
    expect(qr.modules[0]).toHaveLength(21)
  })

  it('код привязки nonce|secret влезает в версию не выше 10', () => {
    const code = `${'a'.repeat(64)}|${'b'.repeat(64)}`
    const qr = qrMatrix(code)
    expect(qr.size).toBeGreaterThan(21)
    expect(qr.size).toBeLessThanOrEqual(57)
  })

  it('три поисковых узора на месте и тёмные по рамке', () => {
    const qr = qrMatrix('x')
    for (const [ox, oy] of [[0, 0], [14, 0], [0, 14]] as const) {
      expect(qr.modules[oy][ox]).toBe(true) // центр узора тёмный
      expect(qr.modules[oy + 1][ox + 1]).toBe(false) // кольцо вокруг центра светлое
      expect(qr.modules[oy + 2][ox + 2]).toBe(true) // внешнее кольцо тёмное
    }
  })

  it('синхропоследовательность по строке и столбцу 6 чередуется', () => {
    const qr = qrMatrix('x')
    for (let i = 8; i < 13; i++) {
      expect(qr.modules[6][i]).toBe(i % 2 === 0)
      expect(qr.modules[i][6]).toBe(i % 2 === 0)
    }
  })

  it('тёмный модуль формата в правом нижнем углу', () => {
    const qr = qrMatrix('x')
    expect(qr.modules[qr.size - 8][8]).toBe(true)
  })

  it('разные тексты дают разные матрицы', () => {
    expect(JSON.stringify(qrMatrix('one'))).not.toBe(JSON.stringify(qrMatrix('two')))
  })

  it('одинаковый текст даёт одинаковую матрицу', () => {
    expect(JSON.stringify(qrMatrix('same'))).toBe(JSON.stringify(qrMatrix('same')))
  })

  it('не влезающийся текст отвергается', () => {
    expect(() => qrMatrix('z'.repeat(400))).toThrow(/длинный/)
  })
})
