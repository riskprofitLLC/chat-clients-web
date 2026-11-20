// @vitest-environment happy-dom
// Просмотрщик историй: подпись, остаток времени, листание по кругу
// и модальное окно с кнопкой закрытия.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { formatStoryLeft, openStoryViewer } from '../src/ui/screens/story-viewer.js'
import { closeModal } from '../src/ui/components/modal.js'
import type { StoryItem } from '../src/domain/story-feed.js'
import type { MediaInfo } from '../src/protocol/formats.js'

function media(thumb: string): MediaInfo {
  return {
    id: 'm1',
    key: new Uint8Array(),
    size: 100,
    width: 10,
    height: 10,
    thumb,
    type: 'media',
    duration: 0,
    spoiler: false,
    sticker: false,
    videoNote: false,
    silent: false,
    viewOnce: false,
  }
}

function item(author: string, exp: number, caption?: string): StoryItem {
  return { author, timestamp: 1_700_000_000_000, exp, caption, media: media(`blob:${author}`) }
}

afterEach(() => {
  closeModal()
  vi.useRealTimers()
})

function box(): HTMLElement {
  return document.querySelector('.story-view')!
}

describe('formatStoryLeft', () => {
  it('.минуты без часов и часы с ведущим нулём минут', () => {
    expect(formatStoryLeft(5 * 60_000)).toBe('5м')
    expect(formatStoryLeft(12 * 3_600_000 + 5 * 60_000)).toBe('12ч 05м')
    // истёкшая история не даёт отрицательных значений
    expect(formatStoryLeft(-1_000)).toBe('0м')
  })
})

describe('openStoryViewer', () => {
  it('.модальное окно с автором, фото и остатком времени', () => {
    // фиксированное время: остаток не зависит от миллисекунд прогона
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-20T10:00:00Z'))
    openStoryViewer('bob', [item('bob', Date.now() + 3_600_000 + 60_000, 'отдых')])
    const sheet = document.querySelector('.modal-sheet')!
    expect(sheet.querySelector('.story-author')!.textContent).toBe('bob')
    expect(sheet.querySelector('.story-left')!.textContent).toBe('1ч 01м')
    const img = sheet.querySelector<HTMLImageElement>('.story-photo')!
    expect(img.getAttribute('src')).toBe(`data:image/jpeg;base64,blob:bob`)
    expect(img.getAttribute('alt')).toBe('отдых')
    expect(sheet.querySelector('.story-caption')!.textContent).toBe('отдых')
  })

  it('.без подписи блока описания нет', () => {
    openStoryViewer('bob', [item('bob', Date.now() + 60_000)])
    expect(document.querySelector('.story-caption')).toBeNull()
  })

  it('.листание по кругу: вперёд, назад и через границу', () => {
    const now = Date.now()
    openStoryViewer('bob', [item('a', now + 60_000), item('b', now + 120_000), item('c', now + 180_000)])
    const nav = document.querySelectorAll<HTMLButtonElement>('.story-nav .btn')
    expect(nav).toHaveLength(2)
    // стартуем с первой истории
    expect(box().querySelector('.story-photo')!.getAttribute('src')).toContain('blob:a')
    nav[1]!.click()
    expect(box().querySelector('.story-photo')!.getAttribute('src')).toContain('blob:b')
    nav[0]!.click()
    expect(box().querySelector('.story-photo')!.getAttribute('src')).toContain('blob:a')
    // назад из первой — на последнюю (кольцо)
    nav[0]!.click()
    expect(box().querySelector('.story-photo')!.getAttribute('src')).toContain('blob:c')
  })
})

describe('openStoryViewer с одной историей', () => {
  it('.навигации нет — листать нечего', () => {
    openStoryViewer('bob', [item('a', Date.now() + 60_000)])
    expect(document.querySelector('.story-nav')).toBeNull()
  })
})
