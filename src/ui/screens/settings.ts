// Настройки: сгруппированный список в стиле нативных клиентов, свитчи,
// опасные действия — с подтверждением словом. Всё, что есть в prefs/api,
// выведено в UI; push-тумблер честно называет локальные уведомления.
import { h, formatBytes } from '../dom.js'
import { icon, iconButton } from '../icons.js'
import { t } from '../../i18n/ru.js'
import type { AppHost } from '../host.js'
import { avatar } from '../components/avatar.js'
import { snackbar } from '../components/snackbar.js'
import { confirmModal, dangerConfirmModal, openModal, promptModal } from '../components/modal.js'
import { THEMES, ACCENTS, applyTheme } from '../theme.js'

export class SettingsScreen {
  readonly element: HTMLElement

  constructor(private readonly host: AppHost) {
    this.element = h('main', { class: 'screen settings-screen' })
  }

  render(): void {
    const prefs = this.host.ctx.prefs
    const messenger = this.host.ctx.messenger
    const login = messenger?.session.login ?? ''
    const body = h('div', { class: 'settings-body' })
    body.append(
      h(
        'div',
        { class: 'profile-card' },
        avatar(login, { size: 64 }),
        h('div', { class: 'profile-meta' }, h('div', { class: 'profile-login', text: `@${login}` }), h('div', { class: 'muted', text: this.host.ctx.storagePersisted ? t('storagePersisted') : t('storageNotPersisted') })),
        h('button', { class: 'btn small', text: t('bio'), onclick: () => void this.editBio() }),
      ),
    )

    body.append(
      this.section(t('settingsAppearance')),
      this.row(t('theme'), '', h('div', { class: 'segmented small' }, ...THEMES.map((theme) =>
        h('button', {
          class: `seg${prefs.theme === theme.id ? ' active' : ''}`,
          text: theme.label,
          onclick: async () => {
            await this.host.ctx.savePrefs({ theme: theme.id })
            applyTheme(this.host.ctx.prefs.theme, this.host.ctx.prefs.accent)
            this.render()
          },
        })))),
      this.row(t('accent'), '', h('div', { class: 'accent-row' }, ...ACCENTS.map((accent) =>
        h('button', {
          class: `accent-dot${prefs.accent === accent.id ? ' active' : ''}`,
          style: `--accent-swatch:${accent.color}`,
          'aria-label': accent.label,
          title: accent.label,
          onclick: async () => {
            await this.host.ctx.savePrefs({ accent: accent.id })
            applyTheme(this.host.ctx.prefs.theme, this.host.ctx.prefs.accent)
            this.render()
          },
        })))),
    )

    body.append(
      this.section(t('settingsNotifications')),
      this.switchRow(t('notificationsOn'), prefs.notifications, async (value) => {
        await this.host.ctx.savePrefs({ notifications: value })
        if (value && 'Notification' in window && Notification.permission === 'default') await Notification.requestPermission()
        this.render()
      }),
      this.switchRow(t('notificationSound'), prefs.notificationSound, async (value) => {
        await this.host.ctx.savePrefs({ notificationSound: value })
        this.render()
      }),
      this.switchRow(t('notificationText'), prefs.notificationText, async (value) => {
        await this.host.ctx.savePrefs({ notificationText: value })
        this.render()
      }, t('securityBrowserText')),
    )

    body.append(
      this.section(t('settingsPrivacy')),
      this.switchRow(t('readReceipts'), prefs.readReceipts, async (value) => {
        await this.host.ctx.savePrefs({ readReceipts: value })
        this.render()
      }),
      this.switchRow(t('typingIndicator'), prefs.typingIndicator, async (value) => {
        await this.host.ctx.savePrefs({ typingIndicator: value })
        this.render()
      }),
      this.switchRow(t('autoDownloadMedia'), prefs.autoDownloadMedia, async (value) => {
        await this.host.ctx.savePrefs({ autoDownloadMedia: value })
        this.render()
      }),
      this.switchRow(t('presenceHidden'), prefs.presenceHidden, async (value) => {
        await this.host.ctx.savePrefs({ presenceHidden: value })
        try {
          await this.host.ctx.api.setPresenceHidden(messenger!.session.token, value)
        } catch {
          snackbar('не удалось изменить приватность на сервере', { kind: 'error' })
        }
        this.render()
      }),
    )

    body.append(this.section(t('settingsCalls')), h('p', { class: 'hint', text: t('turnHint') }), this.turnEditor())

    body.append(
      this.section(t('settingsDevices')),
      this.row(t('settingsDevices'), '', h('button', { class: 'btn small', text: 'Открыть', onclick: () => void this.showDevices() })),
    )

    body.append(
      this.section(t('settingsSecurity')),
      this.row(t('changePassword'), '', h('button', { class: 'btn small', text: 'Изменить', onclick: () => void this.changePassword() })),
      this.row(t('cloudPasswordSetup'), '', h('button', { class: 'btn small', text: 'Настроить', onclick: () => void this.setCloudPassword() })),
      h('p', { class: 'hint', text: t('securityBrowserText') }),
    )

    body.append(
      this.section(t('settingsAccount')),
      this.row(t('logout'), '', h('button', { class: 'btn small', text: t('logout'), onclick: () => void this.logout() })),
    )

    body.append(
      this.section(t('settingsDanger')),
      h('button', { class: 'btn danger block', text: t('wipe'), onclick: () => void this.wipe() }),
    )

    const header = h(
      'header',
      { class: 'topbar' },
      iconButton('back', t('back'), () => this.host.showChats()),
      h('h1', { text: t('settingsTitle') }),
    )
    this.element.replaceChildren(header, body)
  }

