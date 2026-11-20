// @vitest-environment happy-dom
// Иконки: inline-SVG без innerHTML — проверяем атрибуты, состав фигур
// и кнопку с обязательным aria-label.
import { describe, expect, it } from 'vitest'
import { icon, iconButton } from '../src/ui/icons.js'

describe('icon', () => {
  it('общие атрибуты SVG и размер по умолчанию', () => {
    const svg = icon('send')
    expect(svg.tagName.toLowerCase()).toBe('svg')
    expect(svg.getAttribute('viewBox')).toBe('0 0 24 24')
    expect(svg.getAttribute('width')).toBe('24')
    expect(svg.getAttribute('stroke-width')).toBe('1.75')
    expect(svg.getAttribute('aria-hidden')).toBe('true')
    expect(svg.hasAttribute('role')).toBe(false)
  })

  it('заданный размер и режим доступности с title', () => {
    const svg = icon('phone', { size: 30, title: 'Позвонить' })
    expect(svg.getAttribute('width')).toBe('30')
    expect(svg.getAttribute('height')).toBe('30')
    expect(svg.getAttribute('aria-hidden')).toBe('false')
    expect(svg.getAttribute('role')).toBe('img')
    expect(svg.querySelector('title')?.textContent).toBe('Позвонить')
  })

  it('.пути, круги и прямоугольники собираются своими узлами', () => {
    // search: круг + линия; image: прямоугольник со скруглением + круг + путь
    const search = icon('search')
    expect(search.querySelectorAll('circle')).toHaveLength(1)
    expect(search.querySelectorAll('path')).toHaveLength(1)
    const rect = icon('image').querySelectorAll('rect')[0]!
    expect(rect.getAttribute('rx')).toBe('2')
    // pause: два прямоугольника без скругления — rx не выводим
    for (const node of Array.from(icon('pause').querySelectorAll('rect'))) {
      expect(node.hasAttribute('rx')).toBe(false)
    }
  })

  it('.узлы только через createElementNS: текстовых детей нет', () => {
    const svg = icon('settings')
    for (const child of Array.from(svg.childNodes)) {
      expect(child.nodeType).not.toBe(3)
      expect((child as Element).tagName.toLowerCase()).not.toBe('#text')
    }
  })
})

describe('iconButton', () => {
  it('.aria-label, класс иконки и клик по кнопке', () => {
    let clicks = 0
    const button = iconButton('back', 'Назад', () => clicks++)
    expect(button.tagName.toLowerCase()).toBe('button')
    expect(button.type).toBe('button')
    expect(button.className).toBe('icon-btn')
    expect(button.getAttribute('aria-label')).toBe('Назад')
    expect(button.title).toBe('Назад')
    button.click()
    expect(clicks).toBe(1)
  })

  it('.дополнительный класс и размер иконки', () => {
    const button = iconButton('close', 'Закрыть', () => undefined, { size: 18, className: 'small' })
    expect(button.className).toBe('icon-btn small')
    expect(button.querySelector('svg')!.getAttribute('width')).toBe('18')
  })
})
