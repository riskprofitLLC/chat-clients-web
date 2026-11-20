// Чистые хелперы палитры: разбор цвета и контраст WCAG на опорных значениях.
import { describe, expect, it } from 'vitest'
import { contrastRatio, parseColor, relativeLuminance } from '../src/ui/palette.js'

describe('parseColor', () => {
  it('разбирает #rrggbb', () => {
    expect(parseColor('#70B15C')).toEqual({ r: 112, g: 177, b: 92 })
  })

  it('разбирает короткую форму #rgb', () => {
    expect(parseColor('#fff')).toEqual({ r: 255, g: 255, b: 255 })
  })

  it('не разбирает мусор', () => {
    expect(parseColor('rgb(1,2,3)')).toBeNull()
    expect(parseColor('#12345')).toBeNull()
    expect(parseColor('')).toBeNull()
  })
})

describe('relativeLuminance', () => {
  it('границы шкалы', () => {
    expect(relativeLuminance({ r: 255, g: 255, b: 255 })).toBeCloseTo(1, 5)
    expect(relativeLuminance({ r: 0, g: 0, b: 0 })).toBeCloseTo(0, 5)
  })

  it('зелёный канал весит больше синего', () => {
    const green = relativeLuminance({ r: 0, g: 255, b: 0 })
    const blue = relativeLuminance({ r: 0, g: 0, b: 255 })
    expect(green).toBeGreaterThan(blue)
  })
})

describe('contrastRatio', () => {
  it('чёрное на белом — потолок шкалы', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 1)
  })

  it('цвет на самом себе — единица', () => {
    expect(contrastRatio('#777777', '#777777')).toBeCloseTo(1, 5)
  })

  it('порядок аргументов не важен', () => {
    expect(contrastRatio('#1A1D21', '#FFFFFF')).toBeCloseTo(contrastRatio('#FFFFFF', '#1A1D21'), 10)
  })

  it('не hex — исключение', () => {
    expect(() => contrastRatio('#fff', 'red')).toThrow()
  })
})