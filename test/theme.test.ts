// @vitest-environment happy-dom
// Тема и акцент: атрибуты на <html> плюс цвет системной панели.
import { afterEach, describe, expect, it } from 'vitest'
import { ACCENTS, THEMES, applyTheme } from '../src/ui/theme.js'

function metas(): NodeListOf<HTMLMetaElement> {
  return document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')
}

afterEach(() => {
  document.documentElement.removeAttribute('data-theme')
  document.documentElement.removeAttribute('data-accent')
})

describe('каталог тем и акцентов', () => {
  it('три темы с подписями и шесть акцентов с цветами', () => {
    expect(THEMES.map((entry) => entry.id)).toEqual(['auto', 'light', 'dark'])
    for (const entry of THEMES) expect(entry.label.length).toBeGreaterThan(0)
    expect(ACCENTS).toHaveLength(6)
    for (const accent of ACCENTS) expect(accent.color).toMatch(/^#[0-9a-f]{6}$/i)
  })
})

describe('applyTheme', () => {
  it('auto снимает data-theme, остальные темы ставят его', () => {
    applyTheme('auto', 'blue')
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false)
    applyTheme('light', 'blue')
    expect(document.documentElement.dataset.theme).toBe('light')
    applyTheme('dark', 'blue')
    expect(document.documentElement.dataset.theme).toBe('dark')
  })

  it('неизвестный акцент откатывается на синий', () => {
    applyTheme('dark', 'teal')
    expect(document.documentElement.dataset.accent).toBe('teal')
    applyTheme('dark', 'нет такого')
    expect(document.documentElement.dataset.accent).toBe('blue')
  })

  it('цвет панели: тёмная тема и светлая по умолчанию', () => {
    const meta = document.createElement('meta')
    meta.name = 'theme-color'
    document.head.appendChild(meta)
    try {
      applyTheme('dark', 'blue')
      expect(metas()[0]!.getAttribute('content')).toBe('#12151c')
      applyTheme('light', 'blue')
      expect(metas()[0]!.getAttribute('content')).toBe('#f4f5f8')
      // auto без метки prefers-color-scheme считается светлым
      window.matchMedia = ((query: string) => ({ matches: false, media: query })) as unknown as typeof window.matchMedia
      applyTheme('auto', 'blue')
      expect(metas()[0]!.getAttribute('content')).toBe('#f4f5f8')
      window.matchMedia = ((query: string) => ({ matches: true, media: query })) as unknown as typeof window.matchMedia
      applyTheme('auto', 'blue')
      expect(metas()[0]!.getAttribute('content')).toBe('#12151c')
    } finally {
      meta.remove()
    }
  })
})