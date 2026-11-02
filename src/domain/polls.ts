// Агрегация голосов опроса: последняя запись каждого автора, как у реакций.
// Стоп учитывается только от автора опроса. Логика чистая.

export interface VoteEntry {
  ts: number
  author: string
  choice: number // -1 — снятие
  stop: boolean
}

export interface PollState {
  // автор → индекс варианта (снявшие отсутствуют)
  votes: Map<string, number>
  mine: number | null
  closed: boolean
  counts: number[]
}

export function aggregateVotes(
  entries: VoteEntry[],
  options: number,
  pollAuthor: string,
  myLogin: string,
): PollState {
  const ordered = [...entries].sort((a, b) => a.ts - b.ts)
  const lastPerAuthor = new Map<string, VoteEntry>()
  for (const entry of ordered) lastPerAuthor.set(entry.author, entry)
  const votes = new Map<string, number>()
  let closed = false
  for (const [author, entry] of lastPerAuthor) {
    if (entry.stop) {
      if (author === pollAuthor) closed = true
      continue
    }
    if (entry.choice >= 0 && entry.choice < options) votes.set(author, entry.choice)
  }
  const counts = new Array<number>(options).fill(0)
  for (const choice of votes.values()) counts[choice] += 1
  const mine = votes.get(myLogin) ?? null
  return { votes, mine, closed, counts }
}
