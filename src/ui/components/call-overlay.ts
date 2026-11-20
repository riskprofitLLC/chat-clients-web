// Полноэкранный экран звонка: размытый градиент, пульсирующие кольца,
// крупные круглые кнопки, индикатор качества и понятная ошибка про TURN.
import { h, formatDuration } from '../dom.js'
import { icon } from '../icons.js'
import { t } from '../../i18n/ru.js'
import type { CallView } from '../../calls/manager.js'
import type { AppHost } from '../host.js'
import { avatar } from './avatar.js'

export class CallOverlay {
  readonly element: HTMLElement
  private avatarSlot = h('div', { class: 'call-avatar' })
  private title = h('div', { class: 'call-title' })
  private status = h('div', { class: 'call-status' })
  private quality = h('div', { class: 'call-quality hidden' })
  private error = h('div', { class: 'call-error hidden' })
  private controls = h('div', { class: 'call-controls' })

  constructor(private readonly host: AppHost) {
    this.element = h(
      'div',
      { class: 'call-overlay', role: 'dialog', 'aria-modal': 'true' },
      h('div', { class: 'call-bg' }),
      h('div', { class: 'call-card' }, this.avatarSlot, this.title, this.status, this.quality, this.error, this.controls),
    )
  }

  update(view: CallView | null): void {
    if (!view || view.state.phase === 'idle') {
      this.element.classList.add('hidden')
      return
    }
    this.element.classList.remove('hidden')
    const peer = view.state.peer ?? ''
    if (this.avatarSlot.dataset.seed !== peer) {
      this.avatarSlot.dataset.seed = peer
      this.avatarSlot.replaceChildren(h('span', { class: 'pulse-ring' }), h('span', { class: 'pulse-ring delay' }), avatar(peer, { size: 120 }))
    }
    this.title.textContent = peer
    this.status.textContent = this.statusText(view)
    this.paintQuality(view)
    this.error.classList.toggle('hidden', !view.error)
    if (view.error) this.error.textContent = view.error
    this.paintControls(view)
  }

  // точечное обновление таймера: экран не перерисовывается целиком
  tick(view: CallView | null): void {
    if (view?.state.phase === 'active') this.status.textContent = formatDuration(this.host.ctx.calls?.duration() ?? 0)
  }

  private statusText(view: CallView): string {
    switch (view.state.phase) {
      case 'outgoing':
        return t('callOutgoing')
      case 'ringing':
        return t('callIncoming')
      case 'active':
        return formatDuration(this.host.ctx.calls?.duration() ?? 0)
      default:
        return t('callEnded')
    }
  }

  private paintQuality(view: CallView): void {
    const state = view.connection
    const known = state !== 'new'
    this.quality.classList.toggle('hidden', !known)
    if (!known) return
    const good = state === 'connected'
    this.quality.textContent = `${t('callQuality')}: ${good ? 'хорошее' : state === 'connecting' ? 'подключение…' : 'нестабильное'}`
    this.quality.classList.toggle('bad', !good && state !== 'connecting')
  }

  private paintControls(view: CallView): void {
    const calls = this.host.ctx.calls
    if (!calls) return
    const buttons: HTMLElement[] = []
    if (view.state.phase === 'ringing') {
      buttons.push(roundButton('phone', t('callAccept'), 'accept', () => void calls.accept()))
      buttons.push(roundButton('close', t('callDecline'), 'decline', () => void calls.decline()))
    } else if (view.state.phase === 'outgoing' || view.state.phase === 'active') {
      buttons.push(roundButton(view.muted ? 'micOff' : 'mic', view.muted ? t('callUnmute') : t('callMute'), view.muted ? 'active' : '', () => calls.toggleMute()))
      buttons.push(roundButton('close', t('callHangup'), 'decline', () => void calls.hangup()))
    } else {
      buttons.push(roundButton('close', t('close'), '', () => calls.dismiss()))
    }
    this.controls.replaceChildren(...buttons)
  }
}

function roundButton(name: Parameters<typeof icon>[0], label: string, variant: string, onClick: () => void): HTMLElement {
  const button = h('button', { class: `call-btn ${variant}`, 'aria-label': label, title: label }, icon(name, { size: 28 }))
  button.addEventListener('click', onClick)
  return button
}
