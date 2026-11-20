// Агрегация реакций: последняя запись каждого автора на цель.
// Пустой эмодзи — снятие реакции автором. Логика чистая (тесты без DOM).

export interface ReactionEntry {
  ts: number
  author: string
  emoji: string
}

export interface ReactionState {
  // эмодзи → авторы (в порядке появления, стабильно для UI)
  byEmoji: Map<string, string[]>
  mine: string | null
}

export function aggregateReactions(entries: ReactionEntry[], myLogin: string): ReactionState {
  // авторы упорядочены по времени первой реакции — палитра не «прыгает»
  const ordered = [...entries].sort((a, b) => a.ts - b.ts)
  const lastPerAuthor = new Map<string, string>()
  for (const entry of ordered) lastPerAuthor.set(entry.author, entry.emoji)
  const byEmoji = new Map<string, string[]>()
  for (const [author, emoji] of lastPerAuthor) {
    if (!emoji) continue
    const list = byEmoji.get(emoji) ?? []
    list.push(author)
    byEmoji.set(emoji, list)
  }
  const mine = lastPerAuthor.get(myLogin) || null
  return { byEmoji, mine }
}

export function reactionSummary(state: ReactionState, limit = 3): Array<{ emoji: string; count: number }> {
  return [...state.byEmoji.entries()]
    .map(([emoji, authors]) => ({ emoji, count: authors.length }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit)
}
