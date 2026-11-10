// Список чатов: крупные строки, keyed-обновление (скролл не прыгает),
// сворачиваемый поиск, пустое состояние, кнопка «Новый чат».
import { h, formatDate, keyedList } from '../dom.js'
import { icon, iconButton } from '../icons.js'
import { t } from '../../i18n/ru.js'
import { previewOf } from '../../domain/feed.js'
import type { ChatSummary } from '../../domain/messenger.js'
import type { FeedItem } from '../../domain/feed.js'
import { validLogin } from '../../protocol/validators.js'
import type { AppHost } from '../host.js'
import { avatar } from '../components/avatar.js'
import { snackbar } from '../components/snackbar.js'
import { openModal } from '../components/modal.js'

export class ChatsScreen {
  readonly element: HTMLElement
  private list: HTMLElement
  private searchInput: HTMLInputElement
  private searchRow: HTMLElement
  private empty: HTMLElement
  private query = ''
  private searchOpen = false

  constructor(private readonly host: AppHost) {
    this.searchInput = h('input', {
      class: 'search',
      type: 'search',
      placeholder: t('chatsSearch'),
      'aria-label': t('chatsSearch'),
      oninput: () => {
        this.query = this.searchInput.value
        this.update()
      },
    })
    this.searchRow = h('div', { class: 'search-row' }, this.searchInput)
    this.list = h('div', { class: 'chat-list', role: 'list' })
    this.empty = h('div', { class: 'empty-state' }, h('span', { class: 'empty-icon' }, icon('smile', { size: 40 })), h('p', { text: t('chatsEmpty') }))
    this.element = h('main', { class: 'screen chats-screen' })
    this.build()
  }

  private build(): void {
    const header = h(
      'header',
      { class: 'topbar' },
      h('span', { class: `status-dot ${this.host.state.connected ? 'online' : 'offline'}`, title: this.host.state.connected ? t('online') : t('offline') }),
      h('h1', { text: t('chatsTitle') }),
      iconButton('search', t('chatsSearch'), () => this.toggleSearch()),
      iconButton('settings', t('settingsTitle'), () => this.host.showSettings()),
    )
    const fab = h('button', { class: 'fab', 'aria-label': t('chatsNew'), onclick: () => this.newChat() }, icon('plus', { size: 26 }))
    this.element.replaceChildren(header, this.searchRow, this.list, this.empty, fab)
    if (!this.searchOpen) this.searchRow.classList.add('hidden')
  }

  private toggleSearch(): void {
    this.searchOpen = !this.searchOpen
    this.searchRow.classList.toggle('hidden', !this.searchOpen)
    if (this.searchOpen) this.searchInput.focus()
  }

  update(): void {
    const connected = this.host.state.connected
    const dot = this.element.querySelector('.status-dot')
    dot?.classList.toggle('online', connected)
    dot?.classList.toggle('offline', !connected)

    const query = this.query.trim().toLowerCase()
    const chats = this.host.state.summaries.filter(
      (chat) => !query || chat.title.toLowerCase().includes(query) || chat.chatId.includes(query),
    )
    this.empty.classList.toggle('hidden', chats.length > 0)
    keyedList(
      this.list,
      chats,
      (chat) => chat.chatId,
      (chat) => this.row(chat),
      (node, chat) => this.paintRow(node, chat),
    )
  }

  private row(chat: ChatSummary): HTMLElement {
    const node = h('button', { class: 'chat-row', role: 'listitem' })
    node.appendChild(h('span', { class: 'chat-avatar' }))
    const body = h('span', { class: 'chat-body' })
    body.appendChild(
      h('span', { class: 'chat-line' }, h('span', { class: 'chat-title' }), h('span', { class: 'chat-time' })),
    )
    body.appendChild(
      h(
        'span',
        { class: 'chat-line' },
        h('span', { class: 'chat-preview' }),
        h('span', { class: 'chat-badges' }, h('span', { class: 'badge hidden' })),
      ),
    )
    node.appendChild(body)
    node.addEventListener('click', () => void this.host.openChat(chat.chatId))
    return node
  }

  private paintRow(node: HTMLElement, chat: ChatSummary): void {
    const seed = chat.isGroup ? chat.group?.name ?? chat.chatId : chat.chatId
    const avatarSlot = node.querySelector<HTMLElement>('.chat-avatar')!
    if (avatarSlot.dataset.seed !== seed || avatarSlot.childElementCount === 0) {
      avatarSlot.dataset.seed = seed
      avatarSlot.replaceChildren(avatar(seed, { size: 48, isGroup: chat.isGroup }))
    }
    node.querySelector('.chat-title')!.textContent = chat.title
    node.querySelector('.chat-time')!.textContent = chat.lastTs ? formatDate(chat.lastTs) : ''
    const preview = node.querySelector('.chat-preview')!
    if (chat.typing) {
      preview.textContent = t('typing')
      preview.classList.add('typing')
    } else if (chat.draft) {
      preview.textContent = `${t('draftPrefix')} ${chat.draft}`
      preview.classList.add('draft')
    } else {
      preview.textContent = chat.lastRecord ? previewOf(feedItemOf(chat, this.host.ctx.session?.login ?? '')) : t('noMessages')
      preview.classList.remove('typing', 'draft')
    }
    const badge = node.querySelector('.badge') as HTMLElement
    badge.classList.toggle('hidden', chat.unread <= 0)
    badge.textContent = chat.unread > 99 ? '99+' : String(chat.unread)
    node.classList.toggle('unread', chat.unread > 0)
    node.classList.toggle('pinned', chat.pinned.length > 0)
  }

  private newChat(): void {
    const input = h('input', { type: 'text', placeholder: t('newChatLogin'), autocomplete: 'off' })
    const error = h('p', { class: 'field-error hidden' })
    const open = (): void => {
      const login = input.value.trim().toLowerCase()
      if (!validLogin(login)) {
        error.textContent = 'логин: 3–32 символа, a–z, 0–9, _ и -'
        error.classList.remove('hidden')
        input.focus()
        return
      }
      if (login === this.host.ctx.session?.login) {
        error.textContent = 'это ваш собственный логин'
        error.classList.remove('hidden')
        return
      }
      controller.close()
      void this.host.openChat(login)
    }
    const controller = openModal({
      title: t('chatsNew'),
      content: h('div', { class: 'form' }, input, error),
      actions: [
        h('button', { class: 'btn', text: t('cancel'), onclick: () => controller.close() }),
        h('button', { class: 'btn primary', text: t('newChatOpen'), onclick: open }),
      ],
    })
    input.addEventListener('keydown', (event) => {
      if ((event as KeyboardEvent).key === 'Enter') open()
    })
  }

  showEmpty(): void {
    this.update()
  }
}

function feedItemOf(chat: ChatSummary, myLogin: string): FeedItem {
  return {
    record: chat.lastRecord ?? { from: '', timestamp: 0, content: new Uint8Array() },
    parsed: { kind: 'content', content: { kind: 'unsupported' } },
    kind: chat.lastKind,
    mine: chat.lastRecord?.from === myLogin,
    ref: '',
    timestamp: chat.lastTs,
    pinned: false,
    sending: false,
  }
}

void snackbar
