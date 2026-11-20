// Диалог: шапка, лента с keyed-обновлением, реакции/опросы из снимка,
// композер, который НЕ пересоздаётся (фокус и каретка сохраняются),
// меню сообщения (long-press/⋯), поиск, баннер смены ключей.
import { h, keyedList, formatTime, formatDay, formatDuration, formatBytes, plural, avatarGradient } from '../dom.js'
import { icon, iconButton, type IconName } from '../icons.js'
import { t } from '../../i18n/ru.js'
import { previewOf, searchFeed, type FeedItem } from '../../domain/feed.js'
import { classifyItem, filterByTab, type SearchTab } from '../../domain/search-tabs.js'
import { KeyChangedError, type ChatSnapshot, type ChatSummary } from '../../domain/messenger.js'
import type { MessageRecord } from '../../store/journal.js'
import { reactionSummary } from '../../domain/reactions.js'
import {
  forwardableSelected,
  selectAllRefs,
  selectedItems,
  selectionTitle,
  toggleSelection,
} from '../../domain/selection.js'
import { buildExport, mediaIdsOf, parseExport, recordsOf, serializeExport } from '../../domain/chat-export.js'
import type { MediaInfo } from '../../protocol/formats.js'
import type { AppHost } from '../host.js'
import { avatar } from '../components/avatar.js'
import { snackbar } from '../components/snackbar.js'
import { confirmModal, openModal } from '../components/modal.js'
import { openMessageMenu } from '../components/message-menu.js'
import { audioUrl, imageUrl, prepareFile, preparePhoto, startVoiceRecording, thumbUrl, type VoiceRecording } from '../../media/media.js'

interface Entry {
  key: string
  separator?: string
  item?: FeedItem
  // позиция в серии сообщений одного автора — для «слитых» углов пузыря
  first?: boolean
  last?: boolean
}

export class DialogScreen {
  readonly element: HTMLElement
  private chatId: string
  private header = h('header', { class: 'topbar dialog-topbar' })
  private messages = h('div', { class: 'messages', id: 'messages', role: 'log', 'aria-live': 'polite' })
  private pinnedBar = h('div', { class: 'pinned-bar hidden' })
  private banner = h('div', { class: 'key-banner hidden' })
  private failedBar = h('div', { class: 'key-banner failed hidden' })
  private replyBar = h('div', { class: 'reply-bar hidden' })
  private searchRow = h('div', { class: 'search-row hidden' })
  private searchInput = h('input', { class: 'search', type: 'search', placeholder: t('searchInChat'), 'aria-label': t('searchInChat') })
  // табы типов результата поиска: фильтруют выдачу без новых запросов
  private tabsRow = h('div', { class: 'search-tabs hidden' })
  private searchTab: SearchTab | null = null
  private composer: HTMLElement
  private composerInput: HTMLTextAreaElement
  private sendButton: HTMLButtonElement
  private voiceBar = h('div', { class: 'voice-bar hidden' })
  private scrollButton = h('button', { class: 'scroll-bottom hidden', 'aria-label': t('newMessages'), onclick: () => this.scrollToBottom() })
  private query = ''
  private searchOpen = false
  private recording: VoiceRecording | null = null
  private recordingTimer: ReturnType<typeof setInterval> | null = null
  private mediaUrls = new Set<string>()
  private draftTimer: ReturnType<typeof setTimeout> | null = null
  private wasAtBottom = true
  private newCount = 0
  private replyTo: FeedItem | null = null
  private editTarget: FeedItem | null = null
  // мультивыбор сообщений (P-W7): режим выделения и выбранные ref'ы записей
  private selectionActive = false
  private selectedRefs: string[] = []
  private selectionBar = h('div', { class: 'selection-bar hidden' })
  private headerModeSelection = false
  private built = false

  constructor(
    private readonly host: AppHost,
    chatId: string,
  ) {
    this.chatId = chatId
    const composer = this.buildComposer()
    this.composer = composer.node
    this.composerInput = composer.input
    this.sendButton = composer.send
    this.element = h('main', { class: 'screen dialog-screen' })
    this.messages.addEventListener('scroll', () => this.onScroll())
    this.searchInput.addEventListener('input', () => {
      this.query = this.searchInput.value
      this.update()
    })
  }

  async open(chatId: string): Promise<void> {
    this.chatId = chatId
    this.built = false
    this.query = ''
    this.searchOpen = false
    this.searchTab = null
    this.replyTo = null
    this.editTarget = null
    // режим выделения не переносится на другой чат
    this.selectionActive = false
    this.selectedRefs = []
    const draft = (await this.host.ctx.drafts.get(chatId))?.text ?? ''
    this.composerInput.value = draft
    await this.host.refreshDialog()
    this.render()
    // рост считаем после монтажа: getComputedStyle на отцепленном узле пуст
    this.autoGrow()
    this.scrollToBottom(true)
  }

  dispose(): void {
    if (this.draftTimer) clearTimeout(this.draftTimer)
    if (this.recordingTimer) clearInterval(this.recordingTimer)
    this.recording?.cancel()
    for (const url of this.mediaUrls) URL.revokeObjectURL(url)
    this.mediaUrls.clear()
  }

  // ─── каркас ─────────────────────────────────────────────────────────────

  private render(): void {
    if (!this.built) {
      const header = this.buildHeader()
      this.element.replaceChildren(
        header,
        this.banner,
        this.failedBar,
        this.searchRow,
        this.tabsRow,
        this.pinnedBar,
        h('div', { class: 'messages-wrap' }, this.messages, this.scrollButton),
        this.selectionBar,
        this.replyBar,
        this.voiceBar,
        this.composer,
      )
      this.searchRow.appendChild(this.searchInput)
      this.built = true
    }
    this.update()
  }

  // шапка в двух режимах: обычный диалог и режим выделения (P-W7).
  // Перестраиваем только при смене режима — иначе терялся бы фокус поиска.
  private paintHeaderMode(): void {
    if (this.headerModeSelection !== this.selectionActive) {
      this.headerModeSelection = this.selectionActive
      if (!this.selectionActive) {
        this.buildHeader()
        return
      }
      const feed = this.host.state.snapshot?.feed ?? []
      const allRefs = selectAllRefs(feed)
      const allSelected = allRefs.length > 0 && allRefs.every((ref) => this.selectedRefs.includes(ref))
      this.header.replaceChildren(
        iconButton('close', t('cancel'), () => this.exitSelection(), { className: 'mobile-back' }),
        h('span', { class: 'dialog-title selection-title', text: selectionTitle(this.selectedRefs.length) }),
        h('button', {
          class: 'btn small',
          text: allSelected ? t('cancel') : t('selectAllMessages'),
          onclick: () => {
            // повторный тап по «Выбрать все» снимает выделение
            this.selectedRefs = allSelected ? [] : [...allRefs]
            this.update()
          },
        }),
      )
    }
    // счётчик и подпись «Выбрать все» обновляем и без смены режима
    const title = this.header.querySelector<HTMLElement>('.selection-title')
    if (title) title.textContent = selectionTitle(this.selectedRefs.length)
    const refsNow = selectAllRefs(this.host.state.snapshot?.feed ?? [])
    const allNow = refsNow.length > 0 && refsNow.every((ref) => this.selectedRefs.includes(ref))
    const allBtn = this.header.querySelector<HTMLElement>('.btn.small')
    if (allBtn) allBtn.textContent = allNow ? t('cancel') : t('selectAllMessages')
  }

