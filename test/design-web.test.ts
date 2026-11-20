// @vitest-environment happy-dom
// Оформление раунда 2 (W1-W7): бейдж непрочитанного и закреп в списке чатов,
// превью своего сообщения со статусом доставки, цитата/reply с акцентной полосой,
// анимация появления сообщения, ряды с иконками в тонированных кругах,
// пустые состояния.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { ChatsScreen } from '../src/ui/screens/chats.js'
import { SettingsScreen } from '../src/ui/screens/settings.js'
import { CallsScreen } from '../src/ui/screens/calls.js'
import { infoRow } from '../src/ui/screens/dialog.js'
import { COMPOSER_MAX_HEIGHT, composerBoxHeight } from '../src/ui/screens/dialog.js'
import { t } from '../src/i18n/ru.js'
import * as Env from '../src/protocol/envelope.js'
import { makeHost, summary } from './support.js'
// ─── CSS-помощники ────────────────────────────────────────────────────────

function css(file: string): string {
  return readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
}

function rule(text: string, selector: string): string {
  const start = text.indexOf(selector + ' {')
  expect(start, `правило ${selector} не найдено`).toBeGreaterThan(-1)
  return text.slice(start, text.indexOf('}', start))
}

const components = css('src/ui/styles/components.css')

afterEach(() => {
  vi.restoreAllMocks()
})

// ─── W1/W2/W3: строка списка чатов ────────────────────────────────────────