  private section(title: string): HTMLElement {
    return h('h2', { class: 'settings-section', text: title })
  }

  private row(label: string, sub: string, control: HTMLElement): HTMLElement {
    return h('div', { class: 'setting-row' }, h('div', { class: 'setting-label' }, h('div', { text: label }), sub ? h('div', { class: 'muted', text: sub }) : null), control)
  }

  private switchRow(label: string, value: boolean, onChange: (value: boolean) => void, sub = ''): HTMLElement {
    const button = h('button', { class: `switch${value ? ' on' : ''}`, role: 'switch', 'aria-checked': String(value), 'aria-label': label })
    button.appendChild(h('span', { class: 'switch-knob' }))
    button.addEventListener('click', () => onChange(!value))
    return this.row(label, sub, button)
  }

  private turnEditor(): HTMLElement {
    // подгружаем текущие значения: повторное сохранение не должно их стирать
    const servers = this.host.ctx.prefs.iceServers
    const urls = h('input', { type: 'text', value: servers.map((server) => server.urls).join(', '), placeholder: 'turn:host:3478' })
    const user = h('input', { type: 'text', value: servers.find((server) => server.username)?.username ?? '', placeholder: t('turnUser') })
    const credential = h('input', { type: 'password', value: servers.find((server) => server.credential)?.credential ?? '', placeholder: t('turnPassword') })
    return h(
      'div',
      { class: 'form inset' },
      h('label', { class: 'field' }, urls, h('span', { class: 'field-label', text: t('turnUrls') })),
      h('label', { class: 'field' }, user, h('span', { class: 'field-label', text: t('turnUser') })),
      h('label', { class: 'field' }, credential, h('span', { class: 'field-label', text: t('turnPassword') })),
      h('button', {
        class: 'btn primary',
        text: t('save'),
        onclick: async () => {
          const list = urls.value.split(',').map((value) => value.trim()).filter(Boolean)
          await this.host.ctx.savePrefs({
            iceServers: list.length > 0
              ? list.map((value) => ({ urls: value, username: user.value || undefined, credential: credential.value || undefined }))
              : [{ urls: 'stun:stun.l.google.com:19302' }],
          })
          snackbar(t('turnSaved'), { kind: 'success' })
        },
      }),
    )
  }