  private buildHeader(): HTMLElement {
    this.header.replaceChildren()
    this.header.appendChild(iconButton('back', t('back'), () => this.host.showChats(), { className: 'mobile-back' }))
    this.header.appendChild(h('span', { class: 'dialog-avatar' }))
    const titleWrap = h('button', { class: 'dialog-title', onclick: () => this.showChatInfo() })
    titleWrap.appendChild(h('span', { class: 'chat-title' }))
    titleWrap.appendChild(h('span', { class: 'chat-sub' }))
    this.header.appendChild(titleWrap)
    this.header.appendChild(iconButton('phone', t('callIncoming'), () => void this.startCall()))
    this.header.appendChild(iconButton('search', t('searchInChat'), () => this.toggleSearch()))
    this.header.appendChild(iconButton('more', t('groupInfo'), (event) => void this.showChatMenu(event)))
    return this.header
  }

  private toggleSearch(): void {
    this.searchOpen = !this.searchOpen
    this.searchRow.classList.toggle('hidden', !this.searchOpen)
    if (this.searchOpen) this.searchInput.focus()
    else {
      this.query = ''
      this.searchInput.value = ''
      // поиск закрыт — табы и фильтр снимаются
      this.searchTab = null
    }
    this.update()
  }

  // ─── обновление ─────────────────────────────────────────────────────────

  update(): void {
    // до первой сборки DOM обновлять нечего: иначе querySelector даёт null
    if (!this.built) return
    const state = this.host.state
    const summary = state.summaries.find((chat) => chat.chatId === this.chatId)
    const snapshot = state.snapshot
    this.paintHeader(summary, state.connected)
    this.paintKeyBanner(state.reverify)
    this.paintFailed()
    this.paintPinned(summary, snapshot)
    this.paintReplyBar()
    this.paintSelectionBar()
    this.paintHeaderMode()
    this.paintTabs()
    this.paintMessages(snapshot)
    this.paintVoiceButton()
  }

  private paintHeader(summary: ChatSummary | undefined, connected: boolean): void {
    const seed = summary?.isGroup ? summary.group?.name ?? this.chatId : this.chatId
    const slot = this.header.querySelector<HTMLElement>('.dialog-avatar')
    if (!slot) return
    if (slot.dataset.seed !== seed) {
      slot.dataset.seed = seed
      slot.replaceChildren(avatar(seed, { size: 40, isGroup: summary?.isGroup }))
    }
    this.header.querySelector('.chat-title')!.textContent = summary?.title ?? this.chatId
    const sub = this.header.querySelector('.chat-sub')!
    if (summary?.typing) {
      sub.textContent = t('typing')
      sub.classList.add('typing')
    } else if (summary?.isGroup && summary.group) {
      sub.textContent = `${summary.group.members.length} ${plural(summary.group.members.length, 'участник', 'участника', 'участников')}`
      sub.classList.remove('typing')
    } else {
      const presence = this.host.state.presence
      sub.textContent = presence ? (presence.online ? t('online') : `${t('offline')} ${formatDay(presence.lastSeen)}`) : connected ? '' : t('offline')
      sub.classList.remove('typing')
    }
  }

  // недоставленные сообщения: красный индикатор с «Повторить/Удалить»
  private paintFailed(): void {
    const failed = this.host.state.failedSends.filter((entry) => entry.chatId === this.chatId)
    if (failed.length === 0) {
      this.failedBar.classList.add('hidden')
      this.failedBar.replaceChildren()
      return
    }
    this.failedBar.classList.remove('hidden')
    const messenger = this.host.ctx.messenger
    this.failedBar.replaceChildren(
      icon('alert', { size: 20 }),
      h('span', { class: 'key-banner-text', text: `${t('sendFailed')}: ${failed[0].lastError ?? ''}` }),
      h('button', {
        class: 'btn small primary',
        text: t('retry'),
        onclick: async () => {
          await messenger?.retrySend(failed[0].key)
          await this.host.refreshDialog()
        },
      }),
      h('button', {
        class: 'btn small',
        text: t('delete'),
        onclick: async () => {
          for (const entry of failed) await messenger?.dropSend(entry.key)
          await this.host.refreshDialog()
        },
      }),
    )
  }

  private paintKeyBanner(reverify: { devices: string[]; isNewDevice: boolean } | null): void {
    if (!reverify) {
      this.banner.classList.add('hidden')
      return
    }
    this.banner.classList.remove('hidden')
    this.banner.replaceChildren(
      icon('alert', { size: 20 }),
      h('span', { class: 'key-banner-text', text: `${t('safetyChangedTitle')}: ${reverify.isNewDevice ? t('safetyChangedNew') : ''}`.trim() }),
      h('button', {
        class: 'btn small primary',
        text: t('safetySendAnyway'),
        onclick: async () => {
          await this.host.ctx.messenger?.trustPeer(this.chatId)
          await this.host.refreshDialog()
        },
      }),
    )
  }

  private paintPinned(summary: ChatSummary | undefined, snapshot: ChatSnapshot | null): void {
    const pinned = snapshot?.feed.filter((item) => item.pinned) ?? []
    this.pinnedBar.classList.toggle('hidden', pinned.length === 0)
    if (pinned.length === 0) return
    const last = pinned[pinned.length - 1]
    this.pinnedBar.replaceChildren(
      icon('pin', { size: 18 }),
      h('span', { class: 'pinned-text', text: previewOf(last).slice(0, 120) }),
      h('button', { class: 'btn small', text: t('jumpToMessage'), onclick: () => this.highlight(last) }),
    )
    void summary
  }

  private paintReplyBar(): void {
    const target = this.editTarget ?? this.replyTo
    this.replyBar.classList.toggle('hidden', !target)
    if (!target) return
    this.replyBar.replaceChildren(
      h('div', { class: 'reply-info' }, h('b', { text: this.editTarget ? t('messageEdit') : t('messageReply') }), h('span', { text: plainText(target).slice(0, 120) })),
      iconButton('close', t('cancel'), () => {
        this.replyTo = null
        this.editTarget = null
        this.paintReplyBar()
        this.composerInput.focus()
      }),
    )
  }

  // табы типов результата видны только при непустом запросе в поиске;
  // повторный тап по активному табу снимает фильтр
  private paintTabs(): void {
    const active = Boolean(this.searchOpen && this.query.trim())
    if (!active) {
      if (!this.tabsRow.classList.contains('hidden')) {
        if (this.tabsRow.childElementCount > 0) this.tabsRow.replaceChildren()
        this.tabsRow.classList.add('hidden')
      }
      return
    }
    const tabs: Array<[SearchTab, string]> = [
      ['messages', t('searchTabMessages')],
      ['media', t('searchTabMedia')],
      ['links', t('searchTabLinks')],
      ['files', t('searchTabFiles')],
    ]
    this.tabsRow.replaceChildren(
      ...tabs.map(([tab, label]) =>
        h('button', {
          class: `search-tab${this.searchTab === tab ? ' active' : ''}`,
          type: 'button',
          text: label,
          'data-tab': tab,
          onclick: () => {
            // повторный тап по активному табу снимает фильтр
            this.searchTab = this.searchTab === tab ? null : tab
            this.update()
          },
        }),
      ),
    )
    this.tabsRow.classList.remove('hidden')
  }

