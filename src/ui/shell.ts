// Экранное приложение: вход, список чатов, диалог, настройки, оверлей звонка.
// Без фреймворка: состояние живёт здесь, перерисовка — по событию.
import type { AppContext } from '../app/context.js'
import { buildFeed, previewOf, searchFeed, type FeedItem } from '../domain/feed.js'
import { aggregateReactions, reactionSummary } from '../domain/reactions.js'
import { KeyChangedError, type ChatSummary } from '../domain/messenger.js'
import { isCloudPasswordRequired, RelayError } from '../net/api.js'
import { REACTION_EMOJIS, isValidEmoji, type MediaInfo } from '../protocol/formats.js'
import { audioUrl, imageUrl, prepareFile, preparePhoto, startVoiceRecording, thumbUrl, type VoiceRecording } from '../media/media.js'
import type { CallView } from '../calls/manager.js'
import { installState, notifyMessage, registerPushSubscription } from '../pwa.js'
import {
  append,
  clear,
  confirmAction,
  formatBytes,
  formatDate,
  formatDuration,
  formatTime,
  h,
  mount,
  plural,
  toast,
} from './dom.js'

type Screen = 'boot' | 'login' | 'chats' | 'dialog' | 'settings'

export class AppShell {
  private screen: Screen = 'boot'
  private loginTab: 'login' | 'register' | 'link' = 'login'
  private summaries: ChatSummary[] = []
  private feed: FeedItem[] = []
  private chatId: string | null = null
  private search = ''
  private replyTo: FeedItem | null = null
  private editTarget: FeedItem | null = null
  // черновик композера живёт в состоянии: перерисовка по любому событию
  // (новое сообщение, «печатает», прочитано) иначе стирала бы набранный текст
  private composerDraft = ''
  private composerCaret = 0
  private draftTimer: ReturnType<typeof setTimeout> | null = null
  private recording: VoiceRecording | null = null
  private recordingTimer: ReturnType<typeof setInterval> | null = null
  private callView: CallView | null = null
  private connected = false
  private installAvailable = false
  private mediaUrls: string[] = []
  private unsubscribers: Array<() => void> = []
  private loginState: { nonce: string; pollSecret: string; fingerprint: string; pubB64: string } | null = null
  private linkTimer: ReturnType<typeof setTimeout> | null = null
  private busy = false

  constructor(
    private readonly root: HTMLElement,
    private readonly ctx: AppContext,
  ) {}

  // ─── запуск ────────────────────────────────────────────────────────────

  async boot(): Promise<void> {
    this.screen = 'boot'
    this.render()
    const restored = await this.ctx.restore().catch(() => false)
    if (restored) {
      this.wireSession()
      await this.showChats()
    } else {
      this.screen = 'login'
      this.render()
    }
    window.addEventListener('online', () => this.ctx.messenger?.flushOutbox().catch(() => {}))
    installState.subscribe((available) => {
      this.installAvailable = available
      if (this.screen === 'chats') this.render()
    })
  }

  private wireSession(): void {
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe()
    const messenger = this.ctx.messenger
    const calls = this.ctx.calls
    if (!messenger || !calls) return
    this.unsubscribers.push(
      messenger.onEvent((event) => {
        if (event.type === 'call') {
          const verdict = event.verdict
          if (verdict.kind !== 'mute') {
            void calls.onCallEvent(event.from, verdict.event, event.self).then(() => {
              this.callView = calls.view
              this.render()
            })
          }
          return
        }
        if (event.type === 'presence') {
          this.connected = event.connected
          this.render()
          return
        }
        if (event.type === 'error') toast(event.message, 'error')
        if (event.type === 'chat' && event.chatId && document.visibilityState !== 'visible') {
          void this.notifyIncoming(event.chatId)
        }
        void this.refresh()
      }),
      calls.onUpdate((view) => {
        this.callView = view
        this.render()
      }),
    )
  }

  // уведомление о входящем, когда вкладка не на экране
  private async notifyIncoming(chatId: string): Promise<void> {
    if (!this.ctx.prefs.notifications) return
    const summary = (await this.ctx.messenger?.chatSummaries())?.find((chat) => chat.chatId === chatId)
    if (!summary || !summary.lastRecord) return
    const preview = previewOf({ ...emptyFeedItem(summary), kind: summary.lastKind } as FeedItem)
    await notifyMessage(summary.title, preview.slice(0, 120))
  }

  private async refresh(): Promise<void> {
    if (!this.ctx.messenger) return
    this.summaries = await this.ctx.messenger.chatSummaries()
    if (this.chatId) {
      const records = await this.ctx.messenger.messages(this.chatId, 300)
      const pending = new Set((await this.ctx.messenger.outbox.all()).filter((e) => e.chatId === this.chatId).map((e) => e.id))
      this.feed = await buildFeed(records, this.ctx.messenger.session.login, {
        pinnedRefs: await this.ctx.pins.get(this.chatId),
        pendingRefs: pending,
      })
    }
    this.render()
  }

  // ─── экран входа ───────────────────────────────────────────────────────

  private renderLogin(): void {
    const tabs = h(
      'div',
      { class: 'tabs' },
      this.tabButton('Вход', 'login'),
      this.tabButton('Регистрация', 'register'),
      this.tabButton('Новое устройство', 'link'),
    )

    const body =
      this.loginTab === 'login'
        ? this.renderLoginForm()
        : this.loginTab === 'register'
          ? this.renderRegisterForm()
          : this.renderLinkForm()

    mount(
      this.root,
      h(
        'div',
        { class: 'login-wrap' },
        h(
          'div',
          { class: 'login-card' },
          h('h1', { text: 'Мессенджер' }),
          h('p', { class: 'muted', text: 'История живёт только на этом устройстве и зашифрована. Сервер её не видит.' }),
          tabs,
          body,
          h('p', {
            class: 'hint',
            text: 'Потолок браузера: ключ данных лежит в IndexedDB. Это защищает от чтения файлов профиля, но не от XSS на этом домене.',
          }),
        ),
      ),
    )
  }

  private tabButton(label: string, tab: 'login' | 'register' | 'link'): HTMLElement {
    return h('button', {
      class: `tab${this.loginTab === tab ? ' active' : ''}`,
      text: label,
      onclick: () => {
        this.loginTab = tab
        this.loginState = null
        if (this.linkTimer) clearTimeout(this.linkTimer)
        this.linkTimer = null
        this.render()
      },
    })
  }

