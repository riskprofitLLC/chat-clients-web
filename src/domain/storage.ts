// Хранилище (P-W1): чистый свод занятого места по категориям. На вход —
// плоский список «ключ → размер» из Kv (IndexedDB), на выход — байты по
// категориям и итог. Логика без DOM и без браузера — тестируется на памяти.
export type StorageCategoryId = 'media' | 'history' | 'queue' | 'other'

export interface CategoryRule {
  id: StorageCategoryId
  // префиксы ключей Kv, которые попадают в категорию
  prefixes: string[]
}

// порядок важен: ключ попадает в ПЕРВУЮ подошедшую категорию
export const CATEGORY_RULES: readonly CategoryRule[] = [
  { id: 'media', prefixes: ['media:', 'mm:'] },
  { id: 'history', prefixes: ['j:', 'jm:', 'jr:'] },
  { id: 'queue', prefixes: ['outbox:', 'poison:'] },
  {
    id: 'other',
    prefixes: ['draft:', 'pin:', 'read:', 'contact:', 'group:', 'profile:', 'call:', 'tofu:', 'blk:', 'prefs', 'secrets:'],
  },
]

export interface StorageEntry {
  key: string
  size: number
}

export interface StorageUsage {
  mediaBytes: number
  historyBytes: number
  queueBytes: number
  otherBytes: number
  totalBytes: number
}

// категория ключа: первое совпадение по префиксу, иначе «прочее»
export function categoryOf(key: string): StorageCategoryId {
  for (const rule of CATEGORY_RULES) {
    if (rule.prefixes.some((prefix) => key.startsWith(prefix))) return rule.id
  }
  return 'other'
}

// свод по категориям: totalBytes — вся база, а не сумма известных префиксов
export function usageOf(entries: readonly StorageEntry[]): StorageUsage {
  const usage: StorageUsage = { mediaBytes: 0, historyBytes: 0, queueBytes: 0, otherBytes: 0, totalBytes: 0 }
  for (const entry of entries) {
    usage[`${categoryOf(entry.key)}Bytes`] += entry.size
    usage.totalBytes += entry.size
  }
  return usage
}