  private paintMessages(snapshot: ChatSnapshot | null): void {
    const feed = snapshot?.feed ?? []
    const filtered = this.query.trim() ? searchFeed(feed, this.query) : feed
    const byTab = filterByTab(filtered, this.searchTab, classifyItem)
    const entries = this.withSeparators(byTab)
    const snapshotNow = snapshot
    keyedList(
      this.messages,
      entries,
      (entry) => entry.key,
      (entry) => (entry.separator ? this.separatorNode(entry.separator) : this.messageNode(entry)),
      (node, entry) => {
        // классы серии зависят от соседей: обновляем и на переиспользованном узле
        if (entry.item) {
          node.classList.toggle('first', !!entry.first)
          node.classList.toggle('last', !!entry.last)
          if (snapshotNow) this.paintMessage(node, entry.item, snapshotNow)
        }
      },
    )
    if (this.query.trim() && byTab.length === 0) {
      if (this.messages.childElementCount === 0) this.messages.appendChild(h('p', { class: 'empty-state', text: t('searchEmpty') }))
    }
    this.updateScrollButton()
  }

  private withSeparators(feed: FeedItem[]): Entry[] {
    const out: Entry[] = []
    let lastDay = ''
    let prev: Entry | undefined
    for (const item of feed) {
      const day = formatDay(item.timestamp)
      if (day !== lastDay) {
        out.push({ key: `sep:${day}:${item.ref}`, separator: day })
        lastDay = day
        prev = undefined
      }
      const entry: Entry = { key: item.ref, item }
      // серия — подряд идущие сообщения одного автора; системные и разделитель дня её рвут
      const sameSeries =
        !!prev &&
        !isSystemItem(prev.item!) &&
        !isSystemItem(item) &&
        prev.item!.mine === item.mine &&
        prev.item!.record.from === item.record.from
      if (!sameSeries && prev) prev.last = true
      if (!sameSeries) entry.first = true
      out.push(entry)
      prev = entry
    }
    if (prev) prev.last = true
    return out
  }

  private separatorNode(label: string): HTMLElement {
    return h('div', { class: 'day-separator' }, h('span', { text: label }))
  }

  // ─── сообщение ──────────────────────────────────────────────────────────

  private messageNode(entry: Entry): HTMLElement {
    const item = entry.item!
    const series = `${entry.first ? ' first' : ''}${entry.last ? ' last' : ''}`
    const node = h('div', { class: `message ${item.mine ? 'mine' : 'theirs'}${series}` })
    node.dataset.ref = item.ref
    const group = item.parsed.kind === 'content' ? item.parsed.group : undefined
    if (group && !item.mine) node.appendChild(h('div', { class: 'author' }))
    // мета времени живёт внутри пузыря правым нижним углом
    const bubble = h('div', { class: 'bubble' }, h('div', { class: 'bubble-body' }))
    bubble.appendChild(h('div', { class: 'meta' }, h('span', { class: 'meta-time' }), h('span', { class: 'meta-status' })))
    node.appendChild(bubble)
    node.appendChild(h('div', { class: 'reactions hidden' }))
    // галка выделения (P-W7): видна только в режиме выбора — класс на узле
    node.appendChild(h('span', { class: 'msg-check' }, icon('check', { size: 16 })))

    // long-press (pointer) + contextmenu: меню доступно и на iOS
    let pressTimer: ReturnType<typeof setTimeout> | null = null
    const startPress = (x: number, y: number): void => {
      pressTimer = setTimeout(() => {
        pressTimer = null
        if (this.selectionActive) return
        this.openMenu(item, { x, y })
      }, 450)
    }
    const cancelPress = (): void => {
      if (pressTimer) clearTimeout(pressTimer)
      pressTimer = null
    }
    node.addEventListener('pointerdown', (event) => {
      if ((event.target as HTMLElement).closest('.reaction, .poll-option, .voice-player, .media-file')) return
      startPress(event.clientX, event.clientY)
      this.trackSwipe(node, event, item)
    })
    node.addEventListener('pointerup', cancelPress)
    node.addEventListener('pointercancel', cancelPress)
    node.addEventListener('pointermove', (event) => {
      if (Math.abs(event.clientX - this.swipeStartX) > 8) cancelPress()
    })
    node.addEventListener('contextmenu', (event) => {
      event.preventDefault()
      this.openMenu(item, { x: (event as MouseEvent).clientX, y: (event as MouseEvent).clientY })
    })
    node.addEventListener('click', (event) => {
      if ((event.target as HTMLElement).closest('button, a')) return
      // в режиме выделения тап переключает выбор, а не открывает меню
      if (this.selectionActive) {
        this.toggleSelect(item.ref)
        return
      }
      this.openMenu(item, { x: (event as MouseEvent).clientX, y: (event as MouseEvent).clientY })
    })
    return node
  }

  private swipeStartX = 0
  private trackSwipe(node: HTMLElement, event: PointerEvent, item: FeedItem): void {
    this.swipeStartX = event.clientX
    const onUp = (up: PointerEvent): void => {
      node.removeEventListener('pointerup', onUp)
      const delta = up.clientX - this.swipeStartX
      if (delta > 60 && Math.abs(up.clientY - event.clientY) < 40) {
        this.replyTo = item
        this.editTarget = null
        this.paintReplyBar()
        this.composerInput.focus()
      }
    }
    node.addEventListener('pointerup', onUp)
  }

  private paintMessage(node: HTMLElement, item: FeedItem, snapshot: ChatSnapshot): void {
    node.classList.toggle('sending', item.sending)
    node.classList.toggle('system', item.kind?.kind === 'system')
    // мультивыбор (P-W7): галка и подсветка выбранного
    node.classList.toggle('selecting', this.selectionActive)
    node.classList.toggle('selected', this.selectedRefs.includes(item.ref))
    const group = item.parsed.kind === 'content' ? item.parsed.group : undefined
    const author = node.querySelector<HTMLElement>('.author')
    if (author) {
      author.textContent = item.record.from
      const gradient = avatarGradient(item.record.from)
      author.style.color = gradient.from
    }
    const body = node.querySelector<HTMLElement>('.bubble-body')!
    this.paintBody(body, item)
    const meta = node.querySelector('.meta')!
    meta.querySelector('.meta-time')!.textContent = formatTime(item.timestamp)
    const status = meta.querySelector('.meta-status')!
    status.replaceChildren()
    if (item.sending) {
      status.appendChild(h('span', { class: 'tick sending', title: t('sending') }, icon('clock', { size: 14 })))
    } else if (item.mine) {
      const read = snapshot.peerReadAt >= item.timestamp
      const delivered = snapshot.peerDeliveredAt >= item.timestamp
      status.appendChild(h('span', { class: `tick${read ? ' read' : delivered ? ' delivered' : ''}`, title: read ? 'прочитано' : delivered ? 'доставлено' : 'отправлено' }, icon(read || delivered ? 'checks' : 'check', { size: 14 })))
    }
    this.paintReactions(node, item, snapshot)
    void group
  }

