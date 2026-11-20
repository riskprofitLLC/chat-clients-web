// @vitest-environment happy-dom
// Дизайн-раунд 3: плоская нижняя навигация с бейджем, ripple строк,
// зелёное время исходящего пузыря, поля поиска/композера, шеврон вправо,
// профиль единым стилем рядов.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { ProfileScreen } from '../src/ui/screens/profile.js'
import { SettingsScreen } from '../src/ui/screens/settings.js'
import { makeHost } from './support.js'

function css(file: string): string {
  return readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
}

function rule(text: string, selector: string): string {
  const start = text.indexOf(selector + ' {')
  expect(start, 'правило ' + selector + ' не найдено').toBeGreaterThan(-1)
  return text.slice(start, text.indexOf('}', start))
}

const components = css('src/ui/styles/components.css')
const tokens = css('src/ui/styles/tokens.css')

describe('D1: нижняя навигация плоская', () => {
  it('панель без плашки: hairline сверху, без скругления и тени', () => {
    const nav = rule(components, '.bottom-nav')
    expect(nav).toMatch(/border-top:\s*1px solid var\(--border\)/)
    expect(nav).not.toMatch(/border-radius/)
    expect(nav).not.toMatch(/box-shadow/)
    expect(nav).not.toMatch(/surface-3/)
  })

  it('неактивный пункт — серый #79817E, активный — акцент без подложки', () => {
    expect(rule(components, '.bottom-nav-item')).toMatch(/color:\s*#79817E/)
    const active = rule(components, '.bottom-nav-item.active')
    expect(active).toMatch(/color:\s*var\(--accent\)/)
    expect(active).not.toMatch(/background/)
  })

  it('бейдж непрочитанного у таба «Чатов» позиционируется у иконки', () => {
    const badge = rule(components, '.bottom-nav-badge')
    expect(badge).toMatch(/position:\s*absolute/)
    expect(badge).toMatch(/min-width:\s*16px/)
    expect(rule(components, '.bottom-nav-icon')).toMatch(/position:\s*relative/)
  })
})

describe('D2: время в исходящем пузыре', () => {
  it('светлая тема — зелёный key_chat_outTimeText', () => {
    expect(rule(components, '.message.mine .meta-time')).toMatch(/color:\s*#70B15C/)
  })

  it('тёмная тема остаётся серой у обоих механизмов', () => {
    const dark = components.slice(components.indexOf('.message.mine .meta-time'))
    expect(dark).toMatch(/:root:not\(\[data-theme='light'\]\) \.message\.mine \.meta-time \{ color:\s*#93A3B1;/)
    expect(dark).toMatch(/:root\[data-theme='dark'\] \.message\.mine \.meta-time \{ color:\s*#93A3B1;/)
  })
})

describe('D3: ripple нажатия строки', () => {
  it('нажатие даёт чёрные 6% поверх фона', () => {
    expect(rule(components, '.chat-row:active')).toMatch(/background:\s*color-mix\(in srgb, #000000 6%, transparent\)/)
  })
})

describe('D4/D5: поля поиска и композера', () => {
  it('поле поиска — скруглённое серое поле с подсказкой', () => {
    const search = rule(components, '.search')
    expect(search).toMatch(/background:\s*var\(--field-bg\)/)
    expect(search).toMatch(/border-radius:\s*var\(--r-full\)/)
    const placeholder = components.slice(components.indexOf('.search::placeholder'))
    expect(placeholder.slice(0, placeholder.indexOf('}'))).toMatch(/color:\s*var\(--field-hint\)/)
  })

  it('композер — поле токеном темы и подсказка того же тона', () => {
    const input = rule(components, '.composer-input')
    expect(input).toMatch(/background:\s*var\(--field-bg\)/)
    const placeholder = components.slice(components.indexOf('.composer-input::placeholder'))
    expect(placeholder.slice(0, placeholder.indexOf('}'))).toMatch(/color:\s*var\(--field-hint\)/)
  })

  it('токены полей разведены по темам', () => {
    const light = tokens.slice(tokens.indexOf(':root {'))
    expect(light.slice(0, light.indexOf('\n}'))).toMatch(/--field-bg:\s*#F2F4F5/)
    const darkMedia = tokens.slice(tokens.indexOf(":root:not([data-theme='light'])"))
    expect(darkMedia.slice(0, darkMedia.indexOf('\n}'))).toMatch(/--field-bg:\s*#17212B/)
  })
})

describe('D6: шеврон рядов настроек смотрит вправо', () => {
  it('значок повёрнут на -90deg', () => {
    const host = makeHost([])
    const screen = new SettingsScreen(host)
    screen.render()
    const chevrons = screen.element.querySelectorAll<SVGSVGElement>('.setting-row .row-more svg')
    expect(chevrons.length).toBeGreaterThanOrEqual(4)
    for (const svg of chevrons) {
      expect(svg.style.transform).toBe('rotate(-90deg)')
    }
  })
})

describe('D7: профиль единым стилем', () => {
  it('шапка с заголовком и единые ряды с иконками в кругах', async () => {
    const host = makeHost([])
    ;(host.ctx as unknown as { messenger: unknown }).messenger = { session: { login: 'me', deviceId: 'dev-1' } }
    ;(host.ctx as unknown as { profiles: unknown }).profiles = { get: async () => ({ bio: 'о себе' }) }
    const screen = new ProfileScreen(host)
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
    const header = screen.element.querySelector('.topbar')!
    expect(header.querySelector('h1')!.textContent).toBe('Профиль')
    const rows = screen.element.querySelectorAll('.setting-row')
    expect(rows.length).toBe(1)
    expect(rows[0].querySelector('.lead-icon svg')).not.toBeNull()
    expect(screen.element.querySelector('.settings-section')!.textContent).toBe('Устройства')
  })
})
