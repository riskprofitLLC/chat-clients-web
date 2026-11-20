// Мультивыбор сообщений в диалоге (P-W7): чистые правила выделения —
// что переключается тапом и что попадает в массовые действия.
import type { FeedItem } from './feed.js'

// служебные записи (создание группы, звонки) выделять бессмысленно:
// пересылать и удалять их нечем
export function canSelect(item: FeedItem): boolean {
  return item.kind?.kind !== 'system'
}

export function toggleSelection(selected: readonly string[], ref: string): string[] {
  return selected.includes(ref) ? selected.filter((value) => value !== ref) : [...selected, ref]
}

export function selectAllRefs(items: readonly FeedItem[]): string[] {
  return items.filter(canSelect).map((item) => item.ref)
}

export function selectedItems(items: readonly FeedItem[], selected: readonly string[]): FeedItem[] {
  const chosen = new Set(selected)
  return items.filter((item) => chosen.has(item.ref))
}

// пересылаются все выделенные, кроме служебных записей чата
export function forwardableSelected(items: readonly FeedItem[]): FeedItem[] {
  return items.filter(canSelect)
}

// подпись шапки режима выбора
export function selectionTitle(count: number): string {
  return `${count} выбрано`
}