  private paintBody(body: HTMLElement, item: FeedItem): void {
    const kind = item.kind
    body.replaceChildren()
    if (item.parsed.kind === 'content' && item.parsed.content.kind === 'system') {
      const system = item.parsed.content
      body.appendChild(h('div', { class: 'system-pill' }, system.call ? system.call.status === 'missed' ? `Пропущенный звонок` : `Звонок` : system.change ? describeChange(system.change) : system.text))
      return
    }
    if (kind?.kind === 'text') {
      body.appendChild(h('div', { class: 'text', text: kind.text }))
      if (kind.edited) body.appendChild(h('span', { class: 'edited', text: t('editedMark') }))
    } else if (kind?.kind === 'reply') {
      // пересылка едет REPLY-конвертом без цитаты — показываем только атрибуцию
      if (!kind.reply.author && !kind.reply.quote && kind.reply.fwd) body.appendChild(forwardedFrom(kind.reply.fwd))
      const quote = h('button', { class: 'quote', onclick: () => this.jumpTo(kind.reply.targetRef, kind.reply.targetTs) })
      quote.appendChild(h('b', { text: kind.reply.author || '' }))
      quote.appendChild(h('span', { text: kind.reply.quote }))
      body.appendChild(quote)
      body.appendChild(h('div', { class: 'text', text: kind.reply.text }))
    } else if (kind?.kind === 'media') {
      if (kind.info.forwardFrom) body.appendChild(forwardedFrom(kind.info.forwardFrom))
      body.appendChild(this.mediaNode(kind.info, item))
    } else if (kind?.kind === 'poll') {
      body.appendChild(this.pollNode(kind.poll, item))
    } else if (kind?.kind === 'contact') {
      body.appendChild(h('div', { class: 'text', text: `@${kind.login}` }))
      body.appendChild(h('button', { class: 'btn small', text: `Открыть @${kind.login}`, onclick: () => void this.host.openChat(kind.login) }))
    } else if (kind?.kind === 'geo') {
      body.appendChild(h('div', { class: 'text', text: `${kind.lat.toFixed(5)}, ${kind.lng.toFixed(5)}` }))
      body.appendChild(
        h('a', { class: 'btn small', href: `https://www.openstreetmap.org/?mlat=${kind.lat}&mlon=${kind.lng}#map=17/${kind.lat}/${kind.lng}`, target: '_blank', rel: 'noreferrer', text: 'Открыть карту' }),
      )
    } else if (kind?.kind === 'system') {
      body.appendChild(h('div', { class: 'system-pill', text: kind.call ? (kind.call.status === 'missed' ? 'Пропущенный звонок' : 'Звонок') : kind.change ? describeChange(kind.change) : kind.text }))
    } else {
      body.appendChild(h('div', { class: 'text muted', text: t('unsupported') }))
    }
  }

  private paintReactions(node: HTMLElement, item: FeedItem, snapshot: ChatSnapshot): void {
    const container = node.querySelector<HTMLElement>('.reactions')!
    const state = snapshot.reactions.get(item.ref) ?? snapshot.reactions.get(`ts:${item.timestamp}`)
    const summary = state ? reactionSummary(state, 4) : []
    container.classList.toggle('hidden', summary.length === 0)
    if (summary.length === 0) {
      container.replaceChildren()
      return
    }
    container.replaceChildren(
      ...summary.map((entry) =>
        h('button', {
          class: `reaction${state?.mine === entry.emoji ? ' mine' : ''}`,
          text: `${entry.emoji} ${entry.count}`,
          onclick: async () => {
            await this.host.ctx.messenger?.react(this.chatId, { ref: item.ref, ts: item.timestamp }, state?.mine === entry.emoji ? '' : entry.emoji)
            await this.host.refreshDialog()
          },
        }),
      ),
    )
  }

  // ─── медиа ──────────────────────────────────────────────────────────────

  private mediaNode(info: MediaInfo, item: FeedItem): HTMLElement {
    const messenger = this.host.ctx.messenger
    if (info.type === 'voice') return this.voiceNode(info)
    if (info.type === 'file') {
      const node = h('div', { class: 'media-file' })
      node.appendChild(icon('file', { size: 22 }))
      node.appendChild(h('div', { class: 'file-meta' }, h('div', { class: 'file-name', text: info.name ?? t('file') }), h('div', { class: 'muted', text: formatBytes(info.size) })))
      node.appendChild(
        h('button', {
          class: 'btn small',
          text: t('download'),
          onclick: async () => {
            const data = await messenger?.ensureMedia(info)
            if (!data) return snackbar(t('downloadFailed'), { kind: 'error' })
            const url = URL.createObjectURL(new Blob([data as unknown as BlobPart], { type: info.mime ?? 'application/octet-stream' }))
            this.mediaUrls.add(url)
            const link = h('a', { href: url, download: info.name ?? 'file' })
            link.click()
          },
        }),
      )
      return node
    }
    const ratio = info.width && info.height ? `${info.width} / ${info.height}` : '1 / 1'
    const img = h('img', {
      class: `photo${info.spoiler ? ' spoiler' : ''}`,
      src: info.thumb ? thumbUrl(info.thumb) : '',
      alt: t('photo'),
      loading: 'lazy',
      style: `aspect-ratio:${ratio}`,
    })
    img.addEventListener('click', async () => {
      if (info.spoiler && !img.classList.contains('revealed')) {
        img.classList.add('revealed')
        img.classList.remove('spoiler')
        return
      }
      const data = await messenger?.ensureMedia(info)
      if (!data) return snackbar(t('downloadFailed'), { kind: 'error' })
      const url = imageUrl(data)
      this.mediaUrls.add(url)
      openModal({ content: h('img', { class: 'lightbox-img', src: url, alt: t('photo') }) })
    })
    const node = h('div', { class: 'media-photo' }, img)
    if (item.mine) node.appendChild(h('div', { class: 'muted media-size', text: formatBytes(info.size) }))
    return node
  }

  private voiceNode(info: MediaInfo): HTMLElement {
    const messenger = this.host.ctx.messenger
    const bars = h('div', { class: 'waveform' })
    const waveform = info.waveform ?? new Uint8Array()
    const barCount = 40
    for (let i = 0; i < barCount; i++) {
      const value = waveform.length > 0 ? waveform[Math.floor((i / barCount) * waveform.length)] ?? 0 : 60
      bars.appendChild(h('span', { style: `height:${Math.max(8, Math.round((value / 255) * 100))}%` }))
    }
    let audio: HTMLAudioElement | null = null
    let url = ''
    const time = h('span', { class: 'voice-time', text: formatDuration(info.duration) })
    const speeds = [1, 1.5, 2]
    let speedIndex = 0
    const speedBtn = h('button', { class: 'btn small', text: '1×', onclick: () => {
      speedIndex = (speedIndex + 1) % speeds.length
      speedBtn.textContent = `${speeds[speedIndex]}×`
      if (audio) audio.playbackRate = speeds[speedIndex]
    } })
    const playBtn = h('button', { class: 'voice-play', 'aria-label': 'play', onclick: async () => {
      if (!audio) {
        const data = await messenger?.ensureMedia(info)
        if (!data) return snackbar(t('downloadFailed'), { kind: 'error' })
        url = audioUrl(data)
        this.mediaUrls.add(url)
        audio = new Audio(url)
        audio.addEventListener('timeupdate', () => {
          if (!audio || !audio.duration) return
          const progress = audio.currentTime / audio.duration
          bars.style.setProperty('--progress', `${Math.round(progress * 100)}%`)
          time.textContent = formatDuration(audio.currentTime)
        })
        audio.addEventListener('ended', () => {
          playBtn.replaceChildren(icon('play', { size: 20 }))
          bars.style.setProperty('--progress', '0%')
          time.textContent = formatDuration(info.duration)
        })
      }
      if (audio.paused) {
        audio.playbackRate = speeds[speedIndex]
        void audio.play()
        playBtn.replaceChildren(icon('pause', { size: 20 }))
      } else {
        audio.pause()
        playBtn.replaceChildren(icon('play', { size: 20 }))
      }
    } }, icon('play', { size: 20 }))
    return h('div', { class: 'voice-player' }, playBtn, bars, time, speedBtn)
  }

