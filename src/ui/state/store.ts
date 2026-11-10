// Минимальный реактивный стор: один объект состояния + подписчики.
// Перерисовка коалесцируется через requestAnimationFrame — пачка событий
// (дрейн, typing, presence) даёт один render на кадр.
export class Store<T extends object> {
  private state: T
  private readonly listeners = new Set<() => void>()
  private scheduled = false
  private frame: number | null = null

  constructor(initial: T) {
    this.state = initial
  }

  get(): T {
    return this.state
  }

  set(patch: Partial<T>): void {
    this.state = { ...this.state, ...patch }
    this.schedule()
  }

  // подписка без немедленного вызова: рендер делает сам экран
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  // внеочередная синхронная рассылка (навигация)
  flush(): void {
    if (this.frame !== null) {
      cancelAnimationFrame(this.frame)
      this.frame = null
    }
    this.scheduled = false
    for (const listener of this.listeners) listener()
  }

  private schedule(): void {
    if (this.scheduled) return
    this.scheduled = true
    this.frame = requestAnimationFrame(() => {
      this.frame = null
      this.scheduled = false
      for (const listener of this.listeners) listener()
    })
  }
}
