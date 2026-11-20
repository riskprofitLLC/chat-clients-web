// Экран «Звонки»: журнал звонков, сгруппированный по дням (свежие сверху).
// Тап по записи — повторный звонок и переход в чат пира. Логика списка —
// в domain/call-log.ts, экран только отображает.
import { h } from '../dom.js'
import { icon, iconButton } from '../icons.js'
import { t } from '../../i18n/ru.js'
import type { AppHost } from '../host.js'
import type { CallLogEntry } from '../../store/chat-state.js'
import { dayLabel, formatTime, groupByDay, statusText } from '../../domain/call-log.js'

export class CallsScreen {
  readonly element: HTMLElement
  private list: HTMLElement
  private empty: HTMLElement
  private entries: CallLogEntry[] = []

  constructor(private readonly host: AppHost) {
    this.list = h('div', { class: 'chat-list', role: 'list' })
    this.empty = h(
      'div',
      { class: 'empty-state' },
      h('span', { class: 'empty-icon' }, icon('phone', { size: 30 })),
      h('p', { text: t('callsEmpty') }),
    )
    this.element = h('main', { class: 'screen calls-screen' })
    this.build()
  }

  private build(): void {
    const header = h(
      'header',
      { class: 'topbar' },
      iconButton('back', t('back'), () => this.host.showChats()),
      h('h1', { text: t('callsTitle') }),
    )
    this.element.replaceChildren(header, this.list, this.empty)
  }

  async render(): Promise<void> {
    const messenger = this.host.ctx.messenger
    this.entries = messenger ? await messenger.callLog() : []
    this.paint()
  }

  private paint(): void {
    const groups = groupByDay(this.entries)
    this.empty.classList.toggle('hidden', groups.length > 0)
    // журнал перерисовывается на любое изменение стора: запоминаем прокрутку
    // до замены строк и возвращаем её после, иначе список прыгает наверх
    const scrollTop = this.list.scrollTop
    this.list.replaceChildren()
    for (const group of groups) {
      this.list.appendChild(h('div', { class: 'calls-day', text: dayLabel(group.dayStart, Date.now()) }))
      for (const entry of group.entries) {
        const missed = entry.status === 'missed'
        const row = h(
          'button',
          {
            class: `chat-row call-row${missed ? ' missed' : ''}`,
            role: 'listitem',
            onclick: () => void this.redial(entry),
          },
          // ведущая иконка в тонированном круге — единый ряд с настройками и инфо
          h('span', { class: 'lead-icon' }, icon('phone', { size: 20 })),
          h(
            'span',
            { class: 'chat-body' },
            h(
              'span',
              { class: 'chat-line' },
              h('span', { class: 'chat-title', text: entry.peer }),
              h('span', { class: 'chat-time', text: formatTime(entry.at) }),
            ),
              h('span', { class: `chat-preview${missed ? ' missed' : ''}`, text: statusText(entry) }),
            ),
          )
        this.list.appendChild(row)
      }
    }
    if (scrollTop > 0) this.list.scrollTop = scrollTop
  }

  // повторный звонок: поднимаем звонок и открываем чат пира (оверлей общий)
  private async redial(entry: CallLogEntry): Promise<void> {
    const calls = this.host.ctx.calls
    if (!calls) return
    try {
      await calls.startCall(entry.peer)
      await this.host.openChat(entry.peer)
    } catch (error) {
      this.host.toast(this.host.errorMessage(error), 'error')
    }
  }
}