  private async editBio(): Promise<void> {
    const value = await promptModal({ title: t('bio'), value: '', placeholder: 'до 70 символов', multiline: true, validate: (v) => (v.length > 70 ? 'не более 70 символов' : null) })
    if (value === null) return
    await this.host.ctx.messenger?.setBio(value)
    snackbar('профиль обновлён', { kind: 'success' })
    this.render()
  }

  private async showDevices(): Promise<void> {
    const messenger = this.host.ctx.messenger
    if (!messenger) return
    const content = h('div', { class: 'form' })
    const list = h('div', { class: 'device-list' })
    content.appendChild(list)
    try {
      const devices = await this.host.ctx.api.listDevices(messenger.session.token)
      for (const device of devices) {
        list.appendChild(
          h(
            'div',
            { class: 'setting-row' },
            h('div', { class: 'setting-label' }, h('div', { text: device.deviceId }), device.current ? h('div', { class: 'muted', text: t('thisDevice') }) : null),
            device.current ? null : h('button', {
              class: 'btn small danger',
              text: t('revokeDevice'),
              onclick: async () => {
                if (!(await confirmDevice(device.deviceId))) return
                await this.host.ctx.api.revokeDevice(messenger.session.token, device.deviceId)
                controller.close()
                snackbar('устройство отключено', { kind: 'success' })
              },
            }),
          ),
        )
      }
    } catch (error) {
      list.appendChild(h('p', { class: 'field-error', text: this.host.errorMessage(error) }))
    }
    content.appendChild(h('button', { class: 'btn', text: t('confirmNewDevice'), onclick: () => void this.offerNewDevice() }))
    const controller = openModal({ title: t('devicesTitle'), content })
  }

  // ПОДКЛЮЧЁННОЕ устройство сканирует QR нового: скан камерой либо
  // ручной ввод кода. Подтверждение — один вопрос «Разрешить?».
  private async offerNewDevice(): Promise<void> {
    const messenger = this.host.ctx.messenger
    if (!messenger) return
    const content = h('div', { class: 'form' })
    const scan = h('button', {
      class: 'btn primary block',
      text: t('linkScan'),
      onclick: () => {
        controller.close()
        void this.scanLinkCode()
      },
    })
    const manual = h('input', { type: 'text', placeholder: t('linkCodeEnter'), autocomplete: 'off' })
    const submit = h('button', {
      class: 'btn',
      text: t('linkJoin'),
      onclick: async () => {
        const offer = this.host.ctx.parseLinkOffer(manual.value)
        if (!offer) {
          snackbar('код привязки нераспознан', { kind: 'error' })
          return
        }
        controller.close()
        await this.confirmJoined(offer.nonce, offer.pubB64, offer.server)
      },
    })
    content.append(
      h('p', { class: 'muted', text: t('linkScanHint') }),
      scan,
      h('div', { class: 'field-label', text: t('linkEnterCode') }),
      manual,
      submit,
    )
    const controller = openModal({ title: t('confirmNewDevice'), content })
  }

