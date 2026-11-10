// Экран входа: карточка на мягком градиенте, три режима (вход, регистрация,
// привязка нового устройства). Ошибки — у полей, а не в тостах.
import { h } from '../dom.js'
import { icon } from '../icons.js'
import { t } from '../../i18n/ru.js'
import { isCloudPasswordRequired } from '../../net/api.js'
import { validEmail, validLogin, validPassword } from '../../protocol/validators.js'
import type { AppHost } from '../host.js'
import { snackbar } from '../components/snackbar.js'
import { qrMatrix } from '../../util/qr.js'

type Tab = 'login' | 'register' | 'link'

export class LoginScreen {
  private tab: Tab = 'login'
  private linkState: { code: string; nonce: string; pollSecret: string } | null = null
  private linkTimer: ReturnType<typeof setTimeout> | null = null
  private busy = false
  readonly element: HTMLElement

  constructor(private readonly host: AppHost) {
    this.element = h('main', { class: 'login-wrap' })
  }

  dispose(): void {
    if (this.linkTimer) clearTimeout(this.linkTimer)
    this.linkTimer = null
  }

  render(): void {
    const card = h('div', { class: 'login-card' })
    card.appendChild(h('div', { class: 'brand' }, h('span', { class: 'brand-mark' }, icon('send', { size: 26 })), h('h1', { text: t('appName') })))
    card.appendChild(h('p', { class: 'muted', text: t('appTagline') }))
    card.appendChild(this.tabs())
    card.appendChild(this.tab === 'login' ? this.loginForm() : this.tab === 'register' ? this.registerForm() : this.linkForm())
    card.appendChild(this.securityBlock())
    this.element.replaceChildren(card)
  }

  private tabs(): HTMLElement {
    const make = (tab: Tab, label: string): HTMLElement =>
      h('button', {
        class: `seg${this.tab === tab ? ' active' : ''}`,
        text: label,
        onclick: () => {
          this.tab = tab
          this.linkState = null
          if (this.linkTimer) clearTimeout(this.linkTimer)
          this.linkTimer = null
          this.render()
        },
      })
    return h('div', { class: 'segmented' }, make('login', t('tabLogin')), make('register', t('tabRegister')), make('link', t('tabLink')))
  }

  private loginForm(): HTMLElement {
    const identifier = this.field(t('loginIdentifier'), { type: 'text', autocomplete: 'username' })
    const password = this.field(t('loginPassword'), { type: 'password', autocomplete: 'current-password', toggle: true })
    const cloud = this.field(t('cloudPassword'), { type: 'password', toggle: true })
    cloud.wrapper.classList.add('hidden')
    const error = this.fieldError()
    const submit = h('button', { class: 'btn primary block', text: t('loginSubmit') })
    submit.addEventListener('click', async () => {
      if (this.busy) return
      error.clear()
      if (!identifier.input.value.trim()) return error.show('введите логин или email')
      this.busy = true
      submit.textContent = t('loginBusy')
      submit.disabled = true
      try {
        await this.host.ctx.login(identifier.input.value, password.input.value, cloud.input.value)
        this.host.toast('вы вошли', 'success')
        this.host.navigate({ name: 'chats' })
      } catch (err) {
        if (isCloudPasswordRequired(err)) {
          cloud.wrapper.classList.remove('hidden')
          cloud.input.focus()
          error.show('включён облачный пароль — введите его')
        } else {
          error.show(this.host.errorMessage(err))
        }
      } finally {
        this.busy = false
        submit.textContent = t('loginSubmit')
        submit.disabled = false
      }
    })
    return h('div', { class: 'form' }, identifier.wrapper, password.wrapper, cloud.wrapper, error.node, submit, h('p', { class: 'hint', text: t('loginHint') }))
  }