describe('W1-W3: строка списка чатов', () => {
  it('бейдж непрочитанного живёт справа в линии превью', () => {
    const host = makeHost([summary({ unread: 5 })])
    const screen = new ChatsScreen(host)
    screen.update()
    const line = screen.element.querySelector('.chat-line:nth-of-type(2)')!
    expect(line.querySelector('.chat-preview')).not.toBeNull()
    const badges = line.querySelector('.chat-badges')!
    expect(badges.querySelector('.badge')!.textContent).toBe('5')
    expect(badges.querySelector('.badge')!.classList.contains('hidden')).toBe(false)
  })

  it('muted-вариант бейджа — серый, акцентный — акцент проекта', () => {
    expect(rule(components, '.badge.muted')).toMatch(/background:\s*#BEC3C7/)
    expect(rule(css('src/ui/styles/base.css'), '.badge')).toMatch(/background:\s*var\(--accent\)/)
  })

  it('непрочитанное >99 показывает 99+', () => {
    const host = makeHost([summary({ unread: 140 })])
    const screen = new ChatsScreen(host)
    screen.update()
    expect(screen.element.querySelector('.badge')!.textContent).toBe('99+')
  })

  it('закреп показан иконкой у строки и скрыт у обычной', () => {
    const pinnedHost = makeHost([summary({ pinned: ['ref-1'] })])
    const pinnedScreen = new ChatsScreen(pinnedHost)
    pinnedScreen.update()
    const pin = pinnedScreen.element.querySelector('.chat-pin')!
    expect(pin.classList.contains('hidden')).toBe(false)
    expect(pin.querySelector('svg')).not.toBeNull()

    const plainHost = makeHost([summary({})])
    const plainScreen = new ChatsScreen(plainHost)
    plainScreen.update()
    expect(plainScreen.element.querySelector('.chat-pin')!.classList.contains('hidden')).toBe(true)
  })

  it('своё последнее сообщение: превью «Вы: …» и статус доставки перед временем', () => {
    const mine = { from: 'me', timestamp: 1_700_000_000_000, content: Env.escapeText('свой текст') }
    const host = makeHost([summary({ lastRecord: mine })])
    const screen = new ChatsScreen(host)
    screen.update()
    expect(screen.element.querySelector('.chat-preview')!.textContent).toBe('Вы: свой текст')
    const status = screen.element.querySelector('.chat-status')!
    expect(status.classList.contains('hidden')).toBe(false)
    expect(status.querySelector('svg')).not.toBeNull()
    // статус идёт перед временем в линии заголовка
    const line = screen.element.querySelector('.chat-line')!
    expect(line.children[0].className).toBe('chat-title')
    expect(line.children[1].className).toBe('chat-status')
    expect(line.children[2].className).toBe('chat-time')
  })

  it('чужое последнее сообщение: без «Вы:» и без статуса доставки', () => {
    const host = makeHost([summary({})])
    const screen = new ChatsScreen(host)
    screen.update()
    expect(screen.element.querySelector('.chat-preview')!.textContent).toBe('привет')
    expect(screen.element.querySelector('.chat-status')!.classList.contains('hidden')).toBe(true)
  })
})

// ─── W4: цитата/reply ─────────────────────────────────────────────────────

describe('W4: цитата/reply в пузыре и в баре ответа', () => {
  it('акцентная полоса слева и отступ', () => {
    const info = rule(components, '.reply-info')
    expect(info).toMatch(/border-left:\s*2px solid var\(--accent\)/)
    expect(info).toMatch(/padding-left:\s*var\(--sp-2\)/)
  })

  it('имя автора акцентом, текст одной строкой с ellipsis', () => {
    expect(rule(components, '.reply-info b')).toMatch(/color:\s*var\(--accent\)/)
    const text = rule(components, '.reply-info span')
    expect(text).toMatch(/text-overflow:\s*ellipsis/)
    expect(text).toMatch(/white-space:\s*nowrap/)
  })

  it('цитата внутри пузыря — та же акцентная полоса', () => {
    const quote = rule(components, '.bubble .quote')
    expect(quote).toMatch(/border-left:\s*\d+px solid var\(--accent\)/)
  })
})

// ─── W5: появление сообщения ──────────────────────────────────────────────

describe('W5: появление сообщения в диалоге', () => {
  it('fade + сдвиг 6px за один тик движения', () => {
    const message = rule(components, '.message')
    expect(message).toMatch(/animation:\s*msg-in var\(--t-base\) var\(--ease\)/)
    const frames = components.slice(components.indexOf('@keyframes msg-in'))
    expect(frames).toMatch(/opacity:\s*0/)
    expect(frames).toMatch(/translateY\(6px\)/)
  })
})

// ─── W6: ряды с иконками в тонированных кругах ────────────────────────────

describe('W6: ряды с иконками', () => {
  it('ведущая иконка — тонированный круг 40px', () => {
    const lead = rule(components, '.lead-icon')
    expect(lead).toMatch(/width:\s*40px/)
    expect(lead).toMatch(/height:\s*40px/)
    expect(lead).toMatch(/border-radius:\s*var\(--r-full\)/)
    expect(lead).toMatch(/background:\s*var\(--accent-soft\)/)
    expect(lead).toMatch(/color:\s*var\(--accent\)/)
  })

  it('единый ряд: заголовок + подзаголовок + шеврон', () => {
    const row = rule(components, '.info-row')
    expect(row).toMatch(/display:\s*flex/)
    expect(row).toMatch(/gap:\s*var\(--sp-3\)/)
    expect(rule(components, '.info-title')).toMatch(/color:\s*var\(--text\)/)
    expect(rule(components, '.info-sub')).toMatch(/color:\s*var\(--text-muted\)/)
    expect(rule(components, '.row-more')).toBeTruthy()
  })

  it('заголовок секции — мелкий серый, единый стиль', () => {
    for (const selector of ['.list-section', '.settings-section']) {
      const section = rule(components, selector)
      expect(section).toMatch(/font-size:\s*var\(--fs-xs\)/)
      expect(section).toMatch(/color:\s*var\(--text-muted\)/)
    }
  })

  it('настройки: у строк есть иконка в круге, у навигационных — шеврон', () => {
    const host = makeHost([])
    const screen = new SettingsScreen(host)
    screen.render()
    const rows = screen.element.querySelectorAll('.setting-row')
    expect(rows.length).toBeGreaterThan(5)
    // каждая строка настроек несёт ведущую иконку в тонированном круге
    for (const row of rows) {
      if (row.querySelector('.switch') || row.querySelector('.segmented') || row.querySelector('.accent-row')) continue
      expect(row.querySelector('.lead-icon'), 'ведущая иконка ряда').not.toBeNull()
    }
    // шеврон только у строк, открывающих другой экран/действие
    const chevrons = screen.element.querySelectorAll('.setting-row .row-more')
    expect(chevrons.length).toBeGreaterThanOrEqual(4)
  })

  it('звонки: ведущая иконка в тонированном круге', async () => {
    const host = makeHost([])
    ;(host.ctx as unknown as { messenger: unknown }).messenger = {
      callLog: async () => [{ peer: 'bob', at: 1_700_000_000_000, status: 'incoming', duration: 60 }],
    }
    const screen = new CallsScreen(host)
    await screen.render()
    const lead = screen.element.querySelector('.call-row .lead-icon')!
    expect(lead).not.toBeNull()
    expect(lead.querySelector('svg')).not.toBeNull()
  })

  it('«Информация о чате»: ряд с иконкой в тонированном круге', () => {
    const row = infoRow('shield', 'Код безопасности', 'сверьте коды')
    expect(row.className).toBe('info-row')
    expect(row.querySelector('.lead-icon')!.querySelector('svg')).not.toBeNull()
    expect(row.querySelector('.info-title')!.textContent).toBe('Код безопасности')
    expect(row.querySelector('.info-sub')!.textContent).toBe('сверьте коды')
  })
})

// ─── W7: пустые состояния ─────────────────────────────────────────────────

describe('W7: пустые состояния', () => {
  it('иконка в тонированном круге, а не одиночный смайл', () => {
    const icon = rule(components, '.empty-icon')
    expect(icon).toMatch(/width:\s*64px/)
    expect(icon).toMatch(/height:\s*64px/)
    expect(icon).toMatch(/border-radius:\s*var\(--r-full\)/)
    expect(icon).toMatch(/background:\s*var\(--accent-soft\)/)
    expect(icon).toMatch(/color:\s*var\(--accent\)/)
  })

  it('список чатов: круглая иконка-заглушка и текст', () => {
    const host = makeHost([])
    const screen = new ChatsScreen(host)
    screen.update()
    const empty = screen.element.querySelector('.empty-state')!
    expect(empty.classList.contains('hidden')).toBe(false)
    const icon = empty.querySelector('.empty-icon')!
    expect(icon.querySelector('svg')).not.toBeNull()
    expect(empty.querySelector('p')!.textContent).toBe(t('chatsEmpty'))
  })
})

// ─── регресс: геометрия поля композера ───────────────────────────────────

describe('регресс: поле ввода сообщения не даёт вертикальной прокрутки', () => {
  const chrome = 24 // padding 11+12 плюс рамка
  const line = 21.75

  it('одна строка целиком помещается в поле', () => {
    // высота обязана покрыть строку вместе с padding и рамкой (border-box)
    expect(composerBoxHeight(line, line, chrome)).toBeGreaterThanOrEqual(line + chrome)
    expect(composerBoxHeight(line, line, chrome)).toBeLessThanOrEqual(COMPOSER_MAX_HEIGHT)
  })

  it('пустое поле — одна строка, а не две', () => {
    expect(composerBoxHeight(0, line, chrome)).toBe(line + chrome)
  })

  it('поле растёт по содержимому до потолка', () => {
    expect(composerBoxHeight(100, line, chrome)).toBe(124)
    expect(composerBoxHeight(10_000, line, chrome)).toBe(COMPOSER_MAX_HEIGHT)
  })
})
