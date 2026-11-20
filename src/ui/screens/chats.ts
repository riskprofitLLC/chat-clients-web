// Список чатов: крупные строки, keyed-обновление (скролл не прыгает),
// сворачиваемый поиск, пустое состояние, кнопка «Новый чат», ряд историй,
// свайп-действия и быстрое меню строки, архив.
import { h, formatDate, keyedList } from '../dom.js'
import { formatUnbadge } from '../unbadge.js'
import { icon, iconButton } from '../icons.js'
import { t } from '../../i18n/ru.js'
import { previewOf } from '../../domain/feed.js'
import type { ChatSummary } from '../../domain/messenger.js'
import type { FeedItem } from '../../domain/feed.js'
import { activeStories, groupByAuthor, type StoryItem } from '../../domain/story-feed.js'
import { classifyNewChat, emailHash } from '../../domain/new-chat-target.js'
import { preparePhoto } from '../../media/media.js'
import { openStoryViewer } from './story-viewer.js'

// срок жизни истории — 24 часа
const STORY_TTL = 24 * 60 * 60 * 1000
import type { AppHost } from '../host.js'
import type { ChatFlags } from '../../store/chat-flags.js'
import { avatar } from '../components/avatar.js'
import { snackbar } from '../components/snackbar.js'
import { confirmModal, openModal } from '../components/modal.js'

