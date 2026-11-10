// Минимальные DOM-хелперы: без фреймворка и без виртуального DOM.
// Всё, что можно посчитать чистой функцией, живёт в domain/ — здесь только
// построение узлов и keyed-обновление списков.
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
    // не меняет .value и стирал бы набранный текст
    else if (key === 'value' && (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement)) {
      element.value = String(value)
    } else if (key === 'checked' && element instanceof HTMLInputElement) {
      element.checked = value === true
    } else if (key.startsWith('on') && typeof value === 'function') {
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

// keyed-обновление: существующие узлы переиспользуются, порядок восстанавливается
// минимальными перемещениями. Возвращает map «ключ → узел» для точечных правок.
export function keyedList<T>(
  container: HTMLElement,
  items: readonly T[],
  keyOf: (item: T) => string,
  create: (item: T) => HTMLElement,
  update?: (node: HTMLElement, item: T) => void,
): Map<string, HTMLElement> {
  const existing = new Map<string, HTMLElement>()
  for (const node of Array.from(container.children)) {
    const key = (node as HTMLElement).dataset.key
    if (key) existing.set(key, node as HTMLElement)
  }
  const used = new Map<string, HTMLElement>()
  let cursor: ChildNode | null = container.firstChild
  for (const item of items) {
    const key = keyOf(item)
    let node = existing.get(key)
    if (!node) {
      node = create(item)
      node.dataset.key = key
    }
    update?.(node, item)
    used.set(key, node)
    if (cursor === node) {
      cursor = node.nextSibling
    } else {
      container.insertBefore(node, cursor)
    }
  }
  // лишние узлы (сообщения удалены/отфильтрованы) убираем
  for (const [key, node] of existing) {
    if (!used.has(key)) node.remove()
  }
  return used
}

export function formatTime(ts: number): string {
  const date = new Date(ts)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

// «Сегодня»/«Вчера» + время для разделителей и списка чатов
export function formatDay(ts: number): string {
  const date = new Date(ts)
  const today = new Date()
  if (sameDay(date, today)) return 'Сегодня'
  const yesterday = new Date(today.getTime() - 86_400_000)
  if (sameDay(date, yesterday)) return 'Вчера'
  return `${String(date.getDate()).padStart(2, '0')}.${String(date.getMonth() + 1).padStart(2, '0')}.${date.getFullYear()}`
}

export function formatDate(ts: number): string {
  const date = new Date(ts)
  const today = new Date()
  if (sameDay(date, today)) return formatTime(ts)
  const yesterday = new Date(today.getTime() - 86_400_000)
  if (sameDay(date, yesterday)) return 'вчера'
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

// детерминированный градиент аватара по логину: одинаковый у всех устройств
export function avatarGradient(seed: string): { from: string; to: string; initials: string } {
  let hash = 0
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0
  const hue = hash % 360
  const initials = seed
    .replace(/^@/, '')
    .split(/[\s_-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('')
  return {
    from: `hsl(${hue} 62% 48%)`,
    to: `hsl(${(hue + 40) % 360} 62% 38%)`,
    initials: initials || seed.slice(0, 1).toUpperCase(),
  }
}
