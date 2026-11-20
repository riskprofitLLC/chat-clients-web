// Мультивыбор сообщений (P-W7): чистые правила выделения — что переключается
// тапом и что попадает в массовые действия.
import { describe, expect, it } from 'vitest'
import * as Env from '../src/protocol/envelope.js'
import { SystemFormat } from '../src/protocol/formats.js'
import type { MessageRecord } from '../src/store/journal.js'
import { buildFeed, type FeedItem } from '../src/domain/feed.js'
import {
  canSelect,
  forwardableSelected,
  selectAllRefs,
  selectedItems,
  selectionTitle,
  toggleSelection,
} from '../src/domain/selection.js'

async function item(from: string, text: string): Promise<FeedItem> {
  const record: MessageRecord = { from, timestamp: Date.now(), content: Env.escapeText(text) }
  const feed = await buildFeed([record], 'me')
  return feed[0]
}

describe('правила выделения', () => {
  it('тап переключает выбор и снимает его повторным тапом', async () => {
    const first = await item('bob', 'раз')
    const second = await item('bob', 'два')
    let selected = [first.ref]
    selected = toggleSelection(selected, second.ref)
    expect(selected).toEqual([first.ref, second.ref])
    selected = toggleSelection(selected, first.ref)
    expect(selected).toEqual([second.ref])
  })

  it('«выбрать все» берёт всё, кроме служебных записей чата', async () => {
    const text = await item('bob', 'привет')
    const systemRecord: MessageRecord = { from: 'bob', timestamp: Date.now() + 1, content: SystemFormat.encode('создана группа') }
    const feed = await buildFeed([text.record, systemRecord], 'me')
    expect(canSelect(feed[0])).toBe(true)
    expect(canSelect(feed[1])).toBe(false)
    expect(selectAllRefs(feed)).toEqual([feed[0].ref])  })

  it('пересылаются все выделенные, служебные отсеиваются', async () => {
    const text = await item('bob', 'привет')
    const systemRecord: MessageRecord = { from: 'bob', timestamp: Date.now() + 1, content: SystemFormat.encode('создана группа') }
    const feed = await buildFeed([text.record, systemRecord], 'me')
    expect(forwardableSelected(feed)).toEqual([feed[0]])
  })

  it('выбранные извлекаются из ленты по ref', async () => {
    const first = await item('bob', 'раз')
    const second = await item('bob', 'два')
    expect(selectedItems([first, second], [second.ref])).toEqual([second])
  })

  it('подпись шапки считает выбранные', () => {
    expect(selectionTitle(1)).toBe('1 выбрано')
    expect(selectionTitle(3)).toBe('3 выбрано')
  })
})
