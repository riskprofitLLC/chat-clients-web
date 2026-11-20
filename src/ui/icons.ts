// Единый набор иконок: свои inline-SVG, без эмодзи и внешних файлов.
// 24×24, stroke 1.75, round caps — как в современных нативных клиентах.
// Строим через createElementNS: никакого innerHTML и inline-скриптов.
const NS = 'http://www.w3.org/2000/svg'

// d — путь; circle/rect задаются отдельными полями, чтобы не парсить SVG-строку
type IconDef = {
  paths?: string[]
  circles?: Array<[number, number, number]>
  rects?: Array<[number, number, number, number, number?]>
}

const ICONS: Record<string, IconDef> = {
  settings: {
    circles: [[12, 12, 3]],
    paths: [
      'M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
    ],
  },
  phone: {
    paths: [
      'M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z',
    ],
  },
  search: { circles: [[11, 11, 7]], paths: ['M21 21l-4.3-4.3'] },
  more: { circles: [[5, 12, 1]], paths: ['M12 12h.01', 'M19 12h.01'] },
  attach: { paths: ['M21.4 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.2-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48'] },
  image: { rects: [[3, 3, 18, 18, 2]], circles: [[8.5, 8.5, 1.5]], paths: ['M21 15l-5-5L5 21'] },
  mic: { rects: [[9, 2, 6, 11, 3]], paths: ['M19 10v2a7 7 0 0 1-14 0v-2', 'M12 19v3'] },
  send: { paths: ['M22 2L11 13', 'M22 2l-7 20-4-9-9-4 20-7z'] },
  close: { paths: ['M18 6L6 18', 'M6 6l12 12'] },
  back: { paths: ['M15 18l-6-6 6-6'] },
  chevronDown: { paths: ['M6 9l6 6 6-6'] },
  plus: { paths: ['M12 5v14', 'M5 12h14'] },
  check: { paths: ['M20 6L9 17l-5-5'] },
  checks: { paths: ['M18 6L7 17l-3-3', 'M22 10l-7 7'] },
  clock: { circles: [[12, 12, 9]], paths: ['M12 7v5l3 2'] },
  pin: { paths: ['M12 17v5', 'M9 10.8V4h6v6.8l2 3.2H7l2-3.2z'] },
  reply: { paths: ['M9 17l-6-6 6-6', 'M3 11h11a6 6 0 0 1 6 6v1'] },
  edit: { paths: ['M12 20h9', 'M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z'] },
  trash: { paths: ['M3 6h18', 'M8 6V4h8v2', 'M19 6l-1 14H6L5 6', 'M10 11v6', 'M14 11v6'] },
  copy: { rects: [[9, 9, 12, 12, 2]], paths: ['M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1'] },
  emoji: { circles: [[12, 12, 9]], paths: ['M8 14s1.5 2 4 2 4-2 4-2', 'M9 9h.01', 'M15 9h.01'] },
  poll: { paths: ['M8 21V10', 'M12 21V4', 'M16 21v-7'] },
  location: { paths: ['M12 21s7-6.2 7-11a7 7 0 1 0-14 0c0 4.8 7 11 7 11z'], circles: [[12, 10, 2.5]] },
  contact: { paths: ['M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2'], circles: [[12, 7, 4]] },
  file: { paths: ['M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z', 'M14 2v6h6'] },
  play: { paths: ['M6 4l14 8-14 8V4z'] },
  pause: { rects: [[6, 4, 4, 16], [14, 4, 4, 16]] },
  download: { paths: ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'M7 10l5 5 5-5', 'M12 15V3'] },
  users: { paths: ['M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2'], circles: [[9, 7, 4]], },
  lock: { rects: [[5, 11, 14, 10, 2]], paths: ['M8 11V7a4 4 0 0 1 8 0v4'] },
  shield: { paths: ['M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z'] },
  bell: { paths: ['M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9', 'M13.7 21a2 2 0 0 1-3.4 0'] },
  eyeOff: { paths: ['M17.9 17.9A10 10 0 0 1 12 20C5 20 1 12 1 12a18 18 0 0 1 5.1-5.9', 'M9.9 4.2A9.6 9.6 0 0 1 12 4c7 0 11 8 11 8a18 18 0 0 1-2.2 3.2', 'M1 1l22 22', 'M9.9 9.9a3 3 0 0 0 4.2 4.2'] },
  alert: { paths: ['M12 9v4', 'M12 17h.01'], circles: [[12, 12, 9]] },
  star: { paths: ['M12 2l3.1 6.3 6.9 1-5 4.9 1.2 6.8-6.2-3.3-6.2 3.3L7 14.2l-5-4.9 6.9-1z'] },
  speaker: { paths: ['M11 5L6 9H2v6h4l5 4V5z', 'M15.5 8.5a5 5 0 0 1 0 7', 'M19 5a10 10 0 0 1 0 14'] },
  micOff: { paths: ['M1 1l22 22', 'M9 9v3a3 3 0 0 0 5.1 2.1', 'M15 9.3V5a3 3 0 0 0-5.9-.7', 'M17 16.9A7 7 0 0 1 5 12v-2', 'M19 10v2a7 7 0 0 1-.3 2', 'M12 19v3'] },
  info: { circles: [[12, 12, 9]], paths: ['M12 16v-4', 'M12 8h.01'] },
  moon: { paths: ['M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z'] },
  sun: { circles: [[12, 12, 4]], paths: ['M12 2v2', 'M12 20v2', 'M4.9 4.9l1.4 1.4', 'M17.7 17.7l1.4 1.4', 'M2 12h2', 'M20 12h2', 'M4.9 19.1l1.4-1.4', 'M17.7 6.3l1.4-1.4'] },
  user: { paths: ['M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2'], circles: [[12, 7, 4]] },
  logout: { paths: ['M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4', 'M16 17l5-5-5-5', 'M21 12H9'] },
  key: { circles: [[7.5, 15.5, 4.5]], paths: ['M10.7 12.3L21 2', 'M17 6l3 3', 'M14 9l2 2'] },
  link: { paths: ['M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1', 'M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1'] },
  eye: { paths: ['M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z'], circles: [[12, 12, 3]] },
  forward: { paths: ['M15 17l6-6-6-6', 'M21 11H9a6 6 0 0 0-6 6v1'] },
  smile: { circles: [[12, 12, 9]], paths: ['M8 14s1.5 2 4 2 4-2 4-2', 'M9 9h.01', 'M15 9h.01'] },
  stop: { rects: [[6, 6, 12, 12, 2]] },
  folder: { paths: ['M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'] },
}

