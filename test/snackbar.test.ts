// @vitest-environment happy-dom
// Стек всплывающих сообщений: виды, действие с закрытием и постоянное
// сообщение (timeoutMs 0) без таймера.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { snackbar, toast } from '../src/ui/components/snackbar.js'

function stack(): HTMLElement {
  return document.getElementById('snackbars')!
}

function nodes(): HTMLElement[] {
  return Array.from(stack().querySelectorAll<HTMLElement>('.snackbar'))
}

afterEach(() => {
  for (const node of nodes()) node.remove()
  stack().remove()
  vi.useRealTimers()
})

describe('snackbar', () => {
  it('.контейнер создаётся в body с ролью статуса', () => {
    expect(document.getElementById('snackbars')).toBeNull()
    snackbar('привет')
    const container = stack()
    expect(container.getAttribute('role')).toBe('status')
    expect(container.getAttribute('aria-live')).toBe('polite')
    expect(container.parentElement).toBe(document.body)
  })

  it('.вид по умолчанию info и явный error/success', () => {
    snackbar('раз')
    snackbar('два', { kind: 'error' })
    snackbar('три', { kind: 'success' })
    const list = nodes()
    expect(list.map((node) => node.className)).toEqual(['snackbar snackbar-info', 'snackbar snackbar-error', 'snackbar snackbar-success'])
    expect(list.map((node) => node.querySelector('.snackbar-text')!.textContent)).toEqual(['раз', 'два', 'три'])
  })

  it('.сообщение с действием: клик выполняет его и закрывает стек', () => {
    let done = 0
    snackbar('не отправлено', { action: { label: 'Повторить', onClick: () => done++ } })
    const button = nodes()[0]!.querySelector<HTMLButtonElement>('.snackbar-action')!
    expect(button.textContent).toBe('Повторить')
    button.click()
    expect(done).toBe(1)
    // dismiss снимает класс появления и убирает узел через 220 мс
    expect(nodes()[0]!.classList.contains('snackbar-in')).toBe(false)
  })

  it('.постоянное сообщение без таймера, обычное — с таймером', () => {
    vi.useFakeTimers()
    snackbar('обновление', { timeoutMs: 0 })
    expect(nodes()[0]!.classList.contains('snackbar-in')).toBe(false)
    vi.advanceTimersByTime(60_000)
    // таймера нет — узел на месте
    expect(nodes()).toHaveLength(1)

    snackbar('исчезнет')
    expect(nodes()).toHaveLength(2)
    vi.advanceTimersByTime(3_500)
    // dismiss снял класс, узел уберётся ещё через 220 мс
    expect(nodes()[1]!.classList.contains('snackbar-in')).toBe(false)
    vi.advanceTimersByTime(220)
    expect(nodes()).toHaveLength(1)
  })
})

describe('toast', () => {
  it('.короткий помощник даёт info-сообщение', () => {
    toast('готово')
    expect(nodes()[0]!.className).toBe('snackbar snackbar-info')
  })
})