  private pollNode(poll: NonNullable<Extract<FeedItem['kind'], { kind: 'poll' }>>['poll'], item: FeedItem): HTMLElement {
    const node = h('div', { class: 'poll' })
    node.appendChild(h('div', { class: 'poll-question', text: poll.question }))
    const options = h('div', { class: 'poll-options' })
    node.appendChild(options)
    const state = this.host.state.snapshot?.polls.get(item.ref)
    const total = state?.votes.size ?? 0
    poll.options.forEach((option, index) => {
      const count = state?.counts[index] ?? 0
      const share = total > 0 ? Math.round((count / total) * 100) : 0
      const button = h('button', { class: `poll-option${state?.mine === index ? ' mine' : ''}`, disabled: state?.closed })
      button.appendChild(h('span', { class: 'poll-option-text', text: option }))
      button.appendChild(h('span', { class: 'poll-option-count', text: `${count} · ${share}%` }))
      button.appendChild(h('span', { class: 'poll-option-fill', style: `width:${share}%` }))
      button.addEventListener('click', async () => {
        await this.host.ctx.messenger?.vote(this.chatId, item.ref, index)
        await this.host.refreshDialog()
      })
      options.appendChild(button)
    })
    const isAuthor = item.mine
    if (isAuthor && !state?.closed) {
      node.appendChild(h('button', { class: 'btn small', text: t('pollStop'), onclick: async () => {
        await this.host.ctx.messenger?.vote(this.chatId, item.ref, -1, true)
        await this.host.refreshDialog()
      } }))
    }
    if (state?.closed) node.appendChild(h('p', { class: 'muted', text: t('pollStopped') }))
    return node
  }

  // ─── композер ───────────────────────────────────────────────────────────

  private buildComposer(): { node: HTMLElement; input: HTMLTextAreaElement; send: HTMLButtonElement } {
    const input = h('textarea', { class: 'composer-input', rows: 1, placeholder: t('messagePlaceholder'), 'aria-label': t('messagePlaceholder') })
    input.addEventListener('input', () => {
      this.autoGrow()
      void this.host.ctx.messenger?.sendTyping(this.chatId)
      this.saveDraft()
      this.paintVoiceButton()
    })
    input.addEventListener('keydown', (event) => {
      if ((event as KeyboardEvent).key === 'Enter' && !(event as KeyboardEvent).shiftKey) {
        event.preventDefault()
        void this.send()
      }
      if ((event as KeyboardEvent).key === 'Escape' && (this.replyTo || this.editTarget)) {
        this.replyTo = null
        this.editTarget = null
        this.paintReplyBar()
      }
    })
    const photoInput = h('input', { type: 'file', accept: 'image/*', class: 'hidden' })
    photoInput.addEventListener('change', () => {
      const file = photoInput.files?.[0]
      if (file) void this.sendPrepared(file, 'photo')
      photoInput.value = ''
    })
    const fileInput = h('input', { type: 'file', class: 'hidden' })
    fileInput.addEventListener('change', () => {
      const file = fileInput.files?.[0]
      if (file) void this.sendPrepared(file, 'file')
      fileInput.value = ''
    })
    const attachButton = iconButton('attach', t('attach'), (event) => this.openAttachMenu(event))
    const send = h('button', { class: 'composer-send', 'aria-label': t('send'), onclick: () => void this.send() }, icon('send', { size: 22 }))
    const voice = h('button', { class: 'composer-voice', 'aria-label': t('voiceRecord'), onclick: () => void this.toggleVoice() }, icon('mic', { size: 22 }))
    const node = h('div', { class: 'composer' }, attachButton, input, send, voice, photoInput, fileInput)
    this.voiceBar.replaceChildren(
      h('span', { class: 'rec-dot' }),
      h('span', { class: 'rec-time', text: '0:00' }),
      h('span', { class: 'rec-hint muted', text: `${t('voiceCancel')} · ${t('voiceLock')}` }),
      h('button', { class: 'btn small', text: t('cancel'), onclick: () => this.cancelVoice() }),
      h('button', { class: 'btn small primary', text: t('send'), onclick: () => void this.finishVoice() }),
    )
    return { node, input, send }
  }

  private openAttachMenu(event: MouseEvent): void {
    const item = (label: string, name: Parameters<typeof icon>[0], action: () => void): HTMLElement =>
      h('button', { class: 'menu-item', onclick: () => { controller.close(); action() } }, icon(name, { size: 20 }), label)
    const controller = openModal({
      content: h(
        'div',
        { class: 'menu-list' },
        item(t('attachPhoto'), 'image', () => this.composer.querySelectorAll<HTMLInputElement>('input[type=file]')[0]?.click()),
        item(t('attachFile'), 'file', () => this.composer.querySelectorAll<HTMLInputElement>('input[type=file]')[1]?.click()),
        item(t('attachGeo'), 'location', () => void this.sendGeo()),
        item(t('attachPoll'), 'poll', () => void this.createPoll()),
      ),
    })
    void event
  }

  private paintVoiceButton(): void {
    const empty = this.composerInput.value.trim().length === 0
    this.sendButton.classList.toggle('hidden', empty)
    this.composer.querySelector('.composer-voice')?.classList.toggle('hidden', !empty)
  }

  private autoGrow(): void {
    const el = this.composerInput
    const style = getComputedStyle(el)
    const pad =
      (parseFloat(style.paddingTop) || COMPOSER_CHROME / 2) +
      (parseFloat(style.paddingBottom) || COMPOSER_CHROME / 2)
    const border =
      (parseFloat(style.borderTopWidth) || COMPOSER_BORDER) +
      (parseFloat(style.borderBottomWidth) || COMPOSER_BORDER)
    const line = parseFloat(style.lineHeight) || COMPOSER_LINE
    el.style.height = 'auto'
    // scroll_height включает padding, но не рамку; у пустого textarea он
    // завышен (примерно две строки) — тогда берём высоту одной строки
    const content = el.value ? el.scrollHeight - pad : line
    el.style.height = `${composerBoxHeight(content, line, pad + border)}px`
  }

  private saveDraft(): void {
    if (this.draftTimer) clearTimeout(this.draftTimer)
    const value = this.composerInput.value
    this.draftTimer = setTimeout(() => void this.host.ctx.messenger?.setDraft(this.chatId, value), 800)
  }

  private async send(): Promise<void> {
    const value = this.composerInput.value.trim()
    if (!value) return
    if (value.length > 4096) return snackbar(t('errorTooLong'), { kind: 'error' })
    const messenger = this.host.ctx.messenger
    const editTarget = this.editTarget
    const replyTo = this.replyTo
    this.composerInput.value = ''
    this.autoGrow()
    this.paintVoiceButton()
    this.editTarget = null
    this.replyTo = null
    this.paintReplyBar()
    if (this.draftTimer) {
      clearTimeout(this.draftTimer)
      this.draftTimer = null
    }
    if (!editTarget) void messenger?.setDraft(this.chatId, '')
    try {
      if (editTarget) {
        await messenger?.editMessage(this.chatId, editTarget.record, value)
      } else {
        await messenger?.sendText(this.chatId, value, {
          replyTo: replyTo ? { ref: replyTo.ref, author: replyTo.record.from, quote: plainText(replyTo).slice(0, 200), ts: replyTo.timestamp } : undefined,
        })
      }
    } catch (error) {
      // текст НЕ возвращаем в поле: запись уже лежит в журнале и видна в
      // ленте с отметкой «не отправлено» — возврат привёл бы к дублю
      if (error instanceof KeyChangedError) snackbar(error.isNewDevice ? t('safetyChangedNew') : t('safetyChangedTitle'), { kind: 'error' })
      else snackbar(this.host.errorMessage(error), { kind: 'error' })
    }
    await this.host.refreshDialog()
  }

  private async sendPrepared(file: File, kind: 'photo' | 'file'): Promise<void> {
    const messenger = this.host.ctx.messenger
    if (!messenger) return
    try {
      const prepared = kind === 'photo' ? await preparePhoto(file) : await prepareFile(file)
      const { encryptBlob } = await import('../../media/media.js')
      const { blob, key } = await encryptBlob(prepared.plain)
      const mediaId = await messenger.uploadMedia(blob)
      await messenger.sendMedia(this.chatId, { ...prepared.info, id: mediaId, key, size: prepared.plain.length })
    } catch (error) {
      snackbar(this.host.errorMessage(error), { kind: 'error' })
    }
    await this.host.refreshDialog()
  }