export type IconName = keyof typeof ICONS

// Создаёт SVG-иконку; title используется как aria-label
export function icon(name: IconName, options: { size?: number; title?: string } = {}): SVGSVGElement {
  const def = ICONS[name]
  const size = options.size ?? 24
  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('width', String(size))
  svg.setAttribute('height', String(size))
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '1.75')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', options.title ? 'false' : 'true')
  if (options.title) {
    svg.setAttribute('role', 'img')
    const title = document.createElementNS(NS, 'title')
    title.textContent = options.title
    svg.appendChild(title)
  }
  for (const path of def.paths ?? []) {
    const node = document.createElementNS(NS, 'path')
    node.setAttribute('d', path)
    svg.appendChild(node)
  }
  for (const [cx, cy, r] of def.circles ?? []) {
    const node = document.createElementNS(NS, 'circle')
    node.setAttribute('cx', String(cx))
    node.setAttribute('cy', String(cy))
    node.setAttribute('r', String(r))
    svg.appendChild(node)
  }
  for (const [x, y, w, h, rx] of def.rects ?? []) {
    const node = document.createElementNS(NS, 'rect')
    node.setAttribute('x', String(x))
    node.setAttribute('y', String(y))
    node.setAttribute('width', String(w))
    node.setAttribute('height', String(h))
    if (rx !== undefined) node.setAttribute('rx', String(rx))
    svg.appendChild(node)
  }
  return svg
}

// иконка-кнопка с обязательным aria-label и областью нажатия ≥44×44
export function iconButton(
  name: IconName,
  label: string,
  onClick: (event: MouseEvent) => void,
  options: { size?: number; className?: string } = {},
): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = options.className ? `icon-btn ${options.className}` : 'icon-btn'
  button.setAttribute('aria-label', label)
  button.title = label
  button.appendChild(icon(name, { size: options.size ?? 22 }))
  button.addEventListener('click', onClick)
  return button
}
