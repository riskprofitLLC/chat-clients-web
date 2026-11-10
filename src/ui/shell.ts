// Оболочка: состояние, маршрутизация (hash/History API), связка с мессенджером,
// оверлей звонка и глобальные обработчики. Экраны живут в src/ui/screens.
import type { AppContext } from '../app/context.js'
import { Store } from './state/store.js'
import type { AppHost, Route, UiState } from './host.js'
import { LoginScreen } from './screens/login.js'
import { ChatsScreen } from './screens/chats.js'
import { DialogScreen } from './screens/dialog.js'
import { SettingsScreen } from './screens/settings.js'
import { CallOverlay } from './components/call-overlay.js'
import { snackbar } from './components/snackbar.js'
import { applyTheme } from './theme.js'
import { t } from '../i18n/ru.js'
import { RelayError } from '../net/api.js'
import { notificationBody } from '../domain/feed.js'
import { applyUpdate, installState, isStandalone, notifyMessage, registerServiceWorker, watchForUpdate } from '../pwa.js'
import { h } from './dom.js'
import { icon } from './icons.js'

interface ScreenHandle {
  name: Route['name']
  element: HTMLElement
  update?: () => void
  dispose?: () => void
}

export class AppShell implements AppHost {
  readonly store: Store<UiState>
  private current: ScreenHandle | null = null
  private callOverlay: CallOverlay
  private callTimer: ReturnType<typeof setInterval> | null = null
  private unsubscribers: Array<() => void> = []
  private readTimer: ReturnType<typeof setTimeout> | null = null
  private installBanner: HTMLElement | null = null
  private desktop = false
  private sidebar: ChatsScreen | null = null
  private appShell: HTMLElement | null = null
  private mainPane: HTMLElement | null = null

  constructor(
    private readonly root: HTMLElement,
    readonly ctx: AppContext,
  ) {
    this.store = new Store<UiState>({
      route: { name: 'login' },
      connected: false,
      summaries: [],
      chatId: null,
      snapshot: null,
      chatLoading: false,
      search: '',
      searchOpen: false,
      replyTo: null,
      editTarget: null,
      composerDraft: '',
      callView: null,
      installAvailable: false,
      failedSends: [],
      presence: null,
      reverify: null,
      theme: ctx.prefs.theme,
      accent: ctx.prefs.accent,
      version: 0,
    })
    this.callOverlay = new CallOverlay(this)
    this.store.subscribe(() => this.renderCurrent())
  }

  get state(): UiState {
    return this.store.get()
  }

  // ─── запуск ────────────────────────────────────────────────────────────

  async boot(): Promise<void> {
    applyTheme(this.ctx.prefs.theme, this.ctx.prefs.accent)
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme(this.ctx.prefs.theme, this.ctx.prefs.accent))
    window.addEventListener('hashchange', () => this.applyRoute())
    window.addEventListener('keydown', (event) => this.onGlobalKey(event))
    const media = window.matchMedia('(min-width: 900px)')
    this.desktop = media.matches
    media.addEventListener('change', (event) => {
      this.desktop = event.matches
      this.applyRoute()
    })
    document.addEventListener('visibilitychange', () => this.onVisibility())
    installState.subscribe((available) => {
      this.store.set({ installAvailable: available })
      this.renderInstallBanner()
    })
    this.renderInstallBanner()
    const registration = await registerServiceWorker()
    if (registration) {
      watchForUpdate(registration, () => {
        snackbar('Доступна новая версия', { action: { label: 'Обновить', onClick: () => applyUpdate() }, timeoutMs: 0 })
      })
    }

