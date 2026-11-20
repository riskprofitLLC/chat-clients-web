// @vitest-environment happy-dom
// Экран профиля: шапка, карточка с аватаром и «о себе», ряд устройства,
// редактирование описания (отмена, сохранение, ререндер).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProfileScreen } from '../src/ui/screens/profile.js'
import type { AppHost } from '../src/ui/host.js'

interface Fake {
  host: AppHost
  saved: string[]
  rendered: number
}

function makeFake(options?: { bio?: string | null; login?: string; deviceId?: string }): Fake {
  const saved: string[] = []
  const rendered = { count: 0 }
  let bio = options?.bio ?? ''
  const messenger = {
    session: { login: options?.login ?? 'bob', deviceId: options?.deviceId ?? 'dev-1' },
    setBio: async (value: string) => {
      saved.push(value)
      bio = value
    },
  }
  const profiles = {
    get: async () => (options?.bio === null ? null : { login: 'bob', bio, avatarId: '', updatedAt: 1 }),
  }
  const host = {
    ctx: { messenger, profiles },
    showChats: () => undefined,
  } as unknown as AppHost
  return { host, saved, rendered: rendered.count }
}

// ждём микротаски: render() экрана асинхронный (профиль из хранилища)
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ProfileScreen', () => {
  it('.карточка: аватар, логин, описание и устройство', async () => {
    const fake = makeFake({ bio: 'люблю кофе' })
    const screen = new ProfileScreen(fake.host)
    await flush()
    expect(screen.element.className).toBe('screen profile-screen')
    expect(screen.element.querySelector('.topbar h1')!.textContent).toBe('Профиль')
    expect(screen.element.querySelector('.profile-login')!.textContent).toBe('@bob')
    expect(screen.element.querySelector('.profile-meta .muted')!.textContent).toBe('люблю кофе')
    expect(screen.element.querySelector('.avatar-initials')!.textContent).toBe('B')
    // ряд устройства показывает deviceId сессии
    expect(screen.element.querySelector('.setting-label .muted')!.textContent).toBe('dev-1')
  })

  it('.без профиля в хранилище блок описания не появляется', async () => {
    const fake = makeFake({ bio: null })
    const screen = new ProfileScreen(fake.host)
    await flush()
    expect(screen.element.querySelector('.profile-meta .muted')).toBeNull()
  })

  it('.без мессенджера логин пустой, устройство без подписи', async () => {
    const host = { ctx: { messenger: null, profiles: { get: async () => null } } } as unknown as AppHost
    const screen = new ProfileScreen(host)
    await flush()
    expect(screen.element.querySelector('.profile-login')!.textContent).toBe('@')
    expect(screen.element.querySelector('.setting-label .muted')!.textContent).toBe('')
  })
})

describe('ProfileScreen.editBio', () => {
  it('.отмена модалки ничего не сохраняет', async () => {
    const fake = makeFake()
    const screen = new ProfileScreen(fake.host)
    await flush()
    // promptModal подменяем: null — пользователь закрыл окно
    const modal = await import('../src/ui/components/modal.js')
    const spy = vi.spyOn(modal, 'promptModal').mockResolvedValue(null)
    await screen.element.querySelector<HTMLButtonElement>('.profile-card .btn')!.click()
    await flush()
    expect(spy).toHaveBeenCalledTimes(1)
    expect(fake.saved).toEqual([])
  })

  it('.сохранение уходит в мессенджер и экран перерисовывается', async () => {
    const fake = makeFake()
    const screen = new ProfileScreen(fake.host)
    await flush()
    const modal = await import('../src/ui/components/modal.js')
    vi.spyOn(modal, 'promptModal').mockResolvedValue('новое описание')
    await screen.element.querySelector<HTMLButtonElement>('.profile-card .btn')!.click()
    await flush()
    expect(fake.saved).toEqual(['новое описание'])
    // профиль перечитан после сохранения — описание появилось в карточке
    expect(screen.element.querySelector('.profile-meta .muted')!.textContent).toBe('новое описание')
  })
})
