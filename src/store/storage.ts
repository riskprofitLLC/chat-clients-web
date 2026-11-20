// Замер занятого места (P-W1): скан всех ключей Kv с размерами значений.
// Значения читаем как длины, а не содержимое: свод не должен тащить
// мегабайты медиа в память.
import { usageOf, type StorageEntry, type StorageUsage } from '../domain/storage.js'
import type { Kv } from './kv.js'

export async function measureKv(kv: Kv): Promise<StorageEntry[]> {
  const entries = await kv.list('')
  return entries.map((entry) => ({ key: entry.key, size: entry.value.byteLength }))
}

export async function storageUsage(kv: Kv): Promise<StorageUsage> {
  return usageOf(await measureKv(kv))
}