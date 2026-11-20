// Аватар: детерминированный градиент по логину + инициалы, иконка группы,
// поддержка загруженной картинки. Без внешних ресурсов.
import { avatarGradient, h } from '../dom.js'
import { icon } from '../icons.js'

export interface AvatarOptions {
  size?: number
  isGroup?: boolean
  src?: string
  title?: string
}

export function avatar(seed: string, options: AvatarOptions = {}): HTMLElement {
  const size = options.size ?? 48
  const node = h('span', {
    class: `avatar${options.isGroup ? ' avatar-group' : ''}`,
    style: `--avatar-size:${size}px`,
    title: options.title ?? seed,
  })
  if (options.src) {
    node.appendChild(h('img', { src: options.src, alt: '', loading: 'lazy' }))
    return node
  }
  if (options.isGroup) {
    node.appendChild(icon('users', { size: Math.round(size * 0.5) }))
    return node
  }
  const gradient = avatarGradient(seed)
  node.style.setProperty('--avatar-from', gradient.from)
  node.style.setProperty('--avatar-to', gradient.to)
  node.appendChild(h('span', { class: 'avatar-initials', text: gradient.initials }))
  return node
}
