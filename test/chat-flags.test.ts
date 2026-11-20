// Локальные флаги списка чатов: архив, «непрочитано вручную», «без звука».
import { describe, expect, it } from 'vitest'
import { ChatFlagsStore } from '../src/store/chat-flags.js'
import { MemoryKv } from '../src/store/kv.js'

describe('ChatFlagsStore', () => {
  it('пустое хранилище даёт пустые наборы', async () => {
    const store = new ChatFlagsStore(new MemoryKv())
    expect(await store.all()).toEqual({ markedUnread: [], archived: [], muted: [] })
  })

  it('флаг ставится и снимается', async () => {
    const store = new ChatFlagsStore(new MemoryKv())
    await store.set('archive', 'bob', true)
    const flags = await store.all()
    expect(store.has(flags, 'archive', 'bob')).toBe(true)
    expect(store.has(flags, 'archive', 'alice')).toBe(false)
    await store.set('archive', 'bob', false)
    expect(store.has(await store.all(), 'archive', 'bob')).toBe(false)
  })

  it('повторная установка не даёт дублей', async () => {
    const store = new ChatFlagsStore(new MemoryKv())
    await store.set('unread', 'bob', true)
    await store.set('unread', 'bob', true)
    expect((await store.all()).markedUnread).toEqual(['bob'])
  })

  it('виды флагов независимы и переживают перезапуск', async () => {
    const kv = new MemoryKv()
    const first = new ChatFlagsStore(kv)
    await first.set('mute', 'bob', true)
    await first.set('unread', 'alice', true)
    const second = new ChatFlagsStore(kv)
    const flags = await second.all()
    expect(flags.muted).toEqual(['bob'])
    expect(flags.markedUnread).toEqual(['alice'])
  })

  it('битое значение не роняет экран', async () => {
    const kv = new MemoryKv()
    await kv.put('chat-flags', new TextEncoder().encode('{{ не json'))
    expect(await new ChatFlagsStore(kv).all()).toEqual({ markedUnread: [], archived: [], muted: [] })
  })
})