  private registerForm(): HTMLElement {
    const email = this.field(t('registerEmail'), { type: 'email', autocomplete: 'email' })
    const code = this.codeField()
    const password = this.field(t('registerPassword'), { type: 'password', autocomplete: 'new-password', toggle: true })
    const strength = h('div', { class: 'strength' }, h('span'), h('span'), h('span'))
    password.input.addEventListener('input', () => this.updateStrength(strength, password.input.value))
    const error = this.fieldError()
    const request = h('button', {
      class: 'btn',
      text: t('requestCode'),
      onclick: async () => {
        error.clear()
        if (!validEmail(email.input.value.trim())) return error.show('некорректный email')
        try {
          const dev = await this.host.ctx.api.requestCode(email.input.value.trim())
          if (dev) {
            this.setCode(code.inputs, dev)
            snackbar(`код из dev-режима: ${dev}`)
          } else {
            snackbar(t('codeSent'))
          }
        } catch (err) {
          error.show(this.host.errorMessage(err))
        }
      },
    })
    const submit = h('button', {
      class: 'btn primary block',
      text: t('registerSubmit'),
      onclick: async () => {
        error.clear()
        const codeValue = code.inputs.map((input) => input.value).join('')
        if (!validEmail(email.input.value.trim())) return error.show('некорректный email')
        if (!/^\d{4}$/.test(codeValue)) return error.show('код — 4 цифры')
        if (!validPassword(password.input.value)) return error.show('пароль минимум 6 символов')
        this.busy = true
        try {
          await this.host.ctx.register(email.input.value.trim(), codeValue, password.input.value)
          this.host.toast('аккаунт создан', 'success')
          this.host.navigate({ name: 'chats' })
        } catch (err) {
          error.show(this.host.errorMessage(err))
        } finally {
          this.busy = false
        }
      },
    })
    return h(
      'div',
      { class: 'form' },
      email.wrapper,
      h('div', { class: 'code-row' }, code.node, request),
      password.wrapper,
      strength,
      error.node,
      submit,
    )
  }

  // НОВОЕ устройство: сканирует QR основного (nonce|secret), прикрепляет
  // свой ключ и ждёт подтверждения. Ручной ввод кода — запасной путь.
  // НОВОЕ устройство: публикует ключ и показывает QR. Ручной ввод кода
  // на этом экране не нужен — код и так показан.
  private linkForm(): HTMLElement {
    if (!this.linkState) {
      const start = h('button', {
        class: 'btn primary block',
        text: t('linkStart'),
        onclick: () => void this.startLink(),
      })
      return h(
        'div',
        { class: 'form' },
        h('p', { class: 'muted', text: t('linkIntro') }),
        start,
      )
    }
    const state = this.linkState
    const manual = h('div', { class: 'code-box hidden', text: state.code })
    const manualToggle = h('button', {
      class: 'btn small',
      text: t('linkManualEntry'),
      onclick: () => manual.classList.toggle('hidden'),
    })
    return h(
      'div',
      { class: 'form' },
      h('p', { class: 'muted', text: t('linkStep2') }),
      this.qrCanvas(state.code),
      h('p', { class: 'muted', text: t('linkWaiting') }),
      manualToggle,
      manual,
    )
  }

  // шаг 1 нового устройства: ключи в памяти + публикация + показ QR
  private async startLink(): Promise<void> {
    try {
      const started = await this.host.ctx.linkStart()
      this.linkState = { code: started.code, nonce: started.nonce, pollSecret: started.pollSecret }
      this.render()
      this.pollLink()
    } catch (err) {
      snackbar(this.host.errorMessage(err), { kind: 'error' })
    }
  }

  // QR рисуем на canvas без библиотек — свой генератор в util/qr.ts
  private qrCanvas(code: string): HTMLElement {
    const canvas = h('canvas', { class: 'qr-canvas' }) as HTMLCanvasElement
    try {
      const qr = qrMatrix(code)
      const scale = Math.max(4, Math.floor(320 / qr.size))
      canvas.width = qr.size * scale
      canvas.height = qr.size * scale
      const ctx = canvas.getContext('2d')
      if (ctx) {
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(0, 0, canvas.width, canvas.height)
        ctx.fillStyle = '#000000'
        for (let y = 0; y < qr.size; y++) {
          for (let x = 0; x < qr.size; x++) {
            if (qr.modules[y][x]) ctx.fillRect(x * scale, y * scale, scale, scale)
          }
        }
      }
    } catch (err) {
      snackbar(this.host.errorMessage(err), { kind: 'error' })
    }
    return canvas
  }