  private renderLoginForm(): HTMLElement {
    const identifier = h('input', { type: 'text', placeholder: 'логин или email', autocomplete: 'username' })
    const password = h('input', { type: 'password', placeholder: 'пароль', autocomplete: 'current-password' })
    const cloud = h('input', { type: 'password', placeholder: 'облачный пароль (если включён)' })
    const submit = h('button', {
      class: 'primary',
      text: 'Войти',
      onclick: async () => {
        if (this.busy) return
        this.busy = true
        submit.textContent = 'Входим…'
        try {
          await this.ctx.login(identifier.value, password.value, cloud.value)
          this.wireSession()
          await this.showChats()
        } catch (error) {
          if (isCloudPasswordRequired(error)) {
            cloud.parentElement?.classList.add('highlight')
            toast('включён облачный пароль — введите его', 'error')
          } else {
            toast(errorMessage(error), 'error')
          }
        } finally {
          this.busy = false
          submit.textContent = 'Войти'
        }
      },
    })
    return h(
      'div',
      { class: 'form' },
      identifier,
      password,
      h('div', { class: 'field-hidden' }, cloud),
      submit,
      h('p', {
        class: 'hint',
        text: 'Вход работает только для устройства, уже привязанного к аккаунту. На новом устройстве используйте привязку.',
      }),
    )
  }

  private renderRegisterForm(): HTMLElement {
    const email = h('input', { type: 'email', placeholder: 'email', autocomplete: 'email' })
    const code = h('input', { type: 'text', placeholder: '4-значный код', inputmode: 'numeric' })
    const password = h('input', { type: 'password', placeholder: 'пароль (мин. 6)', autocomplete: 'new-password' })
    const requestButton = h('button', {
      text: 'Получить код',
      onclick: async () => {
        try {
          const devCode = await this.ctx.api.requestCode(email.value.trim())
          if (devCode) {
            code.value = devCode
            toast(`код из dev-режима сервера: ${devCode}`)
          } else {
            toast('код отправлен на почту')
          }
        } catch (error) {
          toast(errorMessage(error), 'error')
        }
      },
    })
    const submit = h('button', {
      class: 'primary',
      text: 'Создать аккаунт',
      onclick: async () => {
        if (this.busy) return
        this.busy = true
        try {
          await this.ctx.register(email.value.trim(), code.value.trim(), password.value)
          this.wireSession()
          await this.showChats()
        } catch (error) {
          toast(errorMessage(error), 'error')
        } finally {
          this.busy = false
        }
      },
    })
    return h('div', { class: 'form' }, email, h('div', { class: 'row' }, code, requestButton), password, submit)
  }

  private renderLinkForm(): HTMLElement {
    if (!this.loginState) {
      const start = h('button', {
        class: 'primary',
        text: 'Начать привязку',
        onclick: async () => {
          try {
            const started = await this.ctx.linkStart()
            this.loginState = { nonce: started.nonce, pollSecret: started.pollSecret, fingerprint: started.fingerprint, pubB64: started.pubB64 }
            this.render()
            this.pollLink()
          } catch (error) {
            toast(errorMessage(error), 'error')
          }
        },
      })
      return h(
        'div',
        { class: 'form' },
        h('p', { class: 'muted', text: 'Привязка переносит ключи и историю с другого устройства: на старом устройстве введите код отсюда.' }),
        start,
      )
    }
    return h(
      'div',
      { class: 'form' },
      h('p', { class: 'muted', text: 'Введите этот код на старом устройстве: Настройки → Устройства → Подтвердить новое устройство' }),
      h('div', { class: 'code-box', text: this.loginState.nonce }),
      h('p', { class: 'hint', text: `Публичный ключ (base64):` }),
      h('div', { class: 'code-box small', text: this.loginState.pubB64 }),
      h('p', { class: 'hint', text: `Отпечаток ключа: ${this.loginState.fingerprint}` }),
      h('p', { class: 'muted', text: 'Ждём подтверждения…' }),
    )
  }

  private pollLink(): void {
    const state = this.loginState
    if (!state) return
    this.linkTimer = setTimeout(async () => {
      try {
        const result = await this.ctx.linkPoll(state.nonce, state.pollSecret)
        if (result) {
          if (this.linkTimer) clearTimeout(this.linkTimer)
          this.linkTimer = null
          this.loginState = null
          this.wireSession()
          await this.showChats()
          toast('устройство привязано')
          return
        }
      } catch (error) {
        toast(errorMessage(error), 'error')
      }
      this.pollLink()
    }, 2_000)
  }

  // ─── список чатов ──────────────────────────────────────────────────────

  private async showChats(): Promise<void> {
    this.screen = 'chats'
    this.chatId = null
    await this.refresh()
  }

  private renderChats(): void {
    const messenger = this.ctx.messenger
    if (!messenger) return
    const query = this.search.trim().toLowerCase()
    const list = this.summaries.filter((chat) => !query || chat.title.toLowerCase().includes(query) || chat.chatId.includes(query))

    const newChat = h('input', {
      class: 'new-chat-input',
      placeholder: 'логин собеседника → Enter',
      onkeydown: async (event: KeyboardEvent) => {
        if (event.key !== 'Enter') return
        const login = (event.target as HTMLInputElement).value.trim().toLowerCase()
        if (!login) return
        await this.openChat(login)
      },
    })

    mount(
      this.root,
      h(
        'div',
        { class: 'screen chats-screen' },
        h(
          'header',
          { class: 'topbar' },
          h('span', { class: `dot ${this.connected ? 'online' : 'offline'}`, title: this.connected ? 'на связи' : 'нет соединения' }),
          h('h1', { text: 'Чаты' }),
          h('button', { class: 'icon', title: 'Настройки', text: '⚙', onclick: () => this.showSettings() }),
        ),
        this.installBanner(),
        h('div', { class: 'search-row' }, h('input', {
          class: 'search',
          placeholder: 'поиск по чатам',
          value: this.search,
          oninput: (event: Event) => {
            this.search = (event.target as HTMLInputElement).value
            this.renderChats()
          },
        })),
        h('div', { class: 'list' }, ...(list.length > 0 ? list.map((chat) => this.chatRow(chat)) : [h('p', { class: 'empty', text: 'Пока пусто. Введите логин собеседника выше.' })])),
        h('div', { class: 'new-chat' }, newChat),
      ),
    )
  }