export class ChatsScreen {
  readonly element: HTMLElement
  private list: HTMLElement
  private searchInput: HTMLInputElement
  private searchRow: HTMLElement
  private empty: HTMLElement
  private storyStrip: HTMLElement
  private archiveToggle: HTMLElement
  private query = ''
  private searchOpen = false
  // локальные флаги списка: архив / непрочитано вручную / без звука
  private flags: ChatFlags = { markedUnread: [], archived: [], muted: [] }
  private showArchive = false
  private stories: StoryItem[] = []

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
    // ряд историй и переключатель архива живут над списком
    this.storyStrip = h('div', { class: 'story-strip hidden' })
    this.archiveToggle = h(
      'button',
      { class: 'archive-toggle hidden', onclick: () => this.toggleArchive() },
      icon('folder', { size: 18 }),
      h('span', { class: 'archive-toggle-label', text: t('archivedTitle') }),
    )
    this.empty = h('div', { class: 'empty-state' }, h('span', { class: 'empty-icon' }, icon('smile', { size: 30 })), h('p', { text: t('chatsEmpty') }))
    this.element = h('main', { class: 'screen chats-screen' })
    this.build()
    // флаги локальные: грузим один раз и перерисовываем список
    void this.host.ctx.chatFlags.all().then((flags) => {
      this.flags = flags
      this.update()
    })
  }

  private toggleArchive(): void {
    this.showArchive = !this.showArchive
    this.update()
  }

  // установка/снятие флага строки: пишем в стор и перерисовываем список
  private async setFlag(kind: 'unread' | 'archive' | 'mute', chatId: string, value: boolean): Promise<void> {
    this.flags = await this.host.ctx.chatFlags.set(kind, chatId, value)
    this.update()
  }

  private build(): void {
    const header = h(
      'header',
      { class: 'topbar' },
      h('span', { class: `status-dot ${this.host.state.connected ? 'online' : 'offline'}`, title: this.host.state.connected ? t('online') : t('offline') }),
      h('h1', { text: t('chatsTitle') }),
      iconButton('search', t('chatsSearch'), () => this.toggleSearch()),
      iconButton('phone', t('callsTitle'), () => this.host.showCalls()),
      iconButton('user', t('contactsTitle'), () => this.host.showContacts()),
      iconButton('settings', t('settingsTitle'), () => this.host.showSettings()),
    )
    const fab = h('button', { class: 'fab', 'aria-label': t('chatsNew'), onclick: () => this.newChat() }, icon('plus', { size: 26 }))
    this.element.replaceChildren(header, this.searchRow, this.storyStrip, this.archiveToggle, this.list, this.empty, fab)
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
    const matches = (chat: ChatSummary): boolean => !query || chat.title.toLowerCase().includes(query) || chat.chatId.includes(query)
    // архив — отдельный вид списка: основные строки скрыты и наоборот
    const chats = this.host.state.summaries.filter((chat) => {
      const archived = this.flags.archived.includes(chat.chatId)
      return matches(chat) && (this.showArchive ? archived : !archived)
    })
    this.empty.classList.toggle('hidden', chats.length > 0)
    this.archiveToggle.classList.toggle('hidden', this.flags.archived.length === 0)
    const archiveLabel = this.archiveToggle.querySelector('.archive-toggle-label')!
    archiveLabel.textContent = this.showArchive ? t('chatsTitle') : t('archivedTitle')
    keyedList(
      this.list,
      chats,
      (chat) => chat.chatId,
      (chat) => this.row(chat),
      (node, chat) => this.paintRow(node, chat),
    )
    void this.loadStories()
  }

  // ─── истории ────────────────────────────────────────────────────────────

  // истории живут в журналах чатов как обычные медиа со storyExp: читаем
  // хвост каждого чата и оставляем непросроченные
  private async loadStories(): Promise<void> {
    const now = Date.now()
    const items: StoryItem[] = []
    for (const chat of this.host.state.summaries) {
      try {
        const records = await this.host.ctx.journal.history(chat.chatId, 50)
        for (const item of activeStories(records, now)) items.push({ ...item, author: chat.chatId })
      } catch {
        // журнал чата недоступен (заблокирован/ошибка) — просто нет историй
      }
    }
    const unique = [...new Map(items.map((item) => [`${item.author}:${item.timestamp}`, item])).values()]
    this.stories = unique.sort((a, b) => b.timestamp - a.timestamp).slice(0, 20)
    this.paintStories()
  }

  private paintStories(): void {
    const groups = groupByAuthor(this.stories)
    this.storyStrip.classList.toggle('hidden', groups.size === 0)
    if (groups.size === 0) {
      this.storyStrip.replaceChildren()
      return
    }
    const add = h(
      'button',
      { class: 'story-add', 'aria-label': t('storiesAdd'), title: t('storiesAdd'), onclick: () => void this.addStory() },
      icon('plus', { size: 22 }),
    )
    const circles = [...groups.entries()].map(([author, items]) =>
      h(
        'button',
        { class: 'story-circle', onclick: () => this.openStory(author, items) },
        avatar(author, { size: 56 }),
        h('span', { class: 'story-name', text: author }),
      ),
    )
    this.storyStrip.replaceChildren(add, ...circles)
  }

  // своя история — фото из файлового пикера; новых эндпоинтов и полей wire нет
  private async addStory(): Promise<void> {
    const input = h('input', { type: 'file', accept: 'image/*' }) as HTMLInputElement
    input.addEventListener('change', () => {
      const file = input.files?.[0]
      if (!file) return
      void this.sendStory(file)
    })
    input.click()
  }

  private async sendStory(file: File): Promise<void> {
    const messenger = this.host.ctx.messenger
    const login = this.host.ctx.session?.login
    if (!messenger || !login) return
    try {
      const { info } = await preparePhoto(file)
      // срок жизни истории — 24 часа, как в Android-клиенте
      await messenger.sendMedia(login, { ...info, storyExp: Date.now() + STORY_TTL })
      snackbar(t('storiesAdd'), { kind: 'success' })
      await this.host.refreshSummaries()
      void this.loadStories()
    } catch (error) {
      snackbar(this.host.errorMessage(error), { kind: 'error' })
    }
  }

  // просмотрщик историй вынесен в отдельный экран
  private openStory(author: string, items: StoryItem[]): void {
    openStoryViewer(author, items)
  }

  private row(chat: ChatSummary): HTMLElement {
    const node = h('button', { class: 'chat-row', role: 'listitem' })
    node.appendChild(h('span', { class: 'chat-avatar' }))
    const body = h('span', { class: 'chat-body' })
    body.appendChild(
      h(
        'span',
        { class: 'chat-line' },
        h('span', { class: 'chat-title' }),
        // статус доставки своего последнего — перед временем, как мета в пузыре
        h('span', { class: 'chat-status hidden' }, icon('checks', { size: 14 })),
        h('span', { class: 'chat-time' }),
        // закреп — справа от времени, сортировка строк не зависит от него
        h('span', { class: 'chat-pin hidden' }, icon('pin', { size: 14 })),
        // «без звука» — там же, мелким значком у времени
        h('span', { class: 'chat-mute hidden' }, icon('micOff', { size: 14 })),
      ),
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
    let startX = 0
    let startY = 0
    let swiped = false
    let pressTimer: ReturnType<typeof setTimeout> | null = null
    const cancelPress = (): void => {
      if (pressTimer) clearTimeout(pressTimer)
      pressTimer = null
    }
    // свайп влево — архив, вправо — прочитано/непрочитанно; долгое нажатие — меню
    node.addEventListener('pointerdown', (event) => {
      startX = event.clientX
      startY = event.clientY
      swiped = false
      pressTimer = setTimeout(() => {
        pressTimer = null
        this.openRowMenu(chat)
      }, 450)
    })
    node.addEventListener('pointermove', (event) => {
      if (Math.abs(event.clientX - startX) < 8 && Math.abs(event.clientY - startY) < 8) return
      cancelPress()
    })
    node.addEventListener('pointerup', (event) => {
      cancelPress()
      const delta = event.clientX - startX
      if (Math.abs(delta) < 60 || Math.abs(event.clientY - startY) > 40) return
      swiped = true
      if (delta < 0) void this.setFlag('archive', chat.chatId, !this.flags.archived.includes(chat.chatId))
      else void this.setFlag('unread', chat.chatId, !this.flags.markedUnread.includes(chat.chatId))
    })
    node.addEventListener('pointercancel', cancelPress)
    node.addEventListener('contextmenu', (event) => {
      event.preventDefault()
      this.openRowMenu(chat)
    })
    node.addEventListener('click', () => {
      if (swiped) return
      void this.host.openChat(chat.chatId)
    })
    return node
  }

  private paintRow(node: HTMLElement, chat: ChatSummary): void {
    const seed = chat.isGroup ? chat.group?.name ?? chat.chatId : chat.chatId
    const avatarSlot = node.querySelector<HTMLElement>('.chat-avatar')!
    if (avatarSlot.dataset.seed !== seed || avatarSlot.childElementCount === 0) {
      avatarSlot.dataset.seed = seed
      avatarSlot.replaceChildren(avatar(seed, { size: 54, isGroup: chat.isGroup }))
    }
    node.querySelector('.chat-title')!.textContent = chat.title
    node.querySelector('.chat-time')!.textContent = chat.lastTs ? formatDate(chat.lastTs) : ''
    const mine = chat.lastRecord?.from === (this.host.ctx.session?.login ?? '')
    const preview = node.querySelector('.chat-preview')!
    if (chat.typing) {
      preview.textContent = t('typing')
      preview.classList.add('typing')
    } else if (chat.draft) {
      preview.textContent = `${t('draftPrefix')} ${chat.draft}`
      preview.classList.add('draft')
    } else if (mine && chat.lastRecord) {
      // превью своего сообщения: «Вы: …» из i18n, а не из хардкода домена
      preview.textContent = `${t('youPrefix')} ${previewOf(feedItemOf(chat, ''))}`
      preview.classList.remove('typing', 'draft')
    } else {
      preview.textContent = chat.lastRecord ? previewOf(feedItemOf(chat, this.host.ctx.session?.login ?? '')) : t('noMessages')
      preview.classList.remove('typing', 'draft')
    }
    const marked = this.flags.markedUnread.includes(chat.chatId)
    const muted = this.flags.muted.includes(chat.chatId)
    const badge = node.querySelector('.badge') as HTMLElement
    // непрочитанные из данных либо точка «непрочитано вручную»
    const showBadge = chat.unread > 0 || marked
    badge.classList.toggle('hidden', !showBadge)
    badge.textContent = chat.unread > 0 ? formatUnbadge(chat.unread) : ''
    badge.classList.toggle('dot', chat.unread <= 0 && marked)
    node.querySelector('.chat-mute')!.classList.toggle('hidden', !muted)
    node.querySelector('.chat-status')!.classList.toggle('hidden', !mine || !chat.lastRecord)
    node.querySelector('.chat-pin')!.classList.toggle('hidden', chat.pinned.length === 0)
    node.classList.toggle('unread', chat.unread > 0)
    node.classList.toggle('pinned', chat.pinned.length > 0)
  }

  // быстрое меню строки: звук, непрочитанное, архив, удаление чата
  private openRowMenu(chat: ChatSummary): void {
    const archived = this.flags.archived.includes(chat.chatId)
    const muted = this.flags.muted.includes(chat.chatId)
    const marked = this.flags.markedUnread.includes(chat.chatId)
    const item = (label: string, name: Parameters<typeof icon>[0], action: () => void, danger = false): HTMLElement =>
      h('button', { class: `menu-item${danger ? ' danger' : ''}`, onclick: () => { controller.close(); action() } }, icon(name, { size: 20 }), label)
    const controller = openModal({
      content: h(
        'div',
        { class: 'menu-list' },
        item(muted ? t('rowUnmute') : t('rowMute'), muted ? 'speaker' : 'micOff', () => void this.setFlag('mute', chat.chatId, !muted)),
        item(marked ? t('rowMarkRead') : t('rowMarkUnread'), 'checks', () => void this.setFlag('unread', chat.chatId, !marked)),
        item(archived ? t('rowUnarchive') : t('rowArchive'), 'folder', () => void this.setFlag('archive', chat.chatId, !archived)),
        item(t('rowDelete'), 'trash', () => void this.deleteChat(chat), true),
      ),
    })
  }

  // удаление чата — только локальное: журнал на устройстве стираем, сервер не просим
  private async deleteChat(chat: ChatSummary): Promise<void> {
    const ok = await confirmModal({ title: t('rowDelete'), message: chat.title, danger: true })
    if (!ok) return
    await this.host.ctx.journal.clearChat(chat.chatId)
    await this.host.refreshSummaries()
  }

  private newChat(): void {
    const input = h('input', { type: 'text', placeholder: t('newChatTargetHint'), autocomplete: 'off' })
    const error = h('p', { class: 'field-error hidden' })
    let busy = false
    const openButton = h('button', { class: 'btn primary', text: t('newChatOpen'), onclick: () => void open() })
    const open = async (): Promise<void> => {
      // логин и email разводим по наличию «@»; discover зовём один раз —
      // по этому нажатию, а не на каждый символ (лимит 20/сутки на аккаунт)
      if (busy) return
      const target = classifyNewChat(input.value)
      if (target.kind === 'invalid') {
        error.textContent = 'логин: 3–32 символа, a–z, 0–9, _ и -'
        error.classList.remove('hidden')
        input.focus()
        return
      }
      if (target.kind === 'login') {
        if (target.login === this.host.ctx.session?.login) {
          error.textContent = 'это ваш собственный логин'
          error.classList.remove('hidden')
          return
        }
        controller.close()
        void this.host.openChat(target.login)
        return
      }
      const session = this.host.ctx.session
      if (!session) {
        error.textContent = t('newChatNotFound')
        error.classList.remove('hidden')
        return
      }
      busy = true
      openButton.setAttribute('disabled', '')
      try {
        // один хэш за запрос: сервер отдаёт логин по email_hashes
        const matches = await session.api.discover(session.token, [await emailHash(target.email)])
        const login = matches[0]?.login ?? ''
        if (!login) {
          error.textContent = t('newChatNotFound')
          error.classList.remove('hidden')
          return
        }
        controller.close()
        void this.host.openChat(login)
      } catch (e) {
        error.textContent = this.host.errorMessage(e)
        error.classList.remove('hidden')
      } finally {
        busy = false
        openButton.removeAttribute('disabled')
      }
    }
    const controller = openModal({
      title: t('chatsNew'),
      content: h(
        'div',
        { class: 'form' },
        input,
        h('p', { class: 'field-hint', text: t('newChatTargetHint') }),
        error,
      ),
      actions: [
        h('button', { class: 'btn', text: t('cancel'), onclick: () => controller.close() }),
        openButton,
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
