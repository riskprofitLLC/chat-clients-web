// Дедупликация входящих: LRU-набор ключей. Один и тот же блоб дважды
// (повтор transfer, ретрай доставки) не должен плодить записи в истории.
export class DedupIndex {
  private readonly seenMap = new Map<string, true>()

  constructor(private readonly capacity = 1024) {}

  // true — такой ключ уже был (и он переставлен в конец как свежий)
  remember(key: string): boolean {
    const known = this.seenMap.has(key)
    this.seenMap.delete(key)
    this.seenMap.set(key, true)
    if (this.seenMap.size > this.capacity) {
      const oldest = this.seenMap.keys().next()
      if (!oldest.done) this.seenMap.delete(oldest.value)
    }
    return known
  }

  // проверка без запоминания: карантин/отклонённые блобы не засоряют индекс
  seen(key: string): boolean {
    return this.seenMap.has(key)
  }

  clear(): void {
    this.seenMap.clear()
  }
}