    const restored = await this.ctx.restore().catch(() => false)
    if (restored) {
      this.wireSession()
      this.navigate({ name: 'chats' }, true)
    } else {
      this.navigate({ name: 'login' }, true)
    }
  }

  // ─── маршрутизация ─────────────────────────────────────────────────────

  navigate(route: Route, replace = false): void {
    const hash = routeToHash(route)
    if (location.hash === hash) {
      this.store.set({ route })
      this.mountRoute(route)
      return
    }
    if (replace) history.replaceState(null, '', hash)
    else location.hash = hash
    this.store.set({ route })
    this.mountRoute(route)
  }

  private applyRoute(): void {
    const route = hashToRoute(location.hash)
    this.store.set({ route })
    this.mountRoute(route)
  }

  private mountRoute(route: Route): void {
    if (route.name === 'login') {
      this.teardownDesktop()
      const login = new LoginScreen(this)
      this.setSingle({ name: 'login', element: login.element, update: () => login.render(), dispose: () => login.dispose() })
      login.render()
      return
    }
    if (this.desktop) this.mountDesktop(route)
    else this.mountMobile(route)
  }

  private mountMobile(route: Route): void {
    this.teardownDesktop()
    if (route.name === 'dialog') {
      if (!this.ctx.messenger) return this.navigate({ name: 'login' }, true)
      const dialog = new DialogScreen(this, route.chatId)
      this.setSingle({ name: 'dialog', element: dialog.element, update: () => dialog.update(), dispose: () => dialog.dispose() })
      this.store.set({ chatId: route.chatId, snapshot: null })
      void dialog.open(route.chatId)
      return
    }
    this.store.set({ chatId: null, snapshot: null })
    if (route.name === 'chats') {
      const chats = new ChatsScreen(this)
      this.setSingle({ name: 'chats', element: chats.element, update: () => chats.update() })
      chats.update()
      void this.refreshSummaries()
    } else {
      const settings = new SettingsScreen(this)
      this.setSingle({ name: 'settings', element: settings.element, update: () => settings.render() })
      settings.render()
    }
  }

  // десктоп: список чатов — постоянная левая панель, справа — диалог/настройки
  private mountDesktop(route: Route): void {
    if (!this.appShell) {
      this.appShell = h('div', { class: 'app-shell' })
      this.sidebar = new ChatsScreen(this)
      const sidebarWrap = h('div', { class: 'sidebar' })
      sidebarWrap.appendChild(this.sidebar.element)
      this.mainPane = h('div', { class: 'main-pane' })
      this.appShell.append(sidebarWrap, this.mainPane)
      this.root.replaceChildren(this.appShell)
      this.root.appendChild(this.callOverlay.element)
      this.sidebar.update()
      void this.refreshSummaries()
    }
    this.current?.dispose?.()
    this.current = null
    this.mainPane!.replaceChildren()
    if (route.name === 'dialog') {
      if (!this.ctx.messenger) return this.navigate({ name: 'login' }, true)
      const dialog = new DialogScreen(this, route.chatId)
      this.current = { name: 'dialog', element: dialog.element, update: () => dialog.update(), dispose: () => dialog.dispose() }
      this.mainPane!.appendChild(dialog.element)
      this.store.set({ chatId: route.chatId, snapshot: null })
      void dialog.open(route.chatId)
    } else if (route.name === 'settings') {
      const settings = new SettingsScreen(this)
      this.current = { name: 'settings', element: settings.element, update: () => settings.render() }
      this.mainPane!.appendChild(settings.element)
      settings.render()
    } else {
      this.store.set({ chatId: null, snapshot: null })
      this.mainPane!.appendChild(
        h('div', { class: 'desktop-empty' }, h('span', { class: 'empty-icon' }, icon('send', { size: 48 })), h('p', { text: 'Выберите чат слева' })),
      )
    }
  }

  private teardownDesktop(): void {
    this.sidebar = null
    this.appShell = null
    this.mainPane = null
  }

  private setSingle(handle: ScreenHandle): void {
    this.teardownDesktop()
    this.current?.dispose?.()
    this.current = handle
    this.root.replaceChildren(handle.element)
    this.root.appendChild(this.callOverlay.element)
  }

  private renderCurrent(): void {
    this.current?.update?.()
    this.sidebar?.update()
    this.callOverlay.update(this.state.callView)
  }

  // ─── связка с мессенджером ──────────────────────────────────────────────

  private wireSession(): void {
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe()
    const messenger = this.ctx.messenger
    const calls = this.ctx.calls
    if (!messenger || !calls) return
    this.unsubscribers.push(
      messenger.onEvent((event) => {
        if (event.type === 'call') {
          if (event.verdict.kind !== 'mute') {
            void calls.onCallEvent(event.from, event.verdict.event, event.self)
          }
          return
        }
        if (event.type === 'presence') {
          this.store.set({ connected: event.connected })
          return
        }
        if (event.type === 'keys-changed') {
          if (event.peer === this.state.chatId) this.store.set({ reverify: { devices: event.devices, isNewDevice: event.isNewDevice } })
          snackbar(event.isNewDevice ? t('safetyChangedNew') : t('safetyChangedTitle'), { kind: 'error' })
          return
        }
        if (event.type === 'error') {
          snackbar(event.message, { kind: 'error' })
          return
        }
        const affectsDialog = !event.chatId || event.chatId === this.state.chatId
        void this.refreshSummaries()
        if (affectsDialog && this.state.route.name === 'dialog') void this.refreshDialog()
        if (event.chatId && document.visibilityState !== 'visible') void this.notifyIncoming(event.chatId)
      }),
      calls.onUpdate((view) => {
        this.store.set({ callView: view })
        this.syncCallTimer(view.state.phase === 'active')
      }),
    )
  }

  private syncCallTimer(active: boolean): void {
    if (active && !this.callTimer) {
      this.callTimer = setInterval(() => this.callOverlay.tick(this.state.callView), 1_000)
    } else if (!active && this.callTimer) {
      clearInterval(this.callTimer)
      this.callTimer = null
    }
  }

  private async notifyIncoming(chatId: string): Promise<void> {
    if (!this.ctx.prefs.notifications) return
    const summary = this.state.summaries.find((chat) => chat.chatId === chatId) ?? (await this.ctx.messenger?.chatSummaries())?.find((chat) => chat.chatId === chatId)
    if (!summary) return
    const body = notificationBody(this.ctx.prefs.notificationText, summary, this.ctx.session?.login ?? '')
    await notifyMessage(summary.title, body)
  }

  private onVisibility(): void {
    if (document.visibilityState !== 'visible') return
    this.ctx.calls?.resumeAudio()
    void this.ctx.messenger?.flushOutbox()
    void this.ctx.messenger?.drainAll()
    if (this.state.route.name === 'dialog') this.scheduleMarkRead()
  }

  private onGlobalKey(event: KeyboardEvent): void {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault()
      this.navigate({ name: 'chats' })
    }
  }

  // ─── данные ─────────────────────────────────────────────────────────────

  async refreshSummaries(): Promise<void> {
    const messenger = this.ctx.messenger
    if (!messenger) return
    const [summaries, failedSends] = await Promise.all([messenger.chatSummaries(), messenger.failedSends()])
    this.store.set({ summaries, failedSends, version: this.state.version + 1 })
  }

  async refreshDialog(): Promise<void> {
    const messenger = this.ctx.messenger
    const chatId = this.state.chatId
    if (!messenger || !chatId) return
    const [snapshot, reverify, online] = await Promise.all([
      messenger.chatSnapshot(chatId),
      messenger.reverifyPending(chatId),
      messenger.checkOnline(chatId).catch(() => null),
    ])
    const presence = online ? { online: online.online, lastSeen: online.lastSeenUnix * 1000 } : null
    const failedSends = await messenger.failedSends()
    this.store.set({ snapshot, reverify, presence, failedSends, chatLoading: false, version: this.state.version + 1 })
    if (document.visibilityState === 'visible') this.scheduleMarkRead()
  }

  private scheduleMarkRead(): void {
    if (this.readTimer) clearTimeout(this.readTimer)
    this.readTimer = setTimeout(() => {
      const chatId = this.state.chatId
      if (chatId) void this.ctx.messenger?.markRead(chatId)
    }, 500)
  }

  async openChat(chatId: string): Promise<void> {
    this.navigate({ name: 'dialog', chatId })
  }

  showChats(): void {
    this.navigate({ name: 'chats' })
  }

  showSettings(): void {
    this.navigate({ name: 'settings' })
  }

  toast(message: string, kind: 'info' | 'error' | 'success' = 'info'): void {
    snackbar(message, { kind })
  }

  errorMessage(error: unknown): string {
    if (error instanceof RelayError) {
      if (error.status === 404) return t('errorNotFound')
      if (error.status === 401) return t('errorTokenRevoked')
      return error.message
    }
    if (error instanceof Error) return error.message
    return t('errorGeneric')
  }

  // ─── баннер установки ───────────────────────────────────────────────────

  private renderInstallBanner(): void {
    const shouldShow = this.state.route.name === 'chats' && !isStandalone() && !this.ctx.prefs.installPromptSeen
    if (!shouldShow) {
      this.installBanner?.remove()
      this.installBanner = null
      return
    }
    if (this.installBanner) return
    const ua = navigator.userAgent
    const safari = /^((?!chrome|android|crios|fxios).)*safari/i.test(ua)
    const button = h('button', {
      class: 'btn small primary',
      text: this.state.installAvailable ? t('installApp') : t('installDismiss'),
      onclick: async () => {
        if (this.state.installAvailable) {
          await installState.install()
        } else {
          await this.ctx.savePrefs({ installPromptSeen: true })
        }
        this.renderInstallBanner()
      },
    })
    this.installBanner = h(
      'div',
      { class: 'install-banner' },
      icon('download', { size: 20 }),
      h('span', { text: safari ? `${t('installHint')} ${t('installIos')}` : t('installHint') }),
      button,
      h('button', {
        class: 'icon-btn',
        'aria-label': t('installDismiss'),
        onclick: async () => {
          await this.ctx.savePrefs({ installPromptSeen: true })
          this.renderInstallBanner()
        },
      }, icon('close', { size: 18 })),
    )
    this.root.appendChild(this.installBanner)
  }
}

function routeToHash(route: Route): string {
  switch (route.name) {
    case 'login':
      return '#/login'
    case 'chats':
      return '#/chats'
    case 'settings':
      return '#/settings'
    case 'dialog':
      return `#/chat/${encodeURIComponent(route.chatId)}`
  }
}

function hashToRoute(hash: string): Route {
  const value = hash.replace(/^#\/?/, '')
  if (value.startsWith('chat/')) return { name: 'dialog', chatId: decodeURIComponent(value.slice(5)) }
  if (value === 'settings') return { name: 'settings' }
  if (value === 'chats') return { name: 'chats' }
  return { name: 'login' }
}

