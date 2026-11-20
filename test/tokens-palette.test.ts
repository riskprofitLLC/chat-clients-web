// Токены темы: значения палитры из tg-design-brief.md §1 и осмысленный контраст.
// Тест парсит tokens.css и проверяет и точные значения ролей, и пороги читаемости,
// чтобы подгонка «под любой цвет» не проходила.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { contrastRatio } from '../src/ui/palette.js'

function block(css: string, marker: string): Record<string, string> {
  const start = css.indexOf(marker)
  expect(start, `блок ${marker} не найден`).toBeGreaterThan(-1)
  const open = css.indexOf('{', start)
  let depth = 0
  let end = open
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++
    else if (css[i] === '}') {
      depth--
      if (depth === 0) {
        end = i
        break
      }
    }
  }
  const body = css.slice(open + 1, end)
  const out: Record<string, string> = {}
  for (const match of body.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) out[match[1]] = match[2].trim()
  return out
}

const css = readFileSync('src/ui/styles/tokens.css', 'utf8')
const light = block(css, ':root {')
const darkMedia = block(css, ":root:not([data-theme='light'])")
const darkAttr = block(css, ":root[data-theme='dark']")

describe('светлая тема — значения §1', () => {
  it('фоны и поверхности', () => {
    expect(light['bg']).toBe('#FFFFFF')
    expect(light['surface-2']).toBe('#F1F1F3')
    expect(light['border']).toBe('#D9D9D9')
  })

  it('пузыри и текст', () => {
    expect(light['bubble-theirs']).toBe('#FFFFFF')
    expect(light['bubble-mine']).toBe('#EFFFDE')
    expect(light['text']).toBe('#1A1D21')
    expect(light['text-muted']).toBe('#63686E')
  })

  it('поля ввода: фон #F2F4F5, подсказка #98A0A7, иконка #A1A8AF', () => {
    expect(light['field-bg']).toBe('#F2F4F5')
    expect(light['field-hint']).toBe('#98A0A7')
    expect(light['field-icon']).toBe('#A1A8AF')
  })

  it('акцент blue — из директивы оператора', () => {
    const accent = block(css, ":root[data-accent='blue']")
    expect(accent['accent']).toBe('#0F6FBF')
    expect(accent['accent-text']).toBe('#ffffff')
  })
})

describe('тёмная тема — три уровня поверхностей (§1 night)', () => {
  for (const [name, dark] of [
    ['prefers-color-scheme', darkMedia],
    ['data-theme=dark', darkAttr],
  ] as const) {
    it(`${name}: фон темнее аппбара, аппбар темнее пузырей`, () => {
      expect(dark['bg']).toBe('#0E1621')
      expect(dark['bg-elevated']).toBe('#17212B')
      expect(dark['surface']).toBe('#17212B')
      expect(dark['bubble-theirs']).toBe('#182533')
      expect(dark['bubble-mine']).toBe('#2B5278')
      // уровни действительно разведены по яркости
      const lums = [dark['bg'], dark['surface'], dark['bubble-theirs'], dark['bubble-mine']].map((hex) =>
        contrastRatio(hex, '#000000'),
      )
      const sorted = [...lums].sort((a, b) => a - b)
      expect(lums).toEqual(sorted)
    })

    it(`${name}: поля — поверхность`, () => {
      expect(dark['field-bg']).toBe('#17212B')
      expect(dark['field-hint']).toBe(dark['text-muted'])
      expect(dark['field-icon']).toBe(dark['text-muted'])
    })
  }
})

describe('контраст текста — осмысленные пороги', () => {
  it('светлая: основной текст и подписи читаемы', () => {
    expect(contrastRatio(light['text'], light['bg'])).toBeGreaterThanOrEqual(7)
    expect(contrastRatio(light['text-muted'], light['bg'])).toBeGreaterThanOrEqual(4.5)
  })

  it('тёмная: основной текст и подписи читаемы на фоне и поверхности', () => {
    for (const dark of [darkMedia, darkAttr]) {
      expect(contrastRatio(dark['text'], dark['bg'])).toBeGreaterThanOrEqual(7)
      expect(contrastRatio(dark['text-muted'], dark['bg'])).toBeGreaterThanOrEqual(4.5)
      expect(contrastRatio(dark['text-muted'], dark['surface'])).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('подпись на акценте контрастна', () => {
    const accent = block(css, ":root[data-accent='blue']")
    expect(contrastRatio(accent['accent-text'], accent['accent'])).toBeGreaterThanOrEqual(4.5)
  })

  it('мета времени в пузырях не исчезает (порог §-значений TG)', () => {
    // время во входящем #A1AAB3 / в исходящем #70B15C — намеренно тихие значения TG,
    // порог не даёт утащить их в невидимые тона
    expect(contrastRatio('#A1AAB3', light['bubble-theirs'])).toBeGreaterThanOrEqual(2)
    expect(contrastRatio('#70B15C', light['bubble-mine'])).toBeGreaterThanOrEqual(2)
    for (const dark of [darkMedia, darkAttr]) {
      expect(contrastRatio('#93A3B1', dark['bubble-theirs'])).toBeGreaterThanOrEqual(4.5)
      expect(contrastRatio('#93A3B1', dark['bubble-mine'])).toBeGreaterThanOrEqual(3)
    }
  })

  it('подсказки полей различимы на фоне поля', () => {
    for (const theme of [light, darkMedia, darkAttr]) {
      expect(contrastRatio(theme['field-hint'], theme['field-bg'])).toBeGreaterThanOrEqual(2)
      expect(contrastRatio(theme['field-icon'], theme['field-bg'])).toBeGreaterThanOrEqual(2)
    }
  })
})