  private async toggleVoice(): Promise<void> {
    if (this.recording) return this.finishVoice()
    try {
      this.recording = await startVoiceRecording(() => snackbar(t('voiceTooLong')))
      this.voiceBar.classList.remove('hidden')
      this.composer.classList.add('recording')
      const startedAt = this.recording.startedAt
      this.recordingTimer = setInterval(() => {
        const seconds = Math.round((Date.now() - startedAt) / 1000)
        this.voiceBar.querySelector('.rec-time')!.textContent = formatDuration(seconds)
      }, 500)
    } catch {
      snackbar('нет доступа к микрофону', { kind: 'error' })
    }
  }

  private cancelVoice(): void {
    this.recording?.cancel()
    this.recording = null
    if (this.recordingTimer) clearInterval(this.recordingTimer)
    this.recordingTimer = null
    this.voiceBar.classList.add('hidden')
    this.composer.classList.remove('recording')
  }

  private async finishVoice(): Promise<void> {
    const recording = this.recording
    if (!recording) return
    this.recording = null
    if (this.recordingTimer) clearInterval(this.recordingTimer)
    this.recordingTimer = null
    this.voiceBar.classList.add('hidden')
    this.composer.classList.remove('recording')
    try {
      const result = await recording.stop()
      const messenger = this.host.ctx.messenger
      if (!messenger) return
      const { encryptBlob } = await import('../../media/media.js')
      const { blob, key } = await encryptBlob(result.data)
      const mediaId = await messenger.uploadMedia(blob)
      await messenger.sendMedia(this.chatId, {
        id: mediaId,
        key,
        size: result.data.length,
        width: 0,
        height: 0,
        thumb: '',
        type: 'voice',
        duration: result.duration,
        waveform: result.waveform,
        spoiler: false,
        sticker: false,
        videoNote: false,
        silent: false,
        viewOnce: false,
      })
    } catch (error) {
      snackbar(this.host.errorMessage(error), { kind: 'error' })
    }
    await this.host.refreshDialog()
  }

  private async sendGeo(): Promise<void> {
    if (!navigator.geolocation) return snackbar('браузер не даёт геопозицию', { kind: 'error' })
    navigator.geolocation.getCurrentPosition(
      async (position) => {
        await this.host.ctx.messenger?.sendGeo(this.chatId, position.coords.latitude, position.coords.longitude)
        await this.host.refreshDialog()
      },
      () => snackbar('доступ к геопозиции отклонён', { kind: 'error' }),
      { timeout: 15_000 },
    )
  }

  private async createPoll(): Promise<void> {
    const question = h('input', { type: 'text', placeholder: t('pollQuestion') })
    const options = h('div', { class: 'poll-builder' })
    const addOption = (): void => {
      const row = h('div', { class: 'row' })
      const input = h('input', { type: 'text', placeholder: `${t('pollOptions')} ${options.childElementCount + 1}` })
      row.appendChild(input)
      if (options.childElementCount >= 2) {
        row.appendChild(iconButton('close', t('delete'), () => row.remove()))
      }
      options.appendChild(row)
    }
    addOption()
    addOption()
    const error = h('p', { class: 'field-error hidden' })
    const controller = openModal({
      title: t('pollCreate'),
      content: h('div', { class: 'form' }, question, options, h('button', { class: 'btn small', text: t('pollAddOption'), onclick: addOption }), error),
      actions: [
        h('button', { class: 'btn', text: t('cancel'), onclick: () => controller.close() }),
        h('button', {
          class: 'btn primary',
          text: t('save'),
          onclick: async () => {
            const values = Array.from(options.querySelectorAll('input'))
              .map((input) => input.value.trim())
              .filter(Boolean)
            if (!question.value.trim() || values.length < 2) {
              error.textContent = t('pollMinOptions')
              error.classList.remove('hidden')
              return
            }
            controller.close()
            await this.host.ctx.messenger?.sendPoll(this.chatId, question.value.trim(), values, false)
            await this.host.refreshDialog()
          },
        }),
      ],
    })
  }

  // ─── прокрутка и поиск ──────────────────────────────────────────────────

  private onScroll(): void {
    const el = this.messages
    this.wasAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    if (this.wasAtBottom) this.newCount = 0
    this.updateScrollButton()
  }

  private updateScrollButton(): void {
    this.scrollButton.classList.toggle('hidden', this.wasAtBottom && this.newCount === 0)
    this.scrollButton.textContent = this.newCount > 0 ? `${this.newCount} ${t('newMessages')}` : '↓'
  }

  scrollToBottom(instant = false): void {
    this.messages.scrollTo({ top: this.messages.scrollHeight, behavior: instant ? 'auto' : 'smooth' })
    this.wasAtBottom = true
    this.newCount = 0
    this.updateScrollButton()
  }

  private highlight(item: FeedItem): void {
    const node = this.messages.querySelector<HTMLElement>(`[data-ref="${item.ref}"]`)
    if (!node) return
    node.scrollIntoView({ behavior: 'smooth', block: 'center' })
    node.classList.add('highlight')
    setTimeout(() => node.classList.remove('highlight'), 1_500)
  }

  private jumpTo(ref?: string, ts?: number): void {
    const target = this.host.state.snapshot?.feed.find((item) => (ref ? item.ref === ref : item.timestamp === ts))
    if (target) this.highlight(target)
  }

  // ─── мультивыбор (P-W7) ────────────────────────────────────────────────

  // режим выделения: вход с первого тапнутого сообщения
  private enterSelection(ref?: string): void {
    this.selectionActive = true
    this.selectedRefs = ref ? [ref] : []
    this.update()
  }

  private exitSelection(): void {
    this.selectionActive = false
    this.selectedRefs = []
    this.update()
  }

  private toggleSelect(ref: string): void {
    this.selectedRefs = toggleSelection(this.selectedRefs, ref)
    this.update()
  }

  // пересылка выделенного: выбор чата и отправка штатным механизмом протокола
  private async forwardSelected(): Promise<void> {
    const items = selectedItems(this.currentFeed(), this.selectedRefs)
    await this.forwardItems(items)
  }

  private async forwardItems(items: FeedItem[]): Promise<void> {
    const messenger = this.host.ctx.messenger
    const records = forwardableSelected(items).map((item) => item.record)
    if (!messenger || records.length === 0) return snackbar(t('forwardNothing'), { kind: 'error' })
    const chats = this.host.state.summaries.filter((chat) => chat.chatId !== this.chatId)
    if (chats.length === 0) return snackbar(t('chatsEmpty'), { kind: 'error' })
    const list = h(
      'div',
      { class: 'menu-list' },
      ...chats.map((chat) =>
        h('button', {
          class: 'menu-item',
          'data-chat': chat.chatId,
          onclick: () => {
            controller.close()
            void this.sendForward(records, chat.chatId)
          },
        }, icon(chat.isGroup ? 'users' : 'user', { size: 20 }), chat.title),
      ),
    )
    const controller = openModal({ title: t('forwardPickTitle'), content: list })
  }

  private async sendForward(records: MessageRecord[], target: string): Promise<void> {
    try {
      await this.host.ctx.messenger?.forwardMessages(target, records)
      snackbar(t('forwardSent'), { kind: 'success' })
      if (this.selectionActive) this.exitSelection()
      await this.host.refreshDialog()
    } catch (error) {
      snackbar(this.host.errorMessage(error), { kind: 'error' })
    }
  }

