// @vitest-environment happy-dom
// DOM-тесты фич паритета волны A: экран блокировки PIN (P-W5),
// блок-лист отправителей (P-W4) и экран «Хранилище» (P-W1).
import { afterEach, describe, expect, it } from 'vitest'
import { MemoryKv } from '../src/store/kv.js'
import { PrefsStore } from '../src/store/prefs.js'
import { PinLock } from '../src/store/pin.js'
import { BlockedSendersStore } from '../src/store/blocked.js'
import { MediaCache } from '../src/store/chat-state.js'
import { AppLock } from '../src/ui/screens/lock.js'
import { BlockedScreen } from '../src/ui/screens/blocked.js'
import { StorageScreen } from '../src/ui/screens/storage.js'
import { DEFAULT_PREFS } from '../src/store/prefs.js'
import type { AppHost } from '../src/ui/host.js'

// минимальный хост: экранам нужны только ctx-сторы и навигация
function makeHost(kv: MemoryKv, extra: Record<string, unknown> = {}): AppHost {
  const host = {
    ctx: {
      kv,
      prefs: { ...DEFAULT_PREFS },
      pinLock: new PinLock(new PrefsStore(kv)),
      blocked: new BlockedSendersStore(kv),
      media: new MediaCache(kv),
      ...extra,
    },
    state: {},
    navigate: () => undefined,
    showSettings: () => undefined,
    showChats: () => undefined,
    toast: () => undefined,
  }
  return host as unknown as AppHost
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('экран блокировки PIN (P-W5)', () => {
  it('неверный код показывает ошибку, верный снимает заглушку', async () => {
    const kv = new MemoryKv()
    const host = makeHost(kv)
    await host.ctx.pinLock.setPin('123456')
    let unlocked = 0
    const lock = new AppLock(host, () => {
      unlocked++
    })
    await lock.present()
    const input = document.querySelector<HTMLInputElement>('.app-lock-input')!
    const submit = document.querySelector<HTMLButtonElement>('.app-lock .btn')!
    // кнопка выключена, пока введено меньше шести цифр
    expect(submit.disabled).toBe(true)
    input.value = '111111'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    expect(submit.disabled).toBe(false)
    submit.click()
    await new Promise((resolve) => setTimeout(resolve, 800))
    expect(document.querySelector('.app-lock-error')!.classList.contains('hidden')).toBe(false)
    expect(input.value).toBe('')
    expect(unlocked).toBe(0)
    input.value = '123456'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    submit.click()
    await new Promise((resolve) => setTimeout(resolve, 800))
    expect(unlocked).toBe(1)
    expect(document.querySelector('.app-lock')).toBeNull()
  })

  it('нецифровой ввод отбрасывается', async () => {
    const kv = new MemoryKv()
    const host = makeHost(kv)
    await host.ctx.pinLock.setPin('123456')
    const lock = new AppLock(host, () => undefined)
    await lock.present()
    const input = document.querySelector<HTMLInputElement>('.app-lock-input')!
    input.value = '12ab34'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    expect(input.value).toBe('1234')
  })
})

describe('блок-лист отправителей (P-W4)', () => {
  it('список показывает заблокированных и разблокирует в один тап', async () => {
    const kv = new MemoryKv()
    const host = makeHost(kv)
    await host.ctx.blocked.block('spammer')
    await host.ctx.blocked.block('bob')
    const screen = new BlockedScreen(host)
    document.body.appendChild(screen.element)
    await screen.render()
    expect(screen.element.textContent).toContain('@spammer')
    expect(screen.element.querySelectorAll('.setting-row').length).toBe(2)
    const rows = [...screen.element.querySelectorAll<HTMLElement>('.setting-row')]
    const spammerRow = rows.find((row) => row.textContent!.includes('@spammer'))!
    spammerRow.querySelector<HTMLButtonElement>('.btn')!.click()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(await host.ctx.blocked.all()).toEqual(['bob'])
    expect(screen.element.querySelectorAll('.setting-row').length).toBe(1)
  })

  it('пустой список показывает заглушку', async () => {
    const host = makeHost(new MemoryKv())
    const screen = new BlockedScreen(host)
    document.body.appendChild(screen.element)
    await screen.render()
    expect(screen.element.querySelector('.empty-state')!.classList.contains('hidden')).toBe(false)
  })
})

describe('экран «Хранилище» (P-W1)', () => {
  it('показывает ненулевые размеры после скачивания медиа и очищает кэш', async () => {
    const kv = new MemoryKv()
    const host = makeHost(kv)
    await host.ctx.media.put('id1', new Uint8Array(4096))
    const screen = new StorageScreen(host)
    document.body.appendChild(screen.element)
    await screen.render()
    // карточки категорий + итог
    expect(screen.element.querySelectorAll('.storage-card').length).toBe(4)
    expect(screen.element.textContent).toContain('4.0 КБ')
    expect(screen.element.textContent).toContain('Медиа')
    // подтверждение очистки — модалка; соглашаемся и проверяем результат
    const clearButton = screen.element.querySelector<HTMLButtonElement>('.settings-body .btn.block')!
    clearButton.click()
    await new Promise((resolve) => setTimeout(resolve, 20))
    const confirm = document.querySelectorAll<HTMLButtonElement>('.modal-actions .btn')
    // последняя кнопка в модалке — подтверждение («Очистить»)
    confirm[confirm.length - 1].click()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(await host.ctx.media.has('id1')).toBe(false)
    await screen.render()
    expect(screen.element.textContent).toContain('0 Б')
  })
})