  private chatRow(chat: ChatSummary): HTMLElement {
    const preview = chat.lastRecord ? previewOf({ ...emptyFeedItem(chat), kind: chat.lastKind } as FeedItem) : ''
    const badges: (Node | string | false | null)[] = []
    if (chat.unread > 0) badges.push(h('span', { class: 'badge', text: String(chat.unread > 99 ? '99+' : chat.unread) }))
    return h(
      'button',
      {
        class: `chat-row${chat.unread > 0 ? ' unread' : ''}`,
        onclick: () => this.openChat(chat.chatId),
      },
      h('div', { class: 'avatar', text: chat.isGroup ? '#' : chat.title.slice(0, 1).toUpperCase() }),
      h(
        'div',
        { class: 'chat-body' },
        h(
          'div',
          { class: 'chat-line' },
          h('span', { class: 'chat-title', text: chat.title }),
          h('span', { class: 'chat-time', text: chat.lastTs ? formatDate(chat.lastTs) : '' }),
        ),
        h(
          'div',
          { class: 'chat-line' },
          h('span', {
            class: 'chat-preview',
            text: chat.typing ? 'печатает…' : chat.draft ? `Черновик: ${chat.draft}` : preview || 'нет сообщений',
          }),
          ...badges,
        ),
      ),
    )
  }

  private installBanner(): HTMLElement | null {
    if (!this.installAvailable) {
      // Safari сносит IndexedDB через 7 дней без установки на домашний экран
      const ua = navigator.userAgent
      const safari = /^((?!chrome|android|crios|fxios).)*safari/i.test(ua)
      if (!safari) return null
      return h('div', { class: 'banner warn' }, h('span', { text: 'Установите приложение на домашний экран: Safari удаляет локальную историю через 7 дней без визитов.' }))
    }
    return h(
      'div',
      { class: 'banner' },
      h('span', { text: 'Установите приложение — история не будет удаляться браузером.' }),
      h('button', {
        text: 'Установить',
        onclick: async () => {
          const installed = await installState.install()
          if (!installed) toast('установка недоступна в этом браузере')
          this.installAvailable = false
          this.render()
        },
      }),
    )
  }

  // ─── диалог ────────────────────────────────────────────────────────────

  private async openChat(chatId: string): Promise<void> {
    this.chatId = chatId
    this.screen = 'dialog'
    this.replyTo = null
    this.editTarget = null
    this.search = ''
    // черновик берём из хранилища: он мог прийти с другого устройства
    this.composerDraft = (await this.ctx.drafts.get(chatId))?.text ?? ''
    this.composerCaret = this.composerDraft.length
    await this.ctx.savePrefs({ lastChat: chatId })
    await this.ctx.messenger?.markRead(chatId)
    await this.refresh()
  }

  private renderDialog(): void {
    const messenger = this.ctx.messenger
    const chatId = this.chatId
    if (!messenger || !chatId) return
    const summary = this.summaries.find((chat) => chat.chatId === chatId)
    const group = summary?.group
    const items = this.search.trim() ? searchFeed(this.feed, this.search) : this.feed

    // позиция прокрутки: если пользователь читал историю выше, не дёргаем его вниз
    const previous = document.getElementById('messages')
    const wasAtBottom = !previous || previous.scrollHeight - previous.scrollTop - previous.clientHeight < 80
    const previousTop = previous?.scrollTop ?? 0

    const container = h('div', { class: 'screen dialog-screen' })
    append(container, [
      h(
        'header',
        { class: 'topbar' },
        h('button', { class: 'icon', text: '←', title: 'К чатам', onclick: () => this.showChats() }),
        h(
          'div',
          { class: 'dialog-title', onclick: () => this.showChatInfo(chatId) },
          h('span', { class: 'chat-title', text: summary?.title ?? chatId }),
          h('span', {
            class: 'chat-sub',
            text: summary?.typing ? 'печатает…' : group ? `${group.members.length} ${plural(group.members.length, 'участник', 'участника', 'участников')}` : this.connected ? 'на связи' : 'нет соединения',
          }),
        ),
        h('button', { class: 'icon', text: '📞', title: 'Позвонить', onclick: () => this.startCall(chatId) }),
        h('button', { class: 'icon', text: '⌕', title: 'Поиск', onclick: () => this.promptSearch() }),
        h('button', { class: 'icon', text: '⋯', title: 'Меню', onclick: () => this.showChatMenu(chatId) }),
      ),
      summary && summary.pinned.length > 0 ? h('div', { class: 'pinned-bar', text: `Закреплено: ${summary.pinned.length}` }) : null,
      h('div', { class: 'messages', id: 'messages' }, ...items.map((item) => this.messageNode(item))),
      this.replyBar(),
      this.composer(chatId),
    ])
    mount(this.root, container)
    const messages = document.getElementById('messages')
    if (messages) messages.scrollTop = wasAtBottom ? messages.scrollHeight : previousTop
    for (const url of this.mediaUrls.splice(0)) void url
  }

  private replyBar(): HTMLElement | null {
    const target = this.editTarget ?? this.replyTo
    if (!target) return null
    const label = this.editTarget ? 'Правка' : 'Ответ'
    const preview = previewOf(target).slice(0, 120)
    return h(
      'div',
      { class: 'reply-bar' },
      h('div', { class: 'reply-text' }, h('b', { text: label }), h('span', { text: preview })),
      h('button', {
        class: 'icon',
        text: '✕',
        onclick: () => {
          this.replyTo = null
          this.editTarget = null
          this.render()
        },
      }),
    )
  }