  // массовое удаление: своё — «удалить у всех», чужие — только локально
  private async deleteSelected(): Promise<void> {
    const items = selectedItems(this.currentFeed(), this.selectedRefs)
    if (items.length === 0) return
    const ok = await confirmModal({ title: t('deleteForAll'), message: t('selectionDeleteConfirm'), danger: true })
    if (!ok) return
    try {
      await this.host.ctx.messenger?.deleteMessages(this.chatId, items.map((item) => item.record))
      this.exitSelection()
      await this.host.refreshDialog()
    } catch (error) {
      snackbar(this.host.errorMessage(error), { kind: 'error' })
    }
  }


  private currentFeed(): FeedItem[] {
    return this.host.state.snapshot?.feed ?? []
  }

  private paintSelectionBar(): void {
    const count = this.selectedRefs.length
    const active = this.selectionActive && count > 0
    this.selectionBar.classList.toggle('hidden', !active)
    if (!active) {
      if (this.selectionBar.childElementCount > 0) this.selectionBar.replaceChildren()
      return
    }
    const messenger = this.host.ctx.messenger
    if (this.selectionBar.childElementCount === 0) {
      const forwardBtn = h('button', {
        class: 'btn small primary selection-action',
        'data-action': 'forward',
        onclick: () => void this.forwardSelected(),
      }, icon('forward', { size: 18 }), t('selectionForward'))
      const deleteBtn = h('button', {
        class: 'btn small danger selection-action',
        'data-action': 'delete',
        onclick: () => void this.deleteSelected(),
      }, icon('trash', { size: 18 }), t('selectionDelete'))
      forwardBtn.disabled = !messenger
      deleteBtn.disabled = !messenger
      this.selectionBar.replaceChildren(
        h('span', { class: 'selection-count', text: selectionTitle(count) }),
        forwardBtn,
        deleteBtn,
      )
      return
    }
    const counter = this.selectionBar.querySelector<HTMLElement>('.selection-count')
    if (counter) counter.textContent = selectionTitle(count)
  }

  // ─── экспорт и импорт истории (P-W2) ───────────────────────────────────

  // выгрузка истории файлом: JSON с конвертами записей, медиа — по желанию
  private async exportHistory(withMedia: boolean): Promise<void> {
    const messenger = this.host.ctx.messenger
    if (!messenger) return
    try {
      const records = await messenger.messages(this.chatId, EXPORT_LIMIT)
      if (records.length === 0) return snackbar(t('noMessages'), { kind: 'error' })
      const media = new Map<string, Uint8Array>()
      if (withMedia) {
        for (const id of mediaIdsOf(records)) {
          const blob = await this.host.ctx.media.get(id)
          if (blob) media.set(id, blob)
        }
      }
      const file = buildExport({
        chatId: this.chatId,
        login: this.host.ctx.session?.login ?? '',
        records,
        ...(media.size > 0 ? { media } : {}),
      })
      const url = URL.createObjectURL(new Blob([serializeExport(file)], { type: 'application/json' }))
      const link = h('a', { href: url, download: `history-${this.chatId}-${dayStamp(file.exportedAt)}.json` })
      document.body.appendChild(link)
      link.click()
      link.remove()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
      snackbar(t('exportDone'), { kind: 'success' })
    } catch (error) {
      snackbar(this.host.errorMessage(error), { kind: 'error' })
    }
  }

  // выгрузка с медиа или без: медиа утекает в файл только по желанию
  private pickExportMode(): void {
    const controller = openModal({
      title: t('exportChat'),
      content: h(
        'div',
        { class: 'menu-list' },
        h('button', {
          class: 'menu-item',
          onclick: () => {
            controller.close()
            void this.exportHistory(false)
          },
        }, icon('download', { size: 20 }), t('exportChat')),
        h('button', {
          class: 'menu-item',
          onclick: () => {
            controller.close()
            void this.exportHistory(true)
          },
        }, icon('image', { size: 20 }), `${t('exportChat')} · ${t('exportWithMedia')}`),
      ),
    })
  }

  private importHistory(): void {
    const input = h('input', { type: 'file', accept: 'application/json,.json', class: 'hidden' })
    input.addEventListener('change', () => void this.readImport(input))
    this.element.appendChild(input)
    input.click()
  }

  private async readImport(input: HTMLInputElement): Promise<void> {
    const file = input.files?.[0]
    input.value = ''
    input.remove()
    if (!file) return
    try {
      const parsed = parseExport(await file.text())
      if (!parsed || parsed.messages.length === 0) throw new Error(t('importFailed'))
      const messenger = this.host.ctx.messenger
      if (!messenger) return
      await messenger.importMedia(parsed.media ?? [])
      // дедуп делает журнал по (автор, ref): повторный импорт ничего не дублирует
      const added = await messenger.importRecords(this.chatId, recordsOf(parsed))
      await this.host.refreshDialog()
      // один отчёт: сколько добавлено и сколько уже было в истории
      const duplicates = parsed.messages.length - added
      const report = `${added > 0 ? `${t('importDone')} ${added}` : t('importNothingNew')}${duplicates > 0 ? ` · ${duplicates} ${t('importDuplicates')}` : ''}`
      snackbar(report, { kind: added > 0 ? 'success' : 'info' })
    } catch {
      snackbar(t('importFailed'), { kind: 'error' })
    }
  }

  // ─── меню и информация ──────────────────────────────────────────────────

  private openMenu(item: FeedItem, point: { x: number; y: number }): void {
    const messenger = this.host.ctx.messenger
    if (!messenger) return
    openMessageMenu(point, {
      react: (emoji) => void messenger.react(this.chatId, { ref: item.ref, ts: item.timestamp }, emoji).then(() => this.host.refreshDialog()),
      reply: () => {
        this.replyTo = item
        this.editTarget = null
        this.paintReplyBar()
        this.composerInput.focus()
      },
      copy: () => {
        void navigator.clipboard?.writeText(plainText(item))
        snackbar(t('copied'))
      },
      pin: () => void messenger.pinMessage(this.chatId, item.record, !item.pinned).then(() => this.host.refreshDialog()),
      edit: canEditMessage(item) ? () => {
        this.editTarget = item
        this.replyTo = null
        this.composerInput.value = plainText(item)
        this.autoGrow()
        this.paintReplyBar()
        this.composerInput.focus()
      } : undefined,
      remove: item.mine
        ? async () => {
            if (await confirmModal({ title: t('deleteForAll'), message: 'Удалить сообщение у всех участников?', danger: true })) {
              await messenger.deleteMessage(this.chatId, item.record)
              await this.host.refreshDialog()
            }
          }
        : undefined,
      forward: () => void this.forwardItems([item]),
      select: () => this.enterSelection(item.ref),
    })
  }

  private showChatInfo(): void {
    void this.host.refreshDialog()
    const summary = this.host.state.summaries.find((chat) => chat.chatId === this.chatId)
    const content = h('div', { class: 'form' })
    if (summary?.isGroup && summary.group) {
      // единые ряды «иконка в тонированном круге + заголовок + значение»
      content.append(
        infoRow('users', t('groupMembers'), summary.group.members.join(', ')),
        ...(summary.group.desc ? [infoRow('info', t('groupDescription'), summary.group.desc)] : []),
      )
    } else {
      // сверку кодов безопасности убрали по решению владельца: пользователям
      // не нужно сверять ключи вручную — при смене ключей предупреждает баннер
      content.append(
        infoRowNode(
          h('span', { class: 'lead-icon' }, icon('shield', { size: 20 })),
          h('div', { class: 'info-body' }, h('div', { class: 'info-title', text: t('e2eNoteTitle') }), h('div', { class: 'muted', text: t('e2eNote') })),
        ),
      )
    }
    content.append(
      infoRowNode(
        h('span', { class: 'lead-icon' }, icon('download', { size: 20 })),
        h('button', { class: 'info-row info-action', text: t('exportChat'), onclick: () => void this.pickExportMode() }),
      ),
      infoRowNode(
        h('span', { class: 'lead-icon' }, icon('folder', { size: 20 })),
        h('button', { class: 'info-row info-action', text: t('importChat'), onclick: () => this.importHistory() }),
      ),
    )
    openModal({ title: t('groupInfo') + ' · ' + (summary?.title ?? this.chatId), content })
  }

