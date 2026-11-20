// Контакты: книга имён из локального стора + поиск, добавление по логину
// или email (дискавери по хэшу — сырой email на сервер не уходит).
import { h, formatDate, keyedList } from '../dom.js'
import { icon, iconButton } from '../icons.js'
import { t } from '../../i18n/ru.js'
import type { Contact } from '../../store/contacts.js'
import { classifyNewChat, emailHash } from '../../domain/new-chat-target.js'
import { CONTACTS_SORTS, sanitizeContactsSort, sortContacts } from '../../domain/contacts-sort.js'
import { qrMatrix } from '../../util/qr.js'
import type { AppHost } from '../host.js'
import { avatar } from '../components/avatar.js'
import { snackbar } from '../components/snackbar.js'
import { confirmModal, openModal, promptModal } from '../components/modal.js'

// поиск: имя, логин и email без учёта регистра
export function filterContacts(contacts: readonly Contact[], query: string): Contact[] {
  const value = query.trim().toLowerCase()
  if (!value) return [...contacts]
  return contacts.filter(
    (contact) =>
      contact.name.toLowerCase().includes(value) ||
      contact.login.toLowerCase().includes(value) ||
      (contact.email ?? '').toLowerCase().includes(value),
  )
}

// в строке контакта показываем имя, а логин — подписью (как в списке чатов)
export function contactTitle(contact: Contact): string {
  return contact.name || `@${contact.login}`
}

// QR-контакт по образцу android (domain/QrContact.kt): payload «chat:<логин>»
export function qrPayload(login: string): string {
  return `chat:${login.trim().toLowerCase()}`
}

export class ContactsScreen {
  readonly element: HTMLElement
  private list: HTMLElement
  private searchInput: HTMLInputElement
  private searchRow: HTMLElement
  private empty: HTMLElement
  private query = ''
  private searchOpen = false
  private contacts: Contact[] = []
  // время захода логинов в млс; 0 — неизвестно (сервер не ответил)
  private lastSeen = new Map<string, number>()
  private lastSeenPending = new Set<string>()

  constructor(private readonly host: AppHost) {
    this.searchInput = h('input', {
      class: 'search',
      type: 'search',
      placeholder: t('contactsSearch'),
      'aria-label': t('contactsSearch'),
      oninput: () => {
        this.query = this.searchInput.value
        this.update()
      },
    })
    this.searchRow = h('div', { class: 'search-row' }, this.searchInput)
    this.list = h('div', { class: 'chat-list', role: 'list' })
    this.empty = h(
      'div',
      { class: 'empty-state' },
      h('span', { class: 'empty-icon' }, icon('users', { size: 30 })),
      h('p', { text: t('contactsEmpty') }),
    )
    this.element = h('main', { class: 'screen contacts-screen' })
    this.build()
  }

  private build(): void {
    const header = h(
      'header',
      { class: 'topbar' },
      iconButton('back', t('back'), () => this.host.showChats()),
      h('h1', { text: t('contactsTitle') }),
      iconButton('settings', t('contactsSort'), () => this.showSortModal()),
      iconButton('search', t('contactsSearch'), () => this.toggleSearch()),
      iconButton('contact', t('contactsMyQr'), () => void this.myQr()),
    )
    // шеврон вправо: поворачиваем готовую иконку
    const chevron = icon('chevronDown', { size: 18 })
    chevron.style.transform = 'rotate(-90deg)'
    const recentCalls = h(
      'button',
      { class: 'chat-row call-row recent-calls-row', onclick: () => this.host.showCalls() },
      h('span', { class: 'lead-icon' }, icon('phone', { size: 20 })),
      h(
        'span',
        { class: 'chat-body' },
        h(
          'span',
          { class: 'chat-line' },
          h('span', { class: 'setting-label recent-calls-label', text: t('contactsRecentCalls') }),
          h('span', { class: 'chat-time' }, chevron),
        ),
      ),
    )
    const fab = h(
      'button',
      { class: 'fab', 'aria-label': t('contactsAdd'), onclick: () => void this.addContact() },
      icon('plus', { size: 26 }),
    )
    this.element.replaceChildren(header, this.searchRow, recentCalls, this.list, this.empty, fab)
    if (!this.searchOpen) this.searchRow.classList.add('hidden')
  }