  private messageNode(item: FeedItem): HTMLElement {
    const messenger = this.ctx.messenger
    if (!messenger) return h('div')
    const body = h('div', { class: 'bubble-body' })
    const kind = item.kind

    if (kind?.kind === 'text') {
      append(body, [h('div', { class: 'text', text: kind.text }), kind.edited ? h('span', { class: 'edited', text: 'изм.' }) : null])
    } else if (kind?.kind === 'reply') {
      append(body, [
        h('div', { class: 'quote', text: kind.reply.quote }),
        h('div', { class: 'text', text: kind.reply.text }),
      ])
    } else if (kind?.kind === 'media') {
      body.appendChild(this.mediaNode(kind.info, item))
    } else if (kind?.kind === 'poll') {
      body.appendChild(this.pollNode(kind.poll, item))
    } else if (kind?.kind === 'contact') {
      append(body, [
        h('div', { class: 'text', text: `👤 ${kind.name ?? `@${kind.login}`}` }),
        h('button', { class: 'link', text: `Открыть @${kind.login}`, onclick: () => this.openChat(kind.login) }),
      ])
    } else if (kind?.kind === 'geo') {
      const point = `${kind.lat.toFixed(5)}, ${kind.lng.toFixed(5)}`
      append(body, [
        h('div', { class: 'text', text: `📍 ${point}` }),
        h('a', { class: 'link', href: `https://www.openstreetmap.org/?mlat=${kind.lat}&mlon=${kind.lng}#map=17/${kind.lat}/${kind.lng}`, target: '_blank', rel: 'noreferrer', text: 'Открыть карту' }),
      ])
    } else if (kind?.kind === 'system') {
      if (kind.call) {
        append(body, [h('div', { class: 'text', text: kind.call.status === 'missed' ? '📞 Пропущенный звонок' : '📞 Звонок' })])
      } else if (kind.change) {
        append(body, [h('div', { class: 'text', text: describeChange(kind.change) })])
      } else {
        append(body, [h('div', { class: 'text', text: kind.text })])
      }
    } else {
      append(body, [h('div', { class: 'text muted', text: 'Сообщение не поддерживается этим клиентом' })])
    }

    const reactions = h('div', { class: 'reactions' })
    void this.renderReactions(item, reactions)

    return h(
      'div',
      {
        class: `message ${item.mine ? 'mine' : 'theirs'}${item.sending ? ' sending' : ''}`,
        dataset: { ref: item.ref },
        oncontextmenu: (event: Event) => {
          event.preventDefault()
          this.showMessageMenu(item)
        },
      },
      item.parsed.kind === 'content' && item.parsed.group ? h('div', { class: 'author', text: item.record.from }) : null,
      body,
      reactions,
      h(
        'div',
        { class: 'meta' },
        h('span', { text: formatTime(item.timestamp) }),
        item.pinned ? h('span', { text: '📌' }) : null,
        item.sending ? h('span', { text: '⏳' }) : null,
      ),
    )
  }

  private async renderReactions(item: FeedItem, container: HTMLElement): Promise<void> {
    const messenger = this.ctx.messenger
    if (!messenger || !this.chatId) return
    const state = await messenger.reactionsFor(this.chatId, item.ref, item.timestamp)
    const summary = reactionSummary(state, 4)
    clear(container)
    for (const entry of summary) {
      container.appendChild(
        h('button', {
          class: `reaction${state.mine === entry.emoji ? ' mine' : ''}`,
          text: `${entry.emoji} ${entry.count}`,
          onclick: async () => {
            await messenger.react(this.chatId!, { ref: item.ref, ts: item.timestamp }, state.mine === entry.emoji ? '' : entry.emoji)
            await this.refresh()
          },
        }),
      )
    }
  }

  private mediaNode(info: MediaInfo, item: FeedItem): HTMLElement {
    const messenger = this.ctx.messenger
    const node = h('div', { class: 'media' })
    if (info.type === 'voice') {
      node.appendChild(
        h(
          'div',
          { class: 'voice' },
          h('button', {
            class: 'icon',
            text: '▶',
            onclick: async () => {
              const data = await messenger?.ensureMedia(info)
              if (!data) {
                toast('не удалось скачать голосовое', 'error')
                return
              }
              const url = audioUrl(data)
              this.mediaUrls.push(url)
              void new Audio(url).play()
            },
          }),
          h('span', { text: `Голосовое ${formatDuration(info.duration)}` }),
        ),
      )
      return node
    }
    if (info.type === 'file') {
      node.appendChild(
        h(
          'div',
          { class: 'file' },
          h('span', { text: `📄 ${info.name ?? 'файл'}` }),
          h('span', { class: 'muted', text: formatBytes(info.size) }),
          h('button', {
            class: 'link',
            text: 'Скачать',
            onclick: async () => {
              const data = await messenger?.ensureMedia(info)
              if (!data) {
                toast('не удалось скачать файл', 'error')
                return
              }
              const url = URL.createObjectURL(new Blob([data as unknown as BlobPart], { type: info.mime ?? 'application/octet-stream' }))
              this.mediaUrls.push(url)
              const link = h('a', { href: url, download: info.name ?? 'file' })
              link.click()
            },
          }),
        ),
      )
      return node
    }
    // фото: превью из дескриптора, полный блоб — по клику
    const preview = h('img', {
      class: 'photo',
      src: info.thumb ? thumbUrl(info.thumb) : '',
      alt: 'фото',
      onclick: async () => {
        const data = await messenger?.ensureMedia(info)
        if (!data) {
          toast('не удалось скачать фото', 'error')
          return
        }
        const url = imageUrl(data)
        this.mediaUrls.push(url)
        preview.src = url
      },
    })
    if (info.spoiler) preview.classList.add('spoiler')
    node.appendChild(preview)
    if (item.mine) node.appendChild(h('div', { class: 'muted', text: formatBytes(info.size) }))
    return node
  }

  private pollNode(poll: NonNullable<FeedItem['kind'] & { kind: 'poll' }>['poll'], item: FeedItem): HTMLElement {
    const node = h('div', { class: 'poll' })
    node.appendChild(h('div', { class: 'text', text: `📊 ${poll.question}` }))
    const container = h('div', { class: 'poll-options' })
    node.appendChild(container)
    void (async () => {
      const messenger = this.ctx.messenger
      if (!messenger || !this.chatId) return
      const state = await messenger.votesFor(this.chatId, item.ref, poll.options.length, item.record.from)
      clear(container)
      poll.options.forEach((option, index) => {
        const count = state.counts[index] ?? 0
        const share = state.votes.size > 0 ? Math.round((count / state.votes.size) * 100) : 0
        container.appendChild(
          h(
            'button',
            {
              class: `poll-option${state.mine === index ? ' mine' : ''}`,
              disabled: state.closed,
              onclick: async () => {
                await messenger.vote(this.chatId!, item.ref, index)
                await this.refresh()
              },
            },
            h('span', { text: option }),
            h('span', { class: 'muted', text: `${count} (${share}%)` }),
          ),
        )
      })
      if (state.closed) container.appendChild(h('p', { class: 'muted', text: 'Опрос остановлен автором' }))
    })()
    return node
  }

