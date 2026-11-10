// Темы и акценты: data-theme/data-accent на <html>, значения — CSS-переменные.
import { t } from '../i18n/ru.js'

export type ThemeId = 'auto' | 'light' | 'dark'

export const THEMES: Array<{ id: ThemeId; label: string }> = [
  { id: 'auto', label: t('themeAuto') },
  { id: 'light', label: t('themeLight') },
  { id: 'dark', label: t('themeDark') },
]

export interface Accent {
  id: string
  label: string
  // базовый цвет; тёмный вариант и «текст на акценте» считаются в CSS
  color: string
}

export const ACCENTS: Accent[] = [
  { id: 'blue', label: 'Синий', color: '#2f6df6' },
  { id: 'teal', label: 'Бирюзовый', color: '#0f9b8e' },
  { id: 'violet', label: 'Фиолетовый', color: '#7c4dff' },
  { id: 'rose', label: 'Розовый', color: '#e0447c' },
  { id: 'amber', label: 'Янтарный', color: '#c47f10' },
  { id: 'green', label: 'Зелёный', color: '#2f9e44' },
]

export function applyTheme(theme: ThemeId, accent: string): void {
  const root = document.documentElement
  if (theme === 'auto') root.removeAttribute('data-theme')
  else root.dataset.theme = theme
  root.dataset.accent = ACCENTS.some((entry) => entry.id === accent) ? accent : 'blue'
  updateThemeColor(theme)
}

function updateThemeColor(theme: ThemeId): void {
  const dark = theme === 'dark' || (theme === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  const color = dark ? '#12151c' : '#f4f5f8'
  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) meta.setAttribute('content', color)
}
