// Профиль (таб нижней панели): аватар, логин, «о себе», устройство —
// единый стиль рядов с настройками (§2).
import { h } from '../dom.js'
import { icon, iconButton } from '../icons.js'
import { t } from '../../i18n/ru.js'
import type { AppHost } from '../host.js'
import { avatar } from '../components/avatar.js'
import { bioError } from '../../domain/profile-bio.js'
import { snackbar } from '../components/snackbar.js'
import { promptModal } from '../components/modal.js'

export class ProfileScreen {
  readonly element: HTMLElement
  // тело переиспользуется между render(): шапка не пересобирается
  private readonly body: HTMLElement

  constructor(private readonly host: AppHost) {
    this.body = h('div', { class: 'settings-body' })
    this.element = h('main', { class: 'screen profile-screen' }, this.header(), this.body)
    void this.render()
  }

  private header(): HTMLElement {
    return h(
      'header',
      { class: 'topbar' },
      iconButton('back', t('back'), () => this.host.showChats()),
      h('h1', { text: t('profileTitle') }),
    )
  }

  private async render(): Promise<void> {
    const messenger = this.host.ctx.messenger
    const login = messenger?.session.login ?? ''
    const bio = login ? (await this.host.ctx.profiles.get(login))?.bio ?? '' : ''
    this.body.replaceChildren(
      h(
        'div',
        { class: 'profile-card' },
        avatar(login, { size: 64 }),
        h(
          'div',
          { class: 'profile-meta' },
          h('div', { class: 'profile-login', text: `@${login}` }),
          bio ? h('div', { class: 'muted', text: bio }) : null,
        ),
        h('button', { class: 'btn small', text: t('bio'), onclick: () => void this.editBio() }),
      ),
      // секция устройства — единый ряд «иконка в круге + заголовок + значение»
      h('h2', { class: 'settings-section', text: t('settingsDevices') }),
      h(
        'div',
        { class: 'setting-row' },
        h('span', { class: 'lead-icon' }, icon('phone', { size: 20 })),
        h(
          'div',
          { class: 'setting-label' },
          h('div', { text: t('settingsDevices') }),
          h('div', { class: 'muted', text: messenger?.session.deviceId ?? '' }),
        ),
      ),
    )
  }

  private async editBio(): Promise<void> {
    const value = await promptModal({ title: t('bio'), value: '', placeholder: 'до 70 символов', multiline: true, validate: bioError })
    if (value === null) return
    await this.host.ctx.messenger?.setBio(value)
    snackbar('профиль обновлён', { kind: 'success' })
    await this.render()
  }
}