  // Сканер камеры: нативный BarcodeDetector поверх превью getUserMedia.
  // Превью обязательно в DOM — иначе браузер не отдаёт кадры детектору,
  // а пользователь не видит, что камера включена.
  private async scanLinkCode(): Promise<void> {
    const Detector = (globalThis as {
      BarcodeDetector?: new (o: unknown) => { detect: (v: HTMLVideoElement) => Promise<Array<{ rawValue: string }>> }
    }).BarcodeDetector
    if (!Detector) {
      snackbar(t('linkNoScanner'), { kind: 'error' })
      return
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      snackbar(t('linkNoCamera'), { kind: 'error' })
      return
    }

    const overlay = h('div', { class: 'scanner-overlay' })
    const video = h('video', { class: 'scanner-video', playsinline: 'true', muted: 'true', autoplay: 'true' }) as HTMLVideoElement
    const frame = h('div', { class: 'scanner-frame' })
    const cancel = h('button', { class: 'btn scanner-cancel', text: t('cancel') })
    overlay.append(video, frame, cancel)
    document.body.appendChild(overlay)

    let stream: MediaStream | null = null
    const close = () => {
      stream?.getTracks().forEach((track) => track.stop())
      overlay.remove()
    }
    cancel.addEventListener('click', close)

    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      })
      video.srcObject = stream
      await video.play()
    } catch (err) {
      close()
      snackbar(this.host.errorMessage(err), { kind: 'error' })
      return
    }

    const detector = new Detector({ formats: ['qr_code'] })
    const deadline = Date.now() + 120_000
    try {
      while (Date.now() < deadline) {
        if (!document.body.contains(overlay)) return // отменено пользователем
        const found = await detector.detect(video)
        const raw = found[0]?.rawValue
        if (raw) {
          close()
          const offer = this.host.ctx.parseLinkOffer(raw)
          if (!offer) {
            snackbar('код привязки нераспознан', { kind: 'error' })
            return
          }
          await this.confirmJoined(offer.nonce, offer.pubB64, offer.server)
          return
        }
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
      close()
      snackbar(t('linkScanTimeout'), { kind: 'error' })
    } catch (err) {
      close()
      snackbar(this.host.errorMessage(err), { kind: 'error' })
    }
  }

  // подтверждение отпечатка нового ключа после скана
  private async confirmJoined(nonce: string, pubB64: string, server?: string): Promise<void> {
    const ok = await confirmModal({
      title: t('linkConfirmTitle'),
      message: t('linkConfirmText'),
      confirmLabel: t('linkAllow'),
    })
    if (!ok) return
    try {
      await this.host.ctx.linkConfirm(nonce, pubB64, server)
      snackbar('устройство привязано', { kind: 'success' })
      this.render()
    } catch (error) {
      snackbar(this.host.errorMessage(error), { kind: 'error' })
    }
  }

  private async changePassword(): Promise<void> {
    const current = await promptModal({ title: t('changePassword'), label: 'Текущий пароль', type: 'password' })
    if (current === null) return
    const next = await promptModal({ title: t('changePassword'), label: 'Новый пароль (мин. 6)', type: 'password', validate: (v) => (v.length < 6 ? 'минимум 6 символов' : null) })
    if (next === null) return
    try {
      await this.host.ctx.api.changePassword(this.host.ctx.messenger!.session.token, current, next)
      snackbar('пароль изменён', { kind: 'success' })
    } catch (error) {
      snackbar(this.host.errorMessage(error), { kind: 'error' })
    }
  }

  private async setCloudPassword(): Promise<void> {
    const current = await promptModal({ title: t('cloudPasswordSetup'), label: 'Текущий пароль', type: 'password' })
    if (current === null) return
    const cloud = await promptModal({ title: t('cloudPasswordSetup'), label: 'Облачный пароль (пусто — снять)', type: 'password' })
    if (cloud === null) return
    try {
      await this.host.ctx.api.setCloudPassword(this.host.ctx.messenger!.session.token, current, cloud)
      snackbar(cloud ? 'облачный пароль включён' : 'облачный пароль снят', { kind: 'success' })
    } catch (error) {
      snackbar(this.host.errorMessage(error), { kind: 'error' })
    }
  }

  private async logout(): Promise<void> {
    await this.host.ctx.logout()
    this.host.navigate({ name: 'login' })
  }

  private async wipe(): Promise<void> {
    const confirmed = await dangerConfirmModal({ title: t('wipe'), message: `${t('wipeConfirm')}\n\n${t('wipeWordPrompt')}`, word: t('wipeWord') })
    if (!confirmed) return
    await this.host.ctx.wipe()
    location.reload()
  }
}

async function confirmDevice(deviceId: string): Promise<boolean> {
  return new Promise((resolve) => {
    const controller = openModal({
      title: t('revokeConfirm'),
      content: h('p', { class: 'modal-text', text: `${t('revokeConfirm')}: ${deviceId}?` }),
      actions: [
        h('button', { class: 'btn', text: t('cancel'), onclick: () => { controller.close(); resolve(false) } }),
        h('button', { class: 'btn danger', text: t('revokeDevice'), onclick: () => { controller.close(); resolve(true) } }),
      ],
    })
  })
}

void formatBytes
void icon
