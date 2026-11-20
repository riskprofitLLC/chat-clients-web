// Блок-лист отправителей (P-W4): список локально заблокированных логинов
// и разблокировка в один тап. Состояние — BlockedSendersStore в Kv,
// поэтому экран самодостаточен и не зависит от мессенджера.
import { h, keyedList } from '../dom.js'
import { icon, iconButton } from '../icons.js'
import { t } from '../../i18n/ru.js'
import type { AppHost } from '../host.js'
import { snackbar } from '../components/snackbar.js'

export class BlockedScreen {
  readonly element: HTMLElement
  private readonly list: HTMLElement
  private readonly empty: HTMLElement
  private logins: string[] = []

  constructor(private readonly host: AppHost) {
    this.list = h('div', { class: 'chat-list', role: 'list' })
    this.empty = h(
      'div',
      { class: 'empty-state' },
      h('span', { class: 'empty-icon' }, icon('shield', { size: 30 })),
      h('p', { text: t('blockedEmpty') }),
    )
    const header = h(
      'header',
      { class: 'topbar' },
      iconButton('back', t('back'), () => this.host.showSettings()),
      h('h1', { text: t('blockedTitle') }),
    )
    const body = h('div', { class: 'settings-body' }, h('p', { class: 'hint', text: t('blockedHint') }), this.list, this.empty)
    this.element = h('main', { class: 'screen blocked-screen' }, header, body)
  }

  async render(): Promise<void> {
    this.logins = await this.host.ctx.blocked.all()
    this.update()
  }

  update(): void {
    this.empty.classList.toggle('hidden', this.logins.length > 0)
    keyedList(
      this.list,
      this.logins,
      (login) => login,
      (login) =>
        h(
          'div',
          { class: 'setting-row' },
          h('span', { class: 'lead-icon' }, icon('shield', { size: 20 })),
          h('div', { class: 'setting-label' }, h('div', { text: `@${login}` })),
          h('button', {
            class: 'btn small',
            text: t('blockedUnblock'),
            onclick: () => void this.unblock(login),
          }),
        ),
    )
  }

  private async unblock(login: string): Promise<void> {
    await this.host.ctx.blocked.unblock(login)
    snackbar(t('blockedUnblocked'))
    await this.render()
  }
}