  private async showChatMenu(event: MouseEvent): Promise<void> {
    const summary = this.host.state.summaries.find((chat) => chat.chatId === this.chatId)
    // блок-лист (P-W4): пункт меняет название в зависимости от состояния
    const blocked = !summary?.isGroup && (await this.host.ctx.blocked.isBlocked(this.chatId))
    const item = (label: string, name: Parameters<typeof icon>[0], action: () => void, danger = false): HTMLElement =>
      h('button', { class: `menu-item${danger ? ' danger' : ''}`, onclick: () => { controller.close(); action() } }, icon(name, { size: 20 }), label)
    const controller = openModal({
      content: h(
        'div',
        { class: 'menu-list' },
        item(t('groupInfo'), 'info', () => this.showChatInfo()),
        item(t('callIncoming'), 'phone', () => void this.startCall()),
        item(t('attachGeo'), 'location', () => void this.sendGeo()),
        item(t('pollCreate'), 'poll', () => void this.createPoll()),
        // блок-лист отправителей (P-W4): только для личных чатов — в группе
        // блокируется участник, а не весь чат
        summary?.isGroup ? null : item(blocked ? t('blockedUnblock') : t('blockedBlock'), 'shield', async () => {
          if (blocked) await this.host.ctx.blocked.unblock(this.chatId)
          else await this.host.ctx.blocked.block(this.chatId)
          this.host.toast(blocked ? t('blockedUnblocked') : t('blockedBlocked'), 'success')
        }),
        summary?.isGroup ? item(t('groupAddMembers'), 'users', () => void this.addMembers()) : null,
        summary?.isGroup ? item(t('groupRename'), 'edit', () => void this.renameGroup()) : null,
        item(t('exportChat'), 'download', () => void this.pickExportMode()),
        item(t('importChat'), 'folder', () => this.importHistory()),
        item(t('groupClearHistory'), 'trash', async () => {
          if (await confirmModal({ title: t('groupClearHistory'), message: 'Удалить всю локальную историю этого чата?', danger: true })) {
            await this.host.ctx.journal.clearChat(this.chatId)
            await this.host.refreshDialog()
          }
        }, true),
      ),
    })
    void event
  }

  private async addMembers(): Promise<void> {
    const input = h('input', { type: 'text', placeholder: t('groupLoginsPrompt') })
    const controller = openModal({
      title: t('groupAddMembers'),
      content: h('div', { class: 'form' }, input),
      actions: [
        h('button', { class: 'btn', text: t('cancel'), onclick: () => controller.close() }),
        h('button', {
          class: 'btn primary',
          text: t('save'),
          onclick: async () => {
            const logins = input.value.split(',').map((value) => value.trim().toLowerCase()).filter(Boolean)
            controller.close()
            if (logins.length > 0) {
              await this.host.ctx.messenger?.addMembers(this.chatId, logins)
              await this.host.refreshDialog()
            }
          },
        }),
      ],
    })
  }

  private async renameGroup(): Promise<void> {
    const summary = this.host.state.summaries.find((chat) => chat.chatId === this.chatId)
    const input = h('input', { type: 'text', value: summary?.title ?? '' })
    const controller = openModal({
      title: t('groupRename'),
      content: h('div', { class: 'form' }, input),
      actions: [
        h('button', { class: 'btn', text: t('cancel'), onclick: () => controller.close() }),
        h('button', {
          class: 'btn primary',
          text: t('save'),
          onclick: async () => {
            controller.close()
            if (input.value.trim()) {
              await this.host.ctx.messenger?.renameGroup(this.chatId, input.value.trim())
              await this.host.refreshDialog()
            }
          },
        }),
      ],
    })
  }

  private async startCall(): Promise<void> {
    try {
      await this.host.ctx.calls?.startCall(this.chatId)
    } catch (error) {
      snackbar(this.host.errorMessage(error), { kind: 'error' })
    }
  }
}

// высота поля композера по содержимому. chrome — padding плюс рамка: их надо
// добавить к высоте текста, иначе при border-box текст уезжает под скроллбар
// (регресс 2026-11-16). Нижний порог — одна строка, верхний — потолок роста.
// сколько записей истории забираем на выгрузку (потолок одного файла)
const EXPORT_LIMIT = 20_000

// дата для имени файла выгрузки — без времени, чтобы имя было читаемым
function dayStamp(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10)
}

export const COMPOSER_MAX_HEIGHT = 160
const COMPOSER_CHROME = 24
const COMPOSER_BORDER = 1
const COMPOSER_LINE = 22

export function composerBoxHeight(contentHeight: number, lineHeight: number, chrome: number): number {
  return Math.min(Math.max(contentHeight + chrome, lineHeight + chrome), COMPOSER_MAX_HEIGHT)
}

// править можно только своё текстовое (или ответ с цитатой): медиа, опросы
// и голосовые правка превратила бы в текст — отсюда гейт
export function canEditMessage(item: FeedItem): boolean {
  if (!item.mine) return false
  return item.kind?.kind === 'text' || item.kind?.kind === 'reply'
}

// мета «Переслано от X» — атрибуция исходного автора из протокола (fwd)
export function forwardedFrom(author: string): HTMLElement {
  return h('div', { class: 'forwarded-from' }, icon('forward', { size: 14 }), h('span', { text: `${t('forwardedFrom')} ${author}` }))
}

export function plainText(item: FeedItem): string {
  const kind = item.kind
  if (kind?.kind === 'text') return kind.text
  if (kind?.kind === 'reply') return kind.reply.text
  return previewOf(item)
}

// ряд «иконка в тонированном круге + заголовок + значение» — общий для
// настроек, звонков и «Информации о чате»
export function infoRow(iconName: IconName, title: string, value: string): HTMLElement {
  return infoRowNode(
    h('span', { class: 'lead-icon' }, icon(iconName, { size: 20 })),
    h('div', { class: 'info-body' }, h('div', { class: 'info-title', text: title }), h('div', { class: 'info-sub', text: value })),
  )
}

function infoRowNode(lead: Node, body: Node): HTMLElement {
  return h('div', { class: 'info-row' }, lead, body)
}

function isSystemItem(item: FeedItem): boolean {
  return item.kind?.kind === 'system'
}

function describeChange(change: NonNullable<Extract<FeedItem['kind'], { kind: 'system' }>['change']>): string {
  const parts: string[] = []
  if (change.renameTo) parts.push(`переименовал(а) группу в «${change.renameTo}»`)
  if (change.added.length > 0) parts.push(`добавил(а): ${change.added.join(', ')}`)
  if (change.removed.length > 0) parts.push(`удалил(а): ${change.removed.join(', ')}`)
  if (change.descTo !== undefined) parts.push('изменил(а) описание')
  if (change.avatar) parts.push('обновил(а) фото группы')
  if (parts.length === 0) parts.push('изменил(а) настройки группы')
  return `${change.sender} ${parts.join(', ')}`
}
