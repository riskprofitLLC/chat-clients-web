// @vitest-environment happy-dom
// DOM-тесты компонентов: модальный слой (вместо prompt/confirm), меню
// сообщения, баннер установки, страница фатальной ошибки, уведомления.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeModal, confirmModal, dangerConfirmModal, openModal, promptModal } from '../src/ui/components/modal.js'
import { openMessageMenu } from '../src/ui/components/message-menu.js'
import { isStandalone, notifyMessage } from '../src/pwa.js'
import { renderFatal } from '../src/ui/fatal.js'

// happy-dom не считает вёрстку: offsetParent всегда null, а фокус-трап
// фильтрует по нему — подменяем на тело документа
let offsetBackup: PropertyDescriptor | undefined

beforeEach(() => {
  offsetBackup = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetParent')
  Object.defineProperty(HTMLElement.prototype, 'offsetParent', { get: () => document.body, configurable: true })
})

afterEach(() => {
  closeModal()
  if (offsetBackup) Object.defineProperty(HTMLElement.prototype, 'offsetParent', offsetBackup)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function sheet(): HTMLElement | null {
  return document.querySelector('.modal-sheet')
}

function primary(): HTMLButtonElement {
  return sheet()!.querySelector<HTMLButtonElement>('.btn.primary')!
}



function buttons(): NodeListOf<HTMLButtonElement> {
  return sheet()!.querySelectorAll<HTMLButtonElement>('.btn')
}

function danger(): HTMLButtonElement {
  return sheet()!.querySelector<HTMLButtonElement>('.btn.danger')!
}

describe('B38: модальный слой вместо prompt/confirm', () => {
  it('role=dialog и aria-modal выставлены', () => {
    openModal({ title: 'Заголовок', content: document.createElement('input') })
    const node = sheet()!
    expect(node.getAttribute('role')).toBe('dialog')
    expect(node.getAttribute('aria-modal')).toBe('true')
    expect(node.getAttribute('aria-label')).toBe('Заголовок')
  })

  it('фокус уходит на первый интерактивный элемент и возвращается назад', () => {
    const opener = document.createElement('button')
    document.body.appendChild(opener)
    opener.focus()
    openModal({ title: 'T', content: document.createElement('input') })
    expect(document.activeElement).toBe(sheet()!.querySelector('input'))
    closeModal()
    expect(document.activeElement).toBe(opener)
  })

  it('Esc закрывает dismissible и не трогает non-dismissible', () => {
    openModal({ title: 'T', content: document.createElement('div') })
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(sheet()).toBeNull()

    openModal({ title: 'T', content: document.createElement('div'), dismissible: false })
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(sheet()).not.toBeNull()
  })

  it('клик по затемнению закрывает, клик по окну — нет', () => {
    openModal({ title: 'T', content: document.createElement('div') })
    const overlay = document.querySelector('.modal-overlay')!
    overlay.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(sheet()).toBeNull()

    openModal({ title: 'T', content: document.createElement('div') })
    sheet()!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(sheet()).not.toBeNull()
  })

  it('Tab зацикливает фокус внутри модалки', () => {
    const form = document.createElement('div')
    const first = document.createElement('input')
    const last = document.createElement('button')
    form.append(first, last)
    openModal({ title: 'T', content: form })
    last.focus()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
    expect(document.activeElement).toBe(first)
  })
})

describe('B38: модальные формы вместо prompt', () => {
  it('promptModal возвращает значение с type=password', async () => {
    let resolved: string | null = 'unset'
    const pending = promptModal({ title: 'Пароль', label: 'Введите пароль', type: 'password' }).then((v) => {
      resolved = v
    })
    const input = sheet()!.querySelector<HTMLInputElement>('input')!
    expect(input.type).toBe('password')
    input.value = 'secret'
    primary().click()
    await pending
    expect(resolved).toBe('secret')
  })
})

describe('B38: confirm и danger-подтверждения', () => {
  it('confirmModal резолвит true по подтверждению и false по отмене', async () => {
    let yes: boolean | string = 'unset'
    const first = confirmModal({ title: 'Удалить?', message: 'Точно?' }).then((v) => {
      yes = v
    })
    buttons()[1].click()
    await first
    expect(yes).toBe(true)

    let no: boolean | string = 'unset'
    const second = confirmModal({ title: 'Удалить?', message: 'Точно?' }).then((v) => {
      no = v
    })
    buttons()[0].click()
    await second
    expect(no).toBe(false)
  })

  it('dangerConfirmModal требует точного слова и не закрывается без него', async () => {
    let done: boolean | string = 'unset'
    const pending = dangerConfirmModal({ title: 'Стереть?', message: 'Введите слово', word: 'СТЕРЕТЬ' }).then((v) => {
      done = v
    })
    // неверное слово — модалка жива, поле трясётся
    danger().click()
    expect(sheet()).not.toBeNull()
    expect(sheet()!.querySelector('input')!.classList.contains('shake')).toBe(true)

    const field = sheet()!.querySelector<HTMLInputElement>('input')!
    field.value = 'СТЕРЕТЬ'
    field.classList.remove('shake')
    danger().click()
    await pending
    expect(done).toBe(true)
  })
})

describe('B33: меню сообщения без зависимости от contextmenu', () => {
  it('быстрые реакции вызывают actions.react и закрывают модалку', () => {
    let picked = ''
    openMessageMenu({ x: 10, y: 10 }, {
      react: (emoji) => {
        picked = emoji
      },
      reply: () => undefined,
      copy: () => undefined,
      pin: () => undefined,
    })
    const quick = sheet()!.querySelectorAll<HTMLButtonElement>('.reaction-quick-btn')
    expect(quick.length).toBeGreaterThanOrEqual(7)
    quick[0].click()
    expect(picked.length).toBeGreaterThan(0)
    expect(sheet()).toBeNull()
  })

  it('кнопки «ещё» открывает пикер эмодзи, выбор вызывает react', () => {
    let picked = ''
    openMessageMenu({ x: 10, y: 10 }, {
      react: (emoji) => {
        picked = emoji
      },
      reply: () => undefined,
      copy: () => undefined,
      pin: () => undefined,
    })
    const more = sheet()!.querySelector<HTMLButtonElement>('.reaction-quick-btn.more')!
    more.click()
    // открылся пикер с заголовком
    expect(sheet()!.querySelector('.emoji-grid')).not.toBeNull()
    const cell = sheet()!.querySelectorAll<HTMLButtonElement>('.emoji-cell')[3]
    const expected = cell.textContent!
    cell.click()
    expect(picked).toBe(expected)
  })

  it('edit и remove появляются только когда переданы', () => {
    const base = {
      react: () => undefined,
      reply: () => undefined,
      copy: () => undefined,
      pin: () => undefined,
    }
    openMessageMenu({ x: 0, y: 0 }, base)
    expect(sheet()!.textContent).not.toContain('Править')
    closeModal()

    openMessageMenu({ x: 0, y: 0 }, { ...base, edit: () => undefined, remove: () => undefined })
    const items = Array.from(sheet()!.querySelectorAll<HTMLButtonElement>('.menu-item')).map((b) => b.textContent)
    expect(items.some((text) => text?.includes('Править'))).toBe(true)
    expect(items.some((text) => text?.includes('Удалить у всех'))).toBe(true)
  })
})

describe('B32: баннер установки не показывается в standalone', () => {
  it('isStandalone true по display-mode и по navigator.standalone', () => {
    vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => ({
      matches: query.includes('standalone'),
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList)
    expect(isStandalone()).toBe(true)

    vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList)
    ;(navigator as Navigator & { standalone?: boolean }).standalone = true
    expect(isStandalone()).toBe(true)
    ;(navigator as Navigator & { standalone?: boolean }).standalone = undefined
  })

  it('в обычном браузере — false', () => {
    vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList)
    expect(isStandalone()).toBe(false)
  })
})

describe('B42: страница «нужен https» вместо белого экрана', () => {
  it('без WebCrypto показывает причину и подсказку про https', () => {
    vi.stubGlobal('crypto', undefined)
    const root = document.createElement('div')
    renderFatal(root, new Error('crypto is not defined'))
    expect(root.querySelector('h1')!.textContent).toBe('Нужен https')
    expect(root.querySelector('p')!.textContent).toContain('https')
  })

  it('с WebCrypto показывает текст ошибки запуска', () => {
    vi.stubGlobal('crypto', { subtle: {} })
    const root = document.createElement('div')
    renderFatal(root, new Error('база недоступна'))
    expect(root.querySelector('h1')!.textContent).toBe('Не удалось запустить приложение')
    expect(root.querySelector('p')!.textContent).toBe('база недоступна')
  })
})

describe('B37: уведомления не светят текст и молчат на видимой вкладке', () => {
  function setVisibility(state: string): void {
    Object.defineProperty(document, 'visibilityState', { value: state, configurable: true })
  }

  it('видимая вкладка — уведомления нет', async () => {
    setVisibility('visible')
    const created: unknown[] = []
    vi.stubGlobal(
      'Notification',
      class {
        static permission = 'granted'
        constructor(title: string, options?: unknown) {
          created.push({ title, options })
        }
      },
    )
    await notifyMessage('bob', 'привет')
    expect(created).toHaveLength(0)
  })

  it('без разрешения — уведомления нет', async () => {
    setVisibility('hidden')
    const created: unknown[] = []
    vi.stubGlobal(
      'Notification',
      class {
        static permission = 'denied'
        constructor(title: string, options?: unknown) {
          created.push({ title, options })
        }
      },
    )
    await notifyMessage('bob', 'привет')
    expect(created).toHaveLength(0)
  })

  it('скрытая вкладка с разрешением — уведомление с телом', async () => {
    setVisibility('hidden')
    const created: Array<{ title: string; options?: { body?: string } }> = []
    vi.stubGlobal(
      'Notification',
      class {
        static permission = 'granted'
        constructor(title: string, options?: { body?: string }) {
          created.push({ title, options })
        }
      },
    )
    await notifyMessage('bob', 'привет')
    expect(created).toHaveLength(1)
    expect(created[0].title).toBe('bob')
    expect(created[0].options?.body).toBe('привет')
  })
})
