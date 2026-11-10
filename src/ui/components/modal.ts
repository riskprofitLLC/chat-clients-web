// Единый модальный компонент: bottom-sheet на мобильном, центральный диалог
// на десктопе (различие — в CSS). role=dialog, aria-modal, фокус-трап,
// возврат фокуса, закрытие по Esc/клику вне. Заменяет window.prompt/confirm.
import { h, mount } from '../dom.js'
import { t } from '../../i18n/ru.js'

export interface ModalOptions {
  title?: string
  content: HTMLElement
  actions?: HTMLElement[]
  // true — без затемнения и без клика-закрытия (для форм)
  dismissible?: boolean
}

let active: { close: () => void } | null = null

export function openModal(options: ModalOptions): { close: () => void; element: HTMLElement } {
  closeModal()
  const previousFocus = document.activeElement as HTMLElement | null
  const dismissible = options.dismissible !== false

  const sheet = h('div', {
    class: 'modal-sheet',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': options.title ?? t('appName'),
  })
  if (options.title) sheet.appendChild(h('h2', { class: 'modal-title', text: options.title }))
  sheet.appendChild(options.content)
  if (options.actions && options.actions.length > 0) {
    sheet.appendChild(h('div', { class: 'modal-actions' }, ...options.actions))
  }

  const overlay = h('div', {
    class: 'modal-overlay',
    onclick: (event: Event) => {
      if (dismissible && event.target === overlay) close()
    },
  })
  overlay.appendChild(sheet)

  const onKeydown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && dismissible) {
      event.preventDefault()
      close()
    }
    if (event.key === 'Tab') trapFocus(event, sheet)
  }

  const close = (): void => {
    if (active?.close !== close) return
    active = null
    document.removeEventListener('keydown', onKeydown, true)
    overlay.remove()
    previousFocus?.focus?.()
  }

  active = { close }
  document.addEventListener('keydown', onKeydown, true)
  document.body.appendChild(overlay)
  // фокус — на первый интерактивный элемент
  const focusable = sheet.querySelector<HTMLElement>(
    'input:not([type=hidden]), textarea, select, button, [href], [tabindex]:not([tabindex="-1"])',
  )
  focusable?.focus()
  return { close, element: sheet }
}

export function closeModal(): void {
  active?.close()
}

function trapFocus(event: KeyboardEvent, container: HTMLElement): void {
  const focusable = Array.from(
    container.querySelectorAll<HTMLElement>(
      'input:not([type=hidden]):not([disabled]), textarea:not([disabled]), select:not([disabled]), button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((node) => node.offsetParent !== null)
  if (focusable.length === 0) return
  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

// замена window.prompt: одна строка ввода с валидацией
export function promptModal(options: {
  title: string
  label?: string
  type?: 'text' | 'password' | 'email' | 'number'
  value?: string
  placeholder?: string
  multiline?: boolean
  validate?: (value: string) => string | null
  confirmLabel?: string
}): Promise<string | null> {
  return new Promise((resolve) => {
    const field = options.multiline
      ? h('textarea', { rows: 3, placeholder: options.placeholder ?? '', value: options.value ?? '' })
      : h('input', {
          type: options.type ?? 'text',
          placeholder: options.placeholder ?? '',
          value: options.value ?? '',
          autocomplete: options.type === 'password' ? 'current-password' : 'off',
        })
    const error = h('p', { class: 'field-error hidden' })
    const submit = h('button', {
      class: 'btn primary',
      text: options.confirmLabel ?? t('save'),
      onclick: () => {
        const value = field.value
        const message = options.validate?.(value)
        if (message) {
          error.textContent = message
          error.classList.remove('hidden')
          field.focus()
          return
        }
        controller.close()
        resolve(value)
      },
    })
    field.addEventListener('keydown', (event) => {
      if ((event as KeyboardEvent).key === 'Enter' && !options.multiline) {
        event.preventDefault()
        submit.click()
      }
    })
    const controller = openModal({
      title: options.title,
      content: h('div', { class: 'form' }, options.label ? h('label', { class: 'field-label', text: options.label }) : null, field, error),
      actions: [h('button', { class: 'btn', text: t('cancel'), onclick: () => { controller.close(); resolve(null) } }), submit],
    })
  })
}

export function confirmModal(options: { title: string; message: string; confirmLabel?: string; danger?: boolean }): Promise<boolean> {
  return new Promise((resolve) => {
    const controller = openModal({
      title: options.title,
      content: h('p', { class: 'modal-text', text: options.message }),
      actions: [
        h('button', { class: 'btn', text: t('cancel'), onclick: () => { controller.close(); resolve(false) } }),
        h('button', {
          class: options.danger ? 'btn danger' : 'btn primary',
          text: options.confirmLabel ?? t('delete'),
          onclick: () => { controller.close(); resolve(true) },
        }),
      ],
    })
  })
}

// подтверждение опасного действия вводом слова
export function dangerConfirmModal(options: { title: string; message: string; word: string; confirmLabel?: string }): Promise<boolean> {
  return new Promise((resolve) => {
    const field = h('input', { type: 'text', autocomplete: 'off', placeholder: options.word })
    const controller = openModal({
      title: options.title,
      content: h('div', { class: 'form' }, h('p', { class: 'modal-text', text: options.message }), field),
      actions: [
        h('button', { class: 'btn', text: t('cancel'), onclick: () => { controller.close(); resolve(false) } }),
        h('button', {
          class: 'btn danger',
          text: options.confirmLabel ?? t('delete'),
          onclick: () => {
            if (field.value.trim() !== options.word) {
              field.classList.add('shake')
              setTimeout(() => field.classList.remove('shake'), 400)
              return
            }
            controller.close()
            resolve(true)
          },
        }),
      ],
    })
  })
}

void mount
