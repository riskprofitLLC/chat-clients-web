// Хранилище (P-W1): свод размеров по категориям из Kv и очистка кэша медиа.
import { describe, expect, it } from 'vitest'
import { MemoryKv } from '../src/store/kv.js'
import { categoryOf, usageOf } from '../src/domain/storage.js'
import { measureKv, storageUsage } from '../src/store/storage.js'
import { MediaCache } from '../src/store/chat-state.js'
import { Journal } from '../src/store/journal.js'
import { SecretsStore } from '../src/store/secrets.js'
import * as Env from '../src/protocol/envelope.js'

describe('категории хранилища', () => {
  it('ключ попадает в первую подошедшую категорию', () => {
    expect(categoryOf('media:abc')).toBe('media')
    expect(categoryOf('mm:abc')).toBe('media')
    expect(categoryOf('j:chat:000000000001')).toBe('history')
    expect(categoryOf('jm:chat')).toBe('history')
    expect(categoryOf('outbox:1:x')).toBe('queue')
    expect(categoryOf('draft:chat')).toBe('other')
    expect(categoryOf('неизвестный-ключ')).toBe('other')
  })

  it('свод суммирует по категориям и считает весь объём', () => {
    const usage = usageOf([
      { key: 'media:a', size: 100 },
      { key: 'mm:a', size: 20 },
      { key: 'j:c:1', size: 50 },
      { key: 'outbox:x', size: 30 },
      { key: 'prefs', size: 10 },
    ])
    expect(usage.mediaBytes).toBe(120)
    expect(usage.historyBytes).toBe(50)
    expect(usage.queueBytes).toBe(30)
    expect(usage.otherBytes).toBe(10)
    expect(usage.totalBytes).toBe(210)
  })
})

describe('замер по Kv (P-W1)', () => {
  it('считает байты истории и кэша медиа, очистка медиа уменьшает свод', async () => {
    const kv = new MemoryKv()
    const secrets = new SecretsStore(kv)
    const journal = new Journal(kv, await secrets.ensureDataKey())
    await journal.append('bob', { from: 'bob', timestamp: 1_700_000_000_000, content: Env.escapeText('привет') })
    const media = new MediaCache(kv)
    await media.put('id1', new Uint8Array(2048))
    await media.put('id2', new Uint8Array(1024))

    const before = await storageUsage(kv)
    expect(before.mediaBytes).toBeGreaterThanOrEqual(3072)
    expect(before.historyBytes).toBeGreaterThan(0)
    expect(before.totalBytes).toBeGreaterThan(before.mediaBytes)
    // размеры — байты значений, ключи не тащим в память
    expect((await measureKv(kv)).every((entry) => entry.size > 0)).toBe(true)

    await media.clear()
    const after = await storageUsage(kv)
    expect(after.mediaBytes).toBe(0)
    expect(after.historyBytes).toBe(before.historyBytes)
    expect(await media.has('id1')).toBe(false)
  })
})
