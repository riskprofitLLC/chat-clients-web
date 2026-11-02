// Минимальные DOM-хелперы: без фреймворка и без виртуального DOM.
// Всё, что можно посчитать чистой функцией, живёт в domain/ — здесь только
// построение узлов и подписки.
export type Child = Node | string | number | null | undefined | false

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, unknown> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue
    if (key === 'class') element.className = String(value)
    else if (key === 'text') element.textContent = String(value)
    // value/checked — только как свойства: setAttribute('value') на textarea
    // не меняет .value (дефолтное содержимое — текстовый узел), и любая
    // перерисовка молча стирала набранный текст
    else if (key === 'value' && (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement)) {
      element.value = String(value)
    } else if (key === 'checked' && element instanceof HTMLInputElement) {
      element.checked = value === true
    }
    else if (key === 'html') element.innerHTML = String(value)
    else if (key.startsWith('on') && typeof value === 'function') {
      element.addEventListener(key.slice(2).toLowerCase(), value as EventListener)
    } else if (key === 'dataset' && typeof value === 'object') {
      Object.assign(element.dataset, value as Record<string, string>)
    } else if (value === true) element.setAttribute(key, '')
    else element.setAttribute(key, String(value))
  }
  append(element, children)
  return element
}

export function append(parent: Node, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue
    parent.appendChild(typeof child === 'object' ? child : document.createTextNode(String(child)))
  }
}

export function clear(node: Node): void {
  while (node.firstChild) node.removeChild(node.firstChild)
}

export function mount(root: Element, ...children: Child[]): void {
  clear(root)
  append(root, children)
}

export function qs<T extends Element = HTMLElement>(selector: string, root: ParentNode = document): T | null {
  return root.querySelector<T>(selector)
}

// безопасный вывод пользовательского текста: только textContent, без innerHTML
export function textNode(value: string): Text {
  return document.createTextNode(value)
}

export function formatTime(ts: number): string {
  const date = new Date(ts)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

export function formatDate(ts: number): string {
  const date = new Date(ts)
  const today = new Date()
  const sameDay =
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate()
  if (sameDay) return formatTime(ts)
  const yesterday = new Date(today.getTime() - 86_400_000)
  const wasYesterday =
    date.getFullYear() === yesterday.getFullYear() &&
    date.getMonth() === yesterday.getMonth() &&
    date.getDate() === yesterday.getDate()
  if (wasYesterday) return 'вчера'
  return `${String(date.getDate()).padStart(2, '0')}.${String(date.getMonth() + 1).padStart(2, '0')}.${String(date.getFullYear()).slice(2)}`
}

export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

export function formatBytes(size: number): string {
  if (size < 1024) return `${size} Б`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} КБ`
  return `${(size / (1024 * 1024)).toFixed(1)} МБ`
}

export function plural(count: number, one: string, few: string, many: string): string {
  const mod10 = count % 10
  const mod100 = count % 100
  if (mod10 === 1 && mod100 !== 11) return one
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few
  return many
}

// подтверждение действия: свой диалог вместо window.confirm не нужен
export function confirmAction(message: string): boolean {
  return window.confirm(message)
}

export function toast(message: string, kind: 'info' | 'error' = 'info'): void {
  const container = document.getElementById('toasts') ?? document.body.appendChild(h('div', { id: 'toasts' }))
  const node = h('div', { class: `toast toast-${kind}`, text: message })
  container.appendChild(node)
  setTimeout(() => node.classList.add('toast-out'), 3_500)
  setTimeout(() => node.remove(), 4_200)
}
