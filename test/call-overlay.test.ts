// @vitest-environment happy-dom
// Оверлей звонка: скрытие в покое, статусы фаз, индикатор качества
// и состав кнопок (ответ/отклонение, микрофон/завершение, закрыть).
import { describe, expect, it } from 'vitest'
import { CallOverlay } from '../src/ui/components/call-overlay.js'
import type { CallView } from '../src/calls/manager.js'
import type { CallState } from '../src/domain/callmachine.js'
import type { AppHost } from '../src/ui/host.js'

interface FakeCalls {
  readonly counts: { accept: number; decline: number; hangup: number; dismiss: number; toggleMute: number }
  accept(): Promise<void>
  decline(): Promise<void>
  hangup(): Promise<void>
  dismiss(): void
  toggleMute(): void
  duration(): number
}

function fakeCalls(duration = 0): FakeCalls {
  const counts = { accept: 0, decline: 0, hangup: 0, dismiss: 0, toggleMute: 0 }
  return {
    counts,
    accept: async () => void counts.accept++,
    decline: async () => void counts.decline++,
    hangup: async () => void counts.hangup++,
    dismiss: () => void counts.dismiss++,
    toggleMute: () => void counts.toggleMute++,
    duration: () => duration,
  }
}

function state(over: Partial<CallState>): CallState {
  return { phase: 'idle', callId: null, peer: null, side: null, startedAt: 0, ...over }
}

function view(over: Partial<CallView>): CallView {
  return { state: state({}), muted: false, speaker: false, connection: 'new', error: null, startedAt: 0, ...over }
}

function makeHost(calls: FakeCalls | null): AppHost {
  return { ctx: { calls } } as unknown as AppHost
}

function overlay(calls: FakeCalls | null): CallOverlay {
  return new CallOverlay(makeHost(calls))
}

function status(node: HTMLElement): string {
  return node.querySelector('.call-status')!.textContent!
}

describe('CallOverlay.update', () => {
  it('.нет звонка или idle — оверлей скрыт', () => {
    const ui = overlay(null)
    ui.update(null)
    expect(ui.element.classList.contains('hidden')).toBe(true)
    ui.update(view({ state: state({ phase: 'idle' }) }))
    expect(ui.element.classList.contains('hidden')).toBe(true)
  })

  it('.исходящий вызов: заголовок, статус и кнопки микрофона/завершения', () => {
    const calls = fakeCalls()
    const ui = overlay(calls)
    ui.update(view({ state: state({ phase: 'outgoing', peer: 'bob', callId: 'c1', side: 'outgoing' }) }))
    expect(ui.element.classList.contains('hidden')).toBe(false)
    expect(ui.element.querySelector('.call-title')!.textContent).toBe('bob')
    expect(status(ui.element)).toBe('вызов…')
    // аватар пира подставляется один раз на звонок
    expect(ui.element.querySelector('.call-avatar .avatar-initials')!.textContent).toBe('B')
    const buttons = Array.from(ui.element.querySelectorAll<HTMLButtonElement>('.call-btn'))
    expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual(['Микрофон', 'Завершить'])
    buttons[0]!.click()
    buttons[1]!.click()
    expect([calls.counts.toggleMute, calls.counts.hangup]).toEqual([1, 1])
  })
})

describe('CallOverlay фазы и качество', () => {
  it('.входящий: ответ и отклонение, статус «входящий звонок»', () => {
    const calls = fakeCalls()
    const ui = overlay(calls)
    ui.update(view({ state: state({ phase: 'ringing', peer: 'bob', callId: 'c1', side: 'incoming' }) }))
    expect(status(ui.element)).toBe('входящий звонок')
    const buttons = Array.from(ui.element.querySelectorAll<HTMLButtonElement>('.call-btn'))
    expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual(['Ответить', 'Отклонить'])
    buttons[0]!.click()
    buttons[1]!.click()
    expect([calls.counts.accept, calls.counts.decline]).toEqual([1, 1])
  })

  it('.активный звонок: таймер из calls.duration', () => {
    const calls = fakeCalls(75)
    const ui = overlay(calls)
    ui.update(view({ state: state({ phase: 'active', peer: 'bob', callId: 'c1', side: 'outgoing', startedAt: 1 }) }))
    expect(status(ui.element)).toBe('1:15')
    // точечное обновление таймера без перерисовки экрана
    ui.tick(view({ state: state({ phase: 'active' }) }))
    expect(status(ui.element)).toBe('1:15')
  })

  it('.завершённый звонок: кнопка «Закрыть» и статус «завершён»', () => {
    const calls = fakeCalls()
    const ui = overlay(calls)
    ui.update(view({ state: state({ phase: 'ended', peer: 'bob' }) }))
    expect(status(ui.element)).toBe('завершён')
    const buttons = Array.from(ui.element.querySelectorAll<HTMLButtonElement>('.call-btn'))
    expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual(['Закрыть'])
    buttons[0]!.click()
    expect(calls.counts.dismiss).toBe(1)
  })
})

describe('CallOverlay индикатор качества и ошибки', () => {
  it('.new — индикатор скрыт, connected — «хорошее»', () => {
    const ui = overlay(fakeCalls())
    ui.update(view({ state: state({ phase: 'active' }), connection: 'new' }))
    expect(ui.element.querySelector('.call-quality')!.classList.contains('hidden')).toBe(true)
    ui.update(view({ state: state({ phase: 'active' }), connection: 'connected' }))
    const quality = ui.element.querySelector('.call-quality')!
    expect(quality.classList.contains('hidden')).toBe(false)
    expect(quality.textContent).toContain('хорошее')
    expect(quality.classList.contains('bad')).toBe(false)
  })

  it('.connecting — «подключение…», прочие — «нестабильное» с классом bad', () => {
    const ui = overlay(fakeCalls())
    ui.update(view({ state: state({ phase: 'active' }), connection: 'connecting' }))
    let quality = ui.element.querySelector('.call-quality')!
    expect(quality.textContent).toContain('подключение…')
    expect(quality.classList.contains('bad')).toBe(false)
    ui.update(view({ state: state({ phase: 'active' }), connection: 'disconnected' }))
    quality = ui.element.querySelector('.call-quality')!
    expect(quality.textContent).toContain('нестабильное')
    expect(quality.classList.contains('bad')).toBe(true)
  })

  it('.ошибка TURN показывается и скрывается вместе с ней', () => {
    const ui = overlay(fakeCalls())
    const error = ui.element.querySelector('.call-error')!
    expect(error.classList.contains('hidden')).toBe(true)
    ui.update(view({ state: state({ phase: 'active' }), error: 'нужен TURN' }))
    expect(error.classList.contains('hidden')).toBe(false)
    expect(error.textContent).toBe('нужен TURN')
    ui.update(view({ state: state({ phase: 'active' }), error: null }))
    expect(error.classList.contains('hidden')).toBe(true)
  })
})
