// @vitest-environment happy-dom
// Нижняя пилюля корневых разделов: состав табов и активный таб маршрута.
import { describe, expect, it } from 'vitest'
import { BOTTOM_TABS, activeTab } from '../src/ui/bottom-nav.js'
import type { Route } from '../src/ui/host.js'

function route(name: Route['name']): Route {
  if (name === 'dialog') return { name: 'dialog', chatId: 'bob' }
  return { name } as Route
}

describe('bottom-nav', () => {
  it('пилюля содержит четыре раздела в порядке Чаты/Контакты/Настройки/Профиль', () => {
    expect(BOTTOM_TABS.map((tab) => tab.name)).toEqual(['chats', 'contacts', 'settings', 'profile'])
  })

  it('у каждого таба есть подпись и иконка', () => {
    for (const tab of BOTTOM_TABS) {
      expect(tab.labelKey).toBeTruthy()
      expect(tab.icon).toBeTruthy()
    }
  })

  it('активный таб совпадает с корневым маршрутом', () => {
    expect(activeTab(route('chats'))).toBe('chats')
    expect(activeTab(route('contacts'))).toBe('contacts')
    expect(activeTab(route('settings'))).toBe('settings')
    expect(activeTab(route('profile'))).toBe('profile')
  })

  it('диалог, звонки и вход пилюлю не подсвечивают', () => {
    expect(activeTab(route('dialog'))).toBeNull()
    expect(activeTab(route('calls'))).toBeNull()
    expect(activeTab(route('login'))).toBeNull()
    expect(activeTab(undefined)).toBeNull()
  })
})