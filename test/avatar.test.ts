// @vitest-environment happy-dom
// Аватар: градиент по логину, инициалы, группа и загруженная картинка.
import { describe, expect, it } from 'vitest'
import { avatar } from '../src/ui/components/avatar.js'

describe('avatar', () => {
  it('.обычный аватар: размер, градиент и инициалы из логина', () => {
    const node = avatar('bob')
    expect(node.className).toBe('avatar')
    expect(node.style.getPropertyValue('--avatar-size')).toBe('48px')
    const from = node.style.getPropertyValue('--avatar-from')
    expect(from).toMatch(/^hsl\(\d+ 62% 48%\)$/)
    // два разных логина дают разный оттенок — градиент детерминирован по seed
    expect(avatar('alice').style.getPropertyValue('--avatar-from')).not.toBe(from)
    expect(node.querySelector('.avatar-initials')?.textContent).toBe('B')
    // логин из двух частей даёт две инициалы
    expect(avatar('bob_smith').querySelector('.avatar-initials')?.textContent).toBe('BS')
  })

  it('.заданный размер и подсказка', () => {
    const node = avatar('bob', { size: 64, title: 'Боб' })
    expect(node.style.getPropertyValue('--avatar-size')).toBe('64px')
    expect(node.title).toBe('Боб')
  })

  it('.группа: класс и иконка вместо инициалов', () => {
    const node = avatar('room', { isGroup: true })
    expect(node.className).toBe('avatar avatar-group')
    expect(node.querySelector('.avatar-initials')).toBeNull()
    // размер иконки — половина аватара
    expect(node.querySelector('svg')!.getAttribute('width')).toBe('24')
  })

  it('.картинка профиля: img вместо градиента', () => {
    const node = avatar('bob', { src: 'blob:ava' })
    const img = node.querySelector('img')!
    expect(img.getAttribute('src')).toBe('blob:ava')
    expect(img.getAttribute('loading')).toBe('lazy')
    // градиент и инициалы не нужны, когда есть картинка
    expect(node.querySelector('.avatar-initials')).toBeNull()
    expect(node.style.getPropertyValue('--avatar-from')).toBe('')
  })
})
