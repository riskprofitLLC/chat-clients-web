// Экран блокировки приложения PIN-кодом (P-W5): полноэкранный слой поверх
// интерфейса, ввод шести цифр и обратный отсчёт паузы после неудач.
// Проверка — PBKDF2 600k в store/pin.ts, здесь только ввод и показ.
import { h } from '../dom.js'
import { icon } from '../icons.js'
import { t } from '../../i18n/ru.js'
import type { AppHost } from '../host.js'
import { PIN_LENGTH, formatRemaining, sanitizePin } from '../../domain/pin.js'

export class AppLock {
  readonly element: HTMLElement
  private readonly input: HTMLInputElement
  private readonly error: HTMLElement
  private readonly countdown: HTMLElement
  private readonly submit: HTMLButtonElement
  private countdownTimer: ReturnType<typeof setInterval> | null = null
  private busy = false

  constructor(
    private readonly host: AppHost,
    private readonly onUnlocked: () => void,
  ) {
    this.input = h('input', {
      class: 'app-lock-input',
      type: 'password',
      inputmode: 'numeric',
      autocomplete: 'off',
      maxlength: String(PIN_LENGTH),
      placeholder: '••••••',
      'aria-label': t('lockTitle'),
      oninput: () => {
        // фильтруем ввод до цифр: с клавиатуры могут прийти буквы и пробелы
        this.input.value = sanitizePin(this.input.value)
        this.error.classList.add('hidden')
        this.refreshSubmit()
      },
      onkeydown: (event: KeyboardEvent) => {
        if (event.key === 'Enter') void this.tryUnlock()
      },
    })
    this.error = h('p', { class: 'app-lock-error hidden', text: t('lockWrong') })
    this.countdown = h('p', { class: 'app-lock-countdown hidden' })
    this.submit = h('button', {
      class: 'btn primary block',
      text: t('unlock'),
      onclick: () => void this.tryUnlock(),
    })
    const card = h(
      'div',
      { class: 'app-lock-card' },
      h('span', { class: 'app-lock-icon' }, icon('lock', { size: 30 })),
      h('h1', { class: 'app-lock-title', text: t('lockTitle') }),
      this.error,
      this.countdown,
      this.input,
      this.submit,
    )
    this.element = h('div', { class: 'app-lock', role: 'dialog', 'aria-modal': 'true' }, card)
    this.refreshSubmit()
  }

  // показ поверх интерфейса; сразу показываем остаток паузы из троттлинга
  async present(): Promise<void> {
    // сбрасываем состояние прошлого показа: иначе на повторный экран
    // вылезает старый ввод и зависшая кнопка «Проверяем…»
    this.busy = false
    this.input.value = ''
    this.input.disabled = false
    this.error.classList.add('hidden')
    this.countdown.classList.add('hidden')
    this.submit.textContent = t('unlock')
    if (!this.element.isConnected) document.body.appendChild(this.element)
    await this.tickCountdown()
    this.input.focus()
    this.refreshSubmit()
  }

  hide(): void {
    if (this.countdownTimer) clearInterval(this.countdownTimer)
    this.countdownTimer = null
    this.element.remove()
  }

  private refreshSubmit(): void {
    this.submit.disabled = this.busy || sanitizePin(this.input.value).length !== PIN_LENGTH
  }

  private async tryUnlock(): Promise<void> {
    if (this.busy) return
    const pin = sanitizePin(this.input.value)
    if (pin.length !== PIN_LENGTH) return
    this.busy = true
    this.submit.disabled = true
    this.submit.textContent = t('lockChecking')
    try {
      const verdict = await this.host.ctx.pinLock.verify(pin)
      if (verdict.ok) {
        this.hide()
        this.onUnlocked()
        return
      }
      // неверный код: чистим поле, показываем ошибку или остаток паузы
      this.input.value = ''
      if (verdict.remainingMs > 0) await this.startCountdown(verdict.remainingMs)
      else {
        this.error.classList.remove('hidden')
        this.refreshSubmit()
      }
    } finally {
      this.busy = false
      if (!this.element.isConnected) return
      if (!this.countdownTimer) {
        this.submit.textContent = t('unlock')
        this.refreshSubmit()
      }
    }
  }

  // обратный отсчёт паузы: пока он идёт, ввод запрещён (PBKDF2 не считаем)
  private async tickCountdown(): Promise<void> {
    const remaining = await this.host.ctx.pinLock.remainingMs()
    if (remaining <= 0) {
      this.countdown.classList.add('hidden')
      return
    }
    await this.startCountdown(remaining)
  }

  private async startCountdown(fromMs:
 number): Promise<void> {
    let remaining = fromMs
    const paint = (): void => {
      this.countdown.textContent = `${t('lockWaitPrefix')} ${formatRemaining(remaining)}`
      this.countdown.classList.remove('hidden')
      const blocked = remaining > 0
      this.input.disabled = blocked
      this.submit.disabled = blocked || sanitizePin(this.input.value).length !== PIN_LENGTH
    }
    paint()
    if (this.countdownTimer) clearInterval(this.countdownTimer)
    this.countdownTimer = setInterval(() => {
      remaining -= 1_000
      if (remaining <= 0) {
        if (this.countdownTimer) clearInterval(this.countdownTimer)
        this.countdownTimer = null
        this.countdown.classList.add('hidden')
        this.error.classList.remove('hidden')
      }
      paint()
    }, 1_000)
  }
}