  private composer(chatId: string): HTMLElement {
    const messenger = this.ctx.messenger
    const editing = this.editTarget && this.editTarget.kind?.kind === 'text' ? this.editTarget.kind.text : null
    const input = h('textarea', {
      class: 'composer-input',
      rows: 1,
      placeholder: 'Сообщение',
      value: editing ?? this.composerDraft,
      oninput: () => {
        this.composerDraft = input.value
        this.composerCaret = input.selectionStart ?? input.value.length
        void messenger?.sendTyping(chatId)
        this.saveDraft(chatId)
        autoGrow(input)
      },
      onkeydown: (event: KeyboardEvent) => {
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault()
          void send()
        }
      },
    })
    // каретка возвращается на прежнее место после перерисовки
    setTimeout(() => {
      autoGrow(input)
      if (input.value && document.activeElement !== input && this.composerCaret > 0) {
        const caret = Math.min(this.composerCaret, input.value.length)
        input.setSelectionRange(caret, caret)
      }
    }, 0)

    const send = async (): Promise<void> => {
      const value = input.value.trim()
      if (!value) return
      const editTarget = this.editTarget
      const replyTo = this.replyTo
      input.value = ''
      this.composerDraft = ''
      this.composerCaret = 0
      this.editTarget = null
      this.replyTo = null
      if (!editTarget) void messenger?.setDraft(chatId, '')
      try {
        if (editTarget) {
          await messenger?.editMessage(chatId, editTarget.record, value)
        } else {
          await messenger?.sendText(chatId, value, {
            replyTo: replyTo
              ? { ref: replyTo.ref, author: replyTo.record.from, quote: previewOf(replyTo).slice(0, 200), ts: replyTo.timestamp }
              : undefined,
          })
        }
      } catch (error) {
        if (error instanceof KeyChangedError) this.warnKeys(error)
        else toast(errorMessage(error), 'error')
      }
      await this.refresh()
    }

    const photoInput = h('input', {
      type: 'file',
      accept: 'image/*',
      class: 'hidden',
      onchange: async (event: Event) => {
        const file = (event.target as HTMLInputElement).files?.[0]
        if (!file) return
        await this.sendPrepared(chatId, file, 'photo')
      },
    })
    const fileInput = h('input', {
      type: 'file',
      class: 'hidden',
      onchange: async (event: Event) => {
        const file = (event.target as HTMLInputElement).files?.[0]
        if (!file) return
        await this.sendPrepared(chatId, file, 'file')
      },
    })

    const voiceButton = h('button', {
      class: 'icon',
      text: '🎤',
      title: 'Голосовое',
      onclick: async () => {
        if (this.recording) {
          const recording = this.recording
          this.recording = null
          if (this.recordingTimer) clearInterval(this.recordingTimer)
          const result = await recording.stop()
          voiceButton.textContent = '🎤'
          await this.sendVoice(chatId, result.data, result.duration, result.waveform)
          return
        }
        try {
          this.recording = await startVoiceRecording()
          voiceButton.textContent = '⏹'
          toast('идёт запись, нажмите ещё раз для отправки')
        } catch {
          toast('нет доступа к микрофону', 'error')
        }
      },
    })

