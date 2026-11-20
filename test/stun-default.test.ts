// @vitest-environment happy-dom
// Свой STUN вместо Google: дефолт prefs и восстановление адреса при пустом
// сохранении в редакторе звонков; поведение редактора TURN не меняется.
import { describe, expect, it } from 'vitest'
import { DEFAULT_PREFS, DEFAULT_STUN_URL, PrefsStore } from '../src/store/prefs.js'
import { MemoryKv } from '../src/store/kv.js'
import { SettingsScreen } from '../src/ui/screens/settings.js'
import type { AppHost } from '../src/ui/host.js'
import type { Prefs } from '../src/store/prefs.js'

function prefsFixture(iceServers: Prefs['iceServers']): Prefs {
  return { ...DEFAULT_PREFS, serverUrl: 'https://relay.test', iceServers }
}

function settingsHost(iceServers: Prefs['iceServers']) {
  const saved: Partial<Prefs>[] = []
  const ctx = {
    prefs: prefsFixture(iceServers),
    storagePersisted: true,
    messenger: { session: { login: 'me' }, setDraft: async () => undefined },
    savePrefs: async (changes: Partial<Prefs>) => {
      saved.push(changes)
    },
  }
  const host = {
    store: null,
    get state() {
      return {}
    },
    navigate: () => undefined,
    refreshSummaries: async () => undefined,
    refreshDialog: async () => undefined,
    openChat: async () => undefined,
    showChats: () => undefined,
    showSettings: () => undefined,
    toast: () => undefined,
    errorMessage: () => 'ошибка',
    ctx,
  }
  return { host: host as unknown as AppHost, saved }
}

describe('дефолтный STUN — свой сервер', () => {
  it('константа и дефолт prefs указывают на ednar.duckdns.org:3478', () => {
    expect(DEFAULT_STUN_URL).toBe('stun:ednar.duckdns.org:3478')
    expect(DEFAULT_PREFS.iceServers).toEqual([{ urls: DEFAULT_STUN_URL }])
  })

  it('Google STUN нигде в дефолтах не остаётся', () => {
    const urls = DEFAULT_PREFS.iceServers.map((server) => server.urls)
    expect(urls.some((url) => url.includes('google'))).toBe(false)
  })

  it('PrefsStore подставляет дефолтный STUN старым настройкам без iceServers', async () => {
    const kv = new MemoryKv()
    await kv.put('prefs', new TextEncoder().encode(JSON.stringify({ theme: 'dark' })))
    const loaded = await new PrefsStore(kv).load()
    expect(loaded.theme).toBe('dark')
    expect(loaded.iceServers).toEqual([{ urls: DEFAULT_STUN_URL }])
  })
})

describe('редактор звонков:', () => {
  it('пустое поле сохраняет свой STUN по умолчанию', async () => {
      const { host, saved } = settingsHost([])
      const screen = new SettingsScreen(host)
      screen.render()
      const inputs = screen.element.querySelectorAll<HTMLInputElement>('.form.inset input')
      inputs[0].value = '   '
      screen.element.querySelector<HTMLButtonElement>('.form.inset .btn.primary')!.click()
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(saved).toHaveLength(1)
      expect(saved[0].iceServers).toEqual([{ urls: DEFAULT_STUN_URL }])
    })

  it('заполненный список TURN сохраняется как есть', async () => {
      const { host, saved } = settingsHost([{ urls: 'turn:turn.test:3478', username: 'u', credential: 'p' }])
      const screen = new SettingsScreen(host)
      screen.render()
      const inputs = screen.element.querySelectorAll<HTMLInputElement>('.form.inset input')
      expect(inputs[0].value).toBe('turn:turn.test:3478')
      inputs[0].value = 'turn:a.test:3478, turn:b.test:3478'
      screen.element.querySelector<HTMLButtonElement>('.form.inset .btn.primary')!.click()
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(saved[0].iceServers).toEqual([
        { urls: 'turn:a.test:3478', username: 'u', credential: 'p' },
        { urls: 'turn:b.test:3478', username: 'u', credential: 'p' },
      ])
    })
})