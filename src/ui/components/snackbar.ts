// Snackbar со стеком и действием (Отменить/Повторить) вместо мгновенных тостов.
import { h } from '../dom.js'

export interface SnackbarAction {
  label: string
  onClick: () => void
}

let container: HTMLElement | null = null

function ensureContainer(): HTMLElement {
  if (container && container.isConnected) return container
  container = document.getElementById('snackbars') as HTMLElement | null
  if (!container) {
    container = h('div', { id: 'snackbars', class: 'snackbar-stack', role: 'status', 'aria-live': 'polite' })
    document.body.appendChild(container)
  }
  return container
}

export function snackbar(
  message: string,
  options: { kind?: 'info' | 'error' | 'success'; action?: SnackbarAction; timeoutMs?: number } = {},
): void {
  const kind = options.kind ?? 'info'
  const node = h('div', { class: `snackbar snackbar-${kind}` })
  node.appendChild(h('span', { class: 'snackbar-text', text: message }))
  if (options.action) {
    node.appendChild(
      h('button', {
        class: 'snackbar-action',
        text: options.action.label,
        onclick: () => {
          options.action?.onClick()
          dismiss()
        },
      }),
    )
  }
  const stack = ensureContainer()
  stack.appendChild(node)
  requestAnimationFrame(() => node.classList.add('snackbar-in'))
  // timeoutMs 0 — постоянное сообщение (до действия пользователя)
  const timeout = options.timeoutMs ?? (options.action ? 6_000 : 3_500)
  const timer = timeout > 0 ? setTimeout(dismiss, timeout) : null
  function dismiss(): void {
    if (timer) clearTimeout(timer)
    node.classList.remove('snackbar-in')
    setTimeout(() => node.remove(), 220)
  }
}

export function toast(message: string, kind: 'info' | 'error' = 'info'): void {
  snackbar(message, { kind })
}