  // «Мой QR»: код несёт chat:<логин>, рисуем на canvas без библиотек
  private async myQr(): Promise<void> {
    const login = this.host.ctx.session?.login ?? ''
    if (!login) {
      snackbar(t('noConnection'), { kind: 'error' })
      return
    }
    const canvas = h('canvas', { class: 'qr-canvas' }) as HTMLCanvasElement
    try {
      const qr = qrMatrix(qrPayload(login))
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
      return
    }
    let controller: { close: () => void }
    controller = openModal({
      title: t('contactsMyQr'),
      content: h(
        'div',
        { class: 'form qr-block' },
        canvas,
        h('p', { class: 'field-hint', text: `${t('contactsQrHint')} @${login}` }),
      ),
      actions: [h('button', { class: 'btn primary', text: t('close'), onclick: () => controller.close() })],
    })
  }

  private toggleSearch(): void {
    this.searchOpen = !this.searchOpen
    this.searchRow.classList.toggle('hidden', !this.searchOpen)
    if (this.searchOpen) this.searchInput.focus()
  }

  // книга локальная: грузим из стора и перерисовываем по фильтру
  async render(): Promise<void> {
    this.contacts = await this.host.ctx.contacts.all()
    this.update()
  }

  // выбор сортировки: активный вариант помечен галочкой
  private showSortModal(): void {
    const current = sanitizeContactsSort(this.host.ctx.prefs.contactsSort)
    let controller: { close: () => void }
    controller = openModal({
      title: t('contactsSort'),
      content: h(
        'div',
        { class: 'form' },
        ...CONTACTS_SORTS.map((sort) =>
          h(
            'button',
            {
              class: `btn sort-option${current === sort.id ? ' primary' : ''}`,
              onclick: async () => {
                await this.host.ctx.savePrefs({ contactsSort: sort.id })
                controller.close()
                this.update()
              },
            },
            h('span', { class: 'sort-option-label', text: t(sort.labelKey) }),
            current === sort.id ? icon('check', { size: 18 }) : null,
          ),
        ),
      ),
    })
  }

  update(): void {
    const mode = sanitizeContactsSort(this.host.ctx.prefs.contactsSort)
    const visible = sortContacts(filterContacts(this.contacts, this.query), mode, this.lastSeen)
    this.empty.classList.toggle('hidden', visible.length > 0)
    keyedList(
      this.list,
      visible,
      (contact) => contact.login,
      (contact) => this.row(contact),
      (node, contact) => this.paintRow(node, contact),
    )
    if (mode === 'lastSeen') void this.loadLastSeen(visible)
  }

  // заходим в сеть пачками по 5; загруженные логины не запрашиваем повторно
  private async loadLastSeen(visible: Contact[]): Promise<void> {
    const session = this.host.ctx.session
    if (!session) return
    const missing = visible.filter((contact) => !this.lastSeen.has(contact.login) && !this.lastSeenPending.has(contact.login))
    if (missing.length === 0) return
    for (const contact of missing) this.lastSeenPending.add(contact.login)
    for (let i = 0; i < missing.length; i += 5) {
      const batch = missing.slice(i, i + 5)
      await Promise.all(
        batch.map(async (contact) => {
          let seen = 0
          try {
            const status = await this.host.ctx.api.checkOnline(session.token, contact.login)
            seen = status.lastSeenUnix > 0 ? status.lastSeenUnix * 1000 : 0
          } catch {
            seen = 0
          }
          this.lastSeen.set(contact.login, seen)
          this.lastSeenPending.delete(contact.login)
        }),
      )
    }
    this.update()
  }

  private row(contact: Contact): HTMLElement {
    const node = h('div', { class: 'chat-row contact-row' })
    node.appendChild(h('span', { class: 'chat-avatar' }))
    const body = h('span', { class: 'chat-body' })
    body.appendChild(
      h(
        'span',
        { class: 'chat-line' },
        h('span', { class: 'chat-title' }),
        h('span', { class: 'chat-time' }),
        iconButton('more', t('more'), (event) => {
          event.stopPropagation()
          void this.menu(contact)
        }),
      ),
    )
    body.appendChild(h('span', { class: 'chat-line' }, h('span', { class: 'chat-preview' })))
    node.appendChild(body)
    node.addEventListener('click', () => void this.host.openChat(contact.login))
    return node
  }

  private paintRow(node: HTMLElement, contact: Contact): void {
    const seed = contact.login
    const avatarSlot = node.querySelector<HTMLElement>('.chat-avatar')!
    if (avatarSlot.dataset.seed !== seed || avatarSlot.childElementCount === 0) {
      avatarSlot.dataset.seed = seed
      avatarSlot.replaceChildren(avatar(seed, { size: 48 }))
    }
    node.querySelector('.chat-title')!.textContent = contactTitle(contact)
    node.querySelector('.chat-time')!.textContent = formatDate(contact.updatedAt)
    const preview = node.querySelector('.chat-preview')!
    preview.textContent = `@${contact.login}${contact.email ? ` · ${contact.email}` : ''}`
  }