  private pollLink(): void {
    const state = this.linkState
    if (!state) return
    this.linkTimer = setTimeout(async () => {
      try {
        const result = await this.host.ctx.linkPoll(state.nonce, state.pollSecret)
        if (result) {
          if (this.linkTimer) clearTimeout(this.linkTimer)
          this.linkTimer = null
          this.linkState = null
          this.host.toast('устройство привязано', 'success')
          this.host.navigate({ name: 'chats' })
          return
        }
      } catch (err) {
        snackbar(this.host.errorMessage(err), { kind: 'error' })
      }
      this.pollLink()
    }, 2_000)
  }

  // сворачиваемый блок про безопасность браузера
  private securityBlock(): HTMLElement {
    const details = h('details', { class: 'security-note' })
    details.appendChild(h('summary', {}, h('span', { class: 'security-note-title' }, icon('shield', { size: 18 }), t('securityBrowser'))))
    details.appendChild(h('p', { class: 'muted', text: t('securityBrowserText') }))
    return details
  }

  private field(label: string, options: { type?: string; autocomplete?: string; toggle?: boolean }): { wrapper: HTMLElement; input: HTMLInputElement } {
    const input = h('input', { type: options.type ?? 'text', autocomplete: options.autocomplete ?? 'off', placeholder: ' ' })
    const children: HTMLElement[] = [input, h('span', { class: 'field-label', text: label })]
    if (options.toggle) {
      // глаз показа пароля: на Android он есть на входе и в диалогах
      // бэкапа — слепой ввод даёт опечатки без понятной причины
      const eye = h('button', {
        class: 'field-toggle',
        type: 'button',
        text: t('showPassword'),
        'aria-label': t('showPassword'),
        onclick: () => {
          const shown = input.type === 'text'
          input.type = shown ? 'password' : 'text'
          eye.textContent = shown ? t('showPassword') : t('hidePassword')
          eye.setAttribute('aria-label', eye.textContent ?? '')
          input.focus()
        },
      })
      children.push(eye)
    }
    const wrapper = h('label', { class: 'field' }, ...children)
    return { wrapper, input }
  }

  // 4 отдельные ячейки кода с автопереходом и вставкой целиком
  private codeField(): { node: HTMLElement; inputs: HTMLInputElement[] } {
    const inputs: HTMLInputElement[] = []
    const row = h('div', { class: 'code-inputs' })
    for (let i = 0; i < 4; i++) {
      const input = h('input', { inputmode: 'numeric', maxlength: '1', class: 'code-cell', 'aria-label': `цифра ${i + 1}` })
      input.addEventListener('input', () => {
        input.value = input.value.replace(/\D/g, '').slice(0, 1)
        if (input.value && i < 3) inputs[i + 1].focus()
      })
      input.addEventListener('keydown', (event) => {
        if ((event as KeyboardEvent).key === 'Backspace' && !input.value && i > 0) inputs[i - 1].focus()
      })
      input.addEventListener('paste', (event) => {
        event.preventDefault()
        const text = (event as ClipboardEvent).clipboardData?.getData('text') ?? ''
        const digits = text.replace(/\D/g, '').slice(0, 4)
        for (let j = 0; j < digits.length; j++) inputs[j].value = digits[j]
        inputs[Math.min(digits.length, 3)].focus()
      })
      inputs.push(input)
      row.appendChild(input)
    }
    return { node: row, inputs }
  }

  private setCode(inputs: HTMLInputElement[], code: string): void {
    const digits = code.replace(/\D/g, '').slice(0, 4)
    for (let i = 0; i < inputs.length; i++) inputs[i].value = digits[i] ?? ''
  }

  private updateStrength(node: HTMLElement, value: string): void {
    let score = 0
    if (value.length >= 6) score++
    if (value.length >= 10) score++
    if (/[^a-zA-Z]/.test(value) && /[a-zA-Z]/.test(value)) score++
    node.dataset.score = String(score)
  }

  private fieldError(): { node: HTMLElement; show: (message: string) => void; clear: () => void } {
    const node = h('p', { class: 'field-error hidden' })
    return {
      node,
      show: (message) => {
        node.textContent = message
        node.classList.remove('hidden')
      },
      clear: () => {
        node.textContent = ''
        node.classList.add('hidden')
      },
    }
  }
}

void validLogin