    return h(
      'div',
      { class: 'composer' },
      h('button', { class: 'icon', text: '📎', title: 'Файл', onclick: () => fileInput.click() }),
      h('button', { class: 'icon', text: '🖼', title: 'Фото', onclick: () => photoInput.click() }),
      voiceButton,
      input,
      h('button', { class: 'primary', text: '→', title: 'Отправить', onclick: () => void send() }),
      photoInput,
      fileInput,
    )
  }

  private async sendPrepared(chatId: string, file: File, kind: 'photo' | 'file'): Promise<void> {
    const messenger = this.ctx.messenger
    if (!messenger) return
    try {
      const prepared = kind === 'photo' ? await preparePhoto(file) : await prepareFile(file)
      const { encryptBlob } = await import('../media/media.js')
      const { blob, key } = await encryptBlob(prepared.plain)
      const mediaId = await messenger.uploadMedia(blob)
      await messenger.sendMedia(chatId, { ...prepared.info, id: mediaId, key, size: prepared.plain.length })
    } catch (error) {
      if (error instanceof KeyChangedError) this.warnKeys(error)
      else toast(errorMessage(error), 'error')
    }
    await this.refresh()
  }

  private async sendVoice(chatId: string, data: Uint8Array, duration: number, waveform: Uint8Array): Promise<void> {
    const messenger = this.ctx.messenger
    if (!messenger) return
    try {
      const { encryptBlob } = await import('../media/media.js')
      const { blob, key } = await encryptBlob(data)
      const mediaId = await messenger.uploadMedia(blob)
      await messenger.sendMedia(chatId, {
        id: mediaId,
        key,
        size: data.length,
        width: 0,
        height: 0,
        thumb: '',
        type: 'voice',
        duration,
        waveform,
        spoiler: false,
        sticker: false,
        videoNote: false,
        silent: false,
        viewOnce: false,
      })
    } catch (error) {
      toast(errorMessage(error), 'error')
    }
    await this.refresh()
  }

  // черновик уходит в хранилище и на свои устройства не чаще раза в секунду
  private saveDraft(chatId: string): void {
    if (this.draftTimer) clearTimeout(this.draftTimer)
    const value = this.composerDraft
    this.draftTimer = setTimeout(() => {
      void this.ctx.messenger?.setDraft(chatId, value)
    }, 1_000)
  }

  private warnKeys(error: KeyChangedError): void {
    toast(
      error.isNewDevice
        ? `У ${error.peer} появилось новое устройство: отправка ждёт подтверждения в настройках безопасности`
        : `Ключи ${error.peer} изменились: подтвердите в настройках безопасности`,
      'error',
    )
  }

  // ─── меню сообщения и чата ─────────────────────────────────────────────

  private showMessageMenu(item: FeedItem): void {
    const messenger = this.ctx.messenger
    const chatId = this.chatId
    if (!messenger || !chatId) return
    const reactions = h(
      'div',
      { class: 'reaction-picker' },
      ...REACTION_EMOJIS.slice(0, 12).map((emoji) =>
        h('button', {
          text: emoji,
          onclick: async () => {
            this.closeOverlay()
            await messenger.react(chatId, { ref: item.ref, ts: item.timestamp }, emoji)
            await this.refresh()
          },
        }),
      ),
      h('button', {
        text: '…',
        title: 'Любой эмодзи',
        onclick: async () => {
          const value = window.prompt('Эмодзи для реакции')
          this.closeOverlay()
          if (!value || !isValidEmoji(value)) {
            if (value) toast('это не похоже на эмодзи', 'error')
            return
          }
          await messenger.react(chatId, { ref: item.ref, ts: item.timestamp }, value)
          await this.refresh()
        },
      }),
    )
    const actions: HTMLElement[] = [
      h('button', {
        text: 'Ответить',
        onclick: () => {
          this.replyTo = item
          this.editTarget = null
          this.closeOverlay()
          this.render()
        },
      }),
      h('button', {
        text: 'Копировать',
        onclick: () => {
          const text = item.kind?.kind === 'text' ? item.kind.text : item.kind?.kind === 'reply' ? item.kind.reply.text : ''
          void navigator.clipboard.writeText(text)
          this.closeOverlay()
        },
      }),
      h('button', {
        text: item.pinned ? 'Открепить' : 'Закрепить',
        onclick: async () => {
          this.closeOverlay()
          await messenger.pinMessage(chatId, item.record, !item.pinned)
          await this.refresh()
        },
      }),
    ]
    if (item.mine) {
      actions.push(
        h('button', {
          text: 'Править',
          onclick: () => {
            this.editTarget = item
            this.replyTo = null
            this.closeOverlay()
            this.render()
          },
        }),
        h('button', {
          text: 'Удалить у всех',
          onclick: async () => {
            this.closeOverlay()
            if (!confirmAction('Удалить сообщение у всех участников?')) return
            await messenger.deleteMessage(chatId, item.record)
            await this.refresh()
          },
        }),
      )
    }
    this.showOverlay(h('div', { class: 'sheet' }, reactions, h('div', { class: 'sheet-actions' }, ...actions)))
  }

  private showChatMenu(chatId: string): void {
    const messenger = this.ctx.messenger
    if (!messenger) return
    const summary = this.summaries.find((chat) => chat.chatId === chatId)
    const actions: HTMLElement[] = [
      h('button', {
        text: 'Информация',
        onclick: () => {
          this.closeOverlay()
          this.showChatInfo(chatId)
        },
      }),
      h('button', {
        text: 'Позвонить',
        onclick: () => {
          this.closeOverlay()
          void this.startCall(chatId)
        },
      }),
      h('button', {
        text: 'Прислать геопозицию',
        onclick: () => {
          this.closeOverlay()
          void this.sendGeo(chatId)
        },
      }),
      h('button', {
        text: 'Опрос',
        onclick: () => {
          this.closeOverlay()
          void this.createPoll(chatId)
        },
      }),
      h('button', {
        text: 'Очистить историю',
        onclick: async () => {
          this.closeOverlay()
          if (!confirmAction('Удалить всю локальную историю этого чата? Восстановить её будет нельзя.')) return
          await this.ctx.journal.clearChat(chatId)
          await this.refresh()
        },
      }),
    ]
    if (summary?.isGroup) {
      actions.push(
        h('button', {
          text: 'Добавить участников',
          onclick: async () => {
            this.closeOverlay()
            const value = window.prompt('Логины через запятую')
            if (!value) return
            await messenger.addMembers(chatId, value.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean))
            await this.refresh()
          },
        }),
        h('button', {
          text: 'Переименовать',
          onclick: async () => {
            this.closeOverlay()
            const value = window.prompt('Новое имя группы', summary?.title ?? '')
            if (!value) return
            await messenger.renameGroup(chatId, value)
            await this.refresh()
          },
        }),
      )
    }
    this.showOverlay(h('div', { class: 'sheet' }, h('div', { class: 'sheet-actions' }, ...actions)))
  }

  private promptSearch(): void {
    const value = window.prompt('Поиск по сообщениям')
    this.search = value ?? ''
    this.render()
  }

  private async sendGeo(chatId: string): Promise<void> {
    const messenger = this.ctx.messenger
    if (!messenger) return
    if (!navigator.geolocation) {
      toast('браузер не даёт геопозицию', 'error')
      return
    }
    navigator.geolocation.getCurrentPosition(
      async (position) => {
        await messenger.sendGeo(chatId, position.coords.latitude, position.coords.longitude)
        await this.refresh()
      },
      () => toast('доступ к геопозиции отклонён', 'error'),
      { timeout: 15_000 },
    )
  }

  private async createPoll(chatId: string): Promise<void> {
    const messenger = this.ctx.messenger
    if (!messenger) return
    const question = window.prompt('Вопрос опроса')
    if (!question) return
    const raw = window.prompt('Варианты через запятую (мин. 2)')
    if (!raw) return
    const options = raw.split(',').map((s) => s.trim()).filter(Boolean)
    if (options.length < 2) {
      toast('нужно минимум два варианта', 'error')
      return
    }
    await messenger.sendPoll(chatId, question, options, false)
    await this.refresh()
  }

  private showChatInfo(chatId: string): void {
    const summary = this.summaries.find((chat) => chat.chatId === chatId)
    const rows: HTMLElement[] = [h('div', { class: 'sheet-title', text: summary?.title ?? chatId })]
    if (summary?.profileBio) rows.push(h('p', { class: 'muted', text: summary.profileBio }))
    if (summary?.group) {
      rows.push(h('p', { class: 'muted', text: `Участники: ${summary.group.members.join(', ')}` }))
      if (summary.group.desc) rows.push(h('p', { class: 'muted', text: summary.group.desc }))
    } else {
      rows.push(
        h('button', {
          text: 'Показать код безопасности',
          onclick: async () => {
            this.closeOverlay()
            await this.showSafetyCode(chatId)
          },
        }),
      )
      rows.push(
        h('button', {
          text: 'Проверить «в сети»',
          onclick: async () => {
            const status = await this.ctx.messenger?.checkOnline(chatId)
            toast(status?.online ? 'сейчас в сети' : status ? `был(а) в сети ${formatDate(status.lastSeenUnix * 1000)}` : 'статус недоступен')
          },
        }),
      )
    }
    this.showOverlay(h('div', { class: 'sheet' }, ...rows))
  }

  private async showSafetyCode(peer: string): Promise<void> {
    const messenger = this.ctx.messenger
    if (!messenger) return
    const devices = await this.ctx.api.peerKeys(peer)
    const { safetyCode } = await import('../crypto/safetycode.js')
    const codes: string[] = []
    for (const device of devices) {
      codes.push(`${device.deviceId}: ${await safetyCode(messenger.session.identity.publicKey(), device.pubSpki)}`)
    }
    const known = await this.ctx.keys.get(peer)
    this.showOverlay(
      h(
        'div',
        { class: 'sheet' },
        h('div', { class: 'sheet-title', text: `Коды безопасности @${peer}` }),
        ...codes.map((code) => h('div', { class: 'code-box', text: code })),
        h('p', {
          class: 'muted',
          text: known?.verified ? 'Ключи подтверждены' : 'Сверьте коды с собеседником по другому каналу',
        }),
        h('button', {
          text: 'Подтвердить ключи',
          onclick: async () => {
            await this.ctx.keys.markVerified(peer)
            this.closeOverlay()
            toast('ключи отмечены подтверждёнными')
          },
        }),
      ),
    )
  }

  // ─── настройки ─────────────────────────────────────────────────────────

  private showSettings(): void {
    this.screen = 'settings'
    this.render()
  }

  private renderSettings(): void {
    const messenger = this.ctx.messenger
    const prefs = this.ctx.prefs
    const container = h('div', { class: 'screen settings-screen' })
    const blocks: HTMLElement[] = [
      h(
        'header',
        { class: 'topbar' },
        h('button', { class: 'icon', text: '←', title: 'К чатам', onclick: () => this.showChats() }),
        h('h1', { text: 'Настройки' }),
      ),
      h('h2', { text: 'Профиль' }),
      h('p', { class: 'muted', text: `Логин: ${messenger?.session.login ?? ''}` }),
      this.settingRow('О себе', prefs ? '' : '', async () => {
        const value = window.prompt('О себе (до 70 символов)')
        if (value === null) return
        await messenger?.setBio(value)
        toast('профиль обновлён')
      }, 'Изменить'),
      this.settingRow('Аватар', '', async () => {
        const input = h('input', { type: 'file', accept: 'image/*' })
        input.onchange = async () => {
          const file = input.files?.[0]
          if (!file) return
          const prepared = await preparePhoto(file)
          const { encryptBlob } = await import('../media/media.js')
          const { blob, key } = await encryptBlob(prepared.plain)
          const mediaId = await messenger!.uploadMedia(blob)
          await messenger!.setAvatar({ ...prepared.info, id: mediaId, key, size: prepared.plain.length }, blob)
          toast('аватар отправлен в ваши чаты')
        }
        input.click()
      }, 'Загрузить'),
      h('h2', { text: 'Звонки' }),
      h('p', {
        class: 'hint',
        text: 'TURN обязателен для web: без него звонки не проходят через симметричный NAT и мобильные сети.',
      }),
      this.iceServerEditor(),
      h('h2', { text: 'Безопасность' }),
      h('p', { class: 'hint', text: 'Ключ данных хранится в IndexedDB браузера: аппаратного хранилища, как в Android, в web нет.' }),
      h('button', { text: 'Мои устройства', onclick: () => void this.showDevices() }),
      h('button', { text: 'Сменить пароль', onclick: () => void this.changePassword() }),
      h('button', { text: 'Облачный пароль (2FA)', onclick: () => void this.setCloudPassword() }),
      h('h2', { text: 'Уведомления' }),
      this.toggleRow('Уведомления', prefs.notifications, async (value) => {
        await this.ctx.savePrefs({ notifications: value })
        if (value) {
          const subscription = await registerPushSubscription()
          if (subscription) toast('подписка на push сохранена локально')
        }
        this.render()
      }),
      this.toggleRow('Скрывать «в сети»', prefs.presenceHidden, async (value) => {
        await this.ctx.savePrefs({ presenceHidden: value })
        try {
          await this.ctx.api.setPresenceHidden(messenger!.session.token, value)
        } catch {
          toast('не удалось изменить приватность на сервере', 'error')
        }
        this.render()
      }),
      h('h2', { text: 'Аккаунт' }),
      h('button', { text: 'Выйти из аккаунта', onclick: () => void this.logout() }),
      h('button', {
        class: 'danger',
        text: 'Выйти и удалить все данные',
        onclick: () => void this.wipe(),
      }),
      h('p', { class: 'hint', text: 'Web-клиент. История, ключи и настройки — только в этом браузере.' }),
    ]
    mount(container, ...blocks)
    mount(this.root, container)
  }

  private settingRow(title: string, value: string, action: () => void, actionLabel: string): HTMLElement {
    return h(
      'div',
      { class: 'setting-row' },
      h('div', {}, h('div', { text: title }), value ? h('div', { class: 'muted', text: value }) : null),
      h('button', { text: actionLabel, onclick: action }),
    )
  }

  private toggleRow(title: string, value: boolean, onChange: (value: boolean) => void): HTMLElement {
    return h(
      'div',
      { class: 'setting-row' },
      h('div', { text: title }),
      h('input', {
        type: 'checkbox',
        checked: value,
        onchange: (event: Event) => onChange((event.target as HTMLInputElement).checked),
      }),
    )
  }

  private iceServerEditor(): HTMLElement {
    const urls = h('input', { value: this.ctx.prefs.iceServers.map((s) => s.urls).join(', ') })
    const user = h('input', { placeholder: 'TURN логин' })
    const credential = h('input', { type: 'password', placeholder: 'TURN пароль' })
    return h(
      'div',
      { class: 'form' },
      urls,
      user,
      credential,
      h('button', {
        text: 'Сохранить',
        onclick: async () => {
          const servers = urls.value
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
            .map((value) => ({ urls: value, username: user.value || undefined, credential: credential.value || undefined }))
          await this.ctx.savePrefs({ iceServers: servers.length > 0 ? servers : [{ urls: 'stun:stun.l.google.com:19302' }] })
          toast('настройки звонков сохранены')
        },
      }),
    )
  }

  private async showDevices(): Promise<void> {
    const messenger = this.ctx.messenger
    if (!messenger) return
    try {
      const devices = await this.ctx.api.listDevices(messenger.session.token)
      const rows: HTMLElement[] = [h('div', { class: 'sheet-title', text: 'Устройства аккаунта' })]
      for (const device of devices) {
        rows.push(
          h(
            'div',
            { class: 'setting-row' },
            h('div', {}, h('div', { text: device.deviceId }), device.current ? h('div', { class: 'muted', text: 'это устройство' }) : null),
            device.current
              ? null
              : h('button', {
                  class: 'danger',
                  text: 'Отключить',
                  onclick: async () => {
                    if (!confirmAction(`Отключить устройство ${device.deviceId}?`)) return
                    await this.ctx.api.revokeDevice(messenger.session.token, device.deviceId)
                    this.closeOverlay()
                    toast('устройство отключено')
                  },
                }),
          ),
        )
      }
      rows.push(
        h('button', {
          text: 'Подтвердить новое устройство',
          onclick: async () => {
            const nonce = window.prompt('Код с нового устройства')
            if (!nonce) return
            const pub = window.prompt('Отпечаток ключа нового устройства (публичный ключ base64)')
            if (!pub) return
            try {
              await this.ctx.linkConfirm(nonce, pub)
              toast('устройство привязано')
            } catch (error) {
              toast(errorMessage(error), 'error')
            }
          },
        }),
      )
      rows.push(
        h('button', {
          text: 'Перенести историю на устройство',
          onclick: async () => {
            const target = window.prompt('device_id получателя')
            if (!target) return
            try {
              const moved = await messenger.transferHistoryTo(target)
              toast(`перенесено записей: ${moved}`)
            } catch (error) {
              toast(errorMessage(error), 'error')
            }
          },
        }),
      )
      this.showOverlay(h('div', { class: 'sheet' }, ...rows))
    } catch (error) {
      toast(errorMessage(error), 'error')
    }
  }

  private async changePassword(): Promise<void> {
    const messenger = this.ctx.messenger
    if (!messenger) return
    const current = window.prompt('Текущий пароль')
    if (!current) return
    const next = window.prompt('Новый пароль (мин. 6)')
    if (!next) return
    try {
      await this.ctx.api.changePassword(messenger.session.token, current, next)
      toast('пароль изменён')
    } catch (error) {
      toast(errorMessage(error), 'error')
    }
  }

  private async setCloudPassword(): Promise<void> {
    const messenger = this.ctx.messenger
    if (!messenger) return
    const current = window.prompt('Текущий пароль')
    if (!current) return
    const cloud = window.prompt('Облачный пароль (пусто — снять)')
    if (cloud === null) return
    try {
      await this.ctx.api.setCloudPassword(messenger.session.token, current, cloud)
      toast(cloud ? 'облачный пароль включён' : 'облачный пароль снят')
    } catch (error) {
      toast(errorMessage(error), 'error')
    }
  }

  private async logout(): Promise<void> {
    if (!confirmAction('Выйти из аккаунта? Ключи и история останутся на устройстве.')) return
    await this.ctx.logout()
    this.screen = 'login'
    this.render()
  }

  private async wipe(): Promise<void> {
    if (!confirmAction('Удалить ВСЕ данные этого браузера: историю, ключи, настройки? Восстановить будет нельзя.')) return
    await this.ctx.wipe()
    this.screen = 'login'
    this.render()
  }

  // ─── звонки ────────────────────────────────────────────────────────────

  private async startCall(peer: string): Promise<void> {
    const calls = this.ctx.calls
    if (!calls) return
    try {
      await calls.startCall(peer)
    } catch (error) {
      toast(errorMessage(error), 'error')
    }
  }

  private renderCallOverlay(): HTMLElement | null {
    const view = this.callView
    const calls = this.ctx.calls
    if (!view || !calls || view.state.phase === 'idle') return null
    const { state } = view
    const title = state.peer ?? ''
    const status =
      state.phase === 'outgoing'
        ? 'вызов…'
        : state.phase === 'ringing'
          ? 'входящий звонок'
          : state.phase === 'active'
            ? formatDuration(calls.duration())
            : 'завершён'
    const controls: HTMLElement[] = []
    if (state.phase === 'ringing') {
      controls.push(
        h('button', { class: 'call-accept', text: 'Ответить', onclick: () => void calls.accept() }),
        h('button', { class: 'call-decline', text: 'Отклонить', onclick: () => void calls.decline() }),
      )
    } else if (state.phase === 'outgoing' || state.phase === 'active') {
      controls.push(
        h('button', { class: 'icon', text: view.muted ? '🔇' : '🎙', title: 'Микрофон', onclick: () => calls.toggleMute() }),
        h('button', { class: 'call-decline', text: 'Завершить', onclick: () => void calls.hangup() }),
      )
    } else {
      controls.push(h('button', { text: 'Закрыть', onclick: () => calls.dismiss() }))
    }
    return h(
      'div',
      { class: 'call-overlay' },
      h('div', { class: 'call-card' },
        h('div', { class: 'call-title', text: title }),
        h('div', { class: 'call-status', text: status }),
        view.error ? h('div', { class: 'call-error', text: view.error }) : null,
        h('div', { class: 'call-controls' }, ...controls),
      ),
    )
  }

  // ─── оверлеи ───────────────────────────────────────────────────────────

  private showOverlay(content: HTMLElement): void {
    const existing = document.getElementById('overlay')
    existing?.remove()
    const overlay = h('div', {
      id: 'overlay',
      class: 'overlay',
      onclick: (event: Event) => {
        if (event.target === overlay) this.closeOverlay()
      },
    })
    overlay.appendChild(content)
    document.body.appendChild(overlay)
  }

  private closeOverlay(): void {
    document.getElementById('overlay')?.remove()
  }

  // ─── отрисовка ─────────────────────────────────────────────────────────

  render(): void {
    if (this.screen === 'boot') {
      mount(this.root, h('div', { class: 'boot', text: 'Загрузка…' }))
      return
    }
    if (this.screen === 'login') this.renderLogin()
    else if (this.screen === 'chats') this.renderChats()
    else if (this.screen === 'dialog') this.renderDialog()
    else this.renderSettings()

    const overlay = this.renderCallOverlay()
    const existing = document.getElementById('call-overlay')
    existing?.remove()
    if (overlay) {
      overlay.id = 'call-overlay'
      document.body.appendChild(overlay)
      // таймер разговора должен тикать
      if (this.callView?.state.phase === 'active') setTimeout(() => this.render(), 1_000)
    }
  }
}

function emptyFeedItem(chat: ChatSummary): FeedItem {
  return {
    record: chat.lastRecord ?? { from: '', timestamp: 0, content: new Uint8Array() },
    parsed: { kind: 'content', content: { kind: 'unsupported' } },
    kind: null,
    mine: false,
    ref: '',
    timestamp: chat.lastTs,
    pinned: false,
    sending: false,
  }
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

function autoGrow(input: HTMLTextAreaElement): void {
  input.style.height = 'auto'
  input.style.height = `${Math.min(160, input.scrollHeight)}px`
}

function errorMessage(error: unknown): string {
  if (error instanceof RelayError) return error.message
  if (error instanceof Error) return error.message
  return 'неизвестная ошибка'
}

// используется в тестах вёрстки: список реакций по состоянию
export { aggregateReactions }