  // добавление по логину или email; email резолвим discover'ом по хэшу
  private async addContact(): Promise<void> {
    const session = this.host.ctx.session
    let busy = false
    const error = h('p', { class: 'field-error hidden' })
    const targetInput = h('input', {
      type: 'text',
      placeholder: t('newChatTargetHint'),
      autocomplete: 'off',
    })
    const submitButton = h('button', { class: 'btn primary', text: t('contactsAdd'), onclick: () => void submit() })
    const submit = async (): Promise<void> => {
      if (busy) return
      const target = classifyNewChat(targetInput.value)
      if (target.kind === 'invalid') {
        error.textContent = t('newChatTargetHint')
        error.classList.remove('hidden')
        return
      }
      if (target.kind === 'login') {
        if (target.login === session?.login) {
          error.textContent = t('contactsSelf')
          error.classList.remove('hidden')
          return
        }
        await this.save({ login: target.login, name: '' })
        controller.close()
        return
      }
      if (!session) {
        error.textContent = t('noConnection')
        error.classList.remove('hidden')
        return
      }
      busy = true
      submitButton.setAttribute('disabled', '')
      try {
        // один хэш за запрос: на сервер уходит только SHA-256 от email
        const matches = await session.api.discover(session.token, [await emailHash(target.email)])
        const login = matches[0]?.login ?? ''
        if (!login) {
          error.textContent = t('newChatNotFound')
          error.classList.remove('hidden')
          return
        }
        await this.save({ login, name: '', email: target.email })
        controller.close()
      } catch (e) {
        error.textContent = this.host.errorMessage(e)
        error.classList.remove('hidden')
      } finally {
        busy = false
        submitButton.removeAttribute('disabled')
      }
    }
    const controller = openModal({
      title: t('contactsAdd'),
      content: h(
        'div',
        { class: 'form' },
        targetInput,
        h('p', { class: 'field-hint', text: t('newChatTargetHint') }),
        error,
      ),
      actions: [h('button', { class: 'btn', text: t('cancel'), onclick: () => controller.close() }), submitButton],
      dismissible: false,
    })
    targetInput.addEventListener('keydown', (event) => {
      if ((event as KeyboardEvent).key === 'Enter') void submit()
    })
  }

  private async save(contact: { login: string; name: string; email?: string }): Promise<void> {
    await this.host.ctx.contacts.put({ ...contact, updatedAt: Date.now() })
    snackbar(t('contactsAdded'), { kind: 'success' })
    await this.render()
  }

  // переименование, блокировка и удаление контакта — из меню строки
  private async menu(contact: Contact): Promise<void> {
    const blocked = await this.host.ctx.blocked.isBlocked(contact.login)
    const controller = openModal({
      title: contactTitle(contact),
      content: h(
        'div',
        { class: 'form' },
        h('p', { class: 'modal-text', text: `@${contact.login}${contact.email ? ` · ${contact.email}` : ''}` }),
      ),
      actions: [
        h('button', { class: 'btn', text: t('rename'), onclick: () => void this.rename(contact, controller) }),
        // блок-лист отправителей (P-W4): пункт меняет название по состоянию
        h('button', {
          class: 'btn',
          text: blocked ? t('blockedUnblock') : t('blockedBlock'),
          onclick: () => void this.toggleBlocked(contact, controller),
        }),
        h('button', { class: 'btn danger', text: t('delete'), onclick: () => void this.remove(contact, controller) }),
      ],
    })
  }

  private async toggleBlocked(contact: Contact, controller: { close: () => void }): Promise<void> {
    if (await this.host.ctx.blocked.isBlocked(contact.login)) {
      await this.host.ctx.blocked.unblock(contact.login)
      snackbar(t('blockedUnblocked'))
    } else {
      await this.host.ctx.blocked.block(contact.login)
      snackbar(t('blockedBlocked'), { kind: 'success' })
    }
    controller.close()
  }

  private async rename(contact: Contact, controller: { close: () => void }): Promise<void> {
    const name = await promptModal({
      title: t('rename'),
      label: t('contactsName'),
      value: contact.name,
      placeholder: contact.login,
    })
    if (name === null) return
    await this.host.ctx.contacts.rename(contact.login, name.trim())
    snackbar(t('contactsRenamed'), { kind: 'success' })
    controller.close()
    await this.render()
  }

  private async remove(contact: Contact, controller: { close: () => void }): Promise<void> {
    const ok = await confirmModal({ title: t('contactsDelete'), message: `@${contact.login}`, danger: true })
    if (!ok) return
    await this.host.ctx.contacts.remove(contact.login)
    snackbar(t('contactsRemoved'))
    controller.close()
    await this.render()
  }
}
