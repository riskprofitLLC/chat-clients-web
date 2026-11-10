// Ключ-значение хранилище с префиксным сканом.
// Прод — IndexedDB (единственное доступное в браузере место, где живёт
// локальная история); тесты — in-memory реализация с теми же гарантиями,
// поэтому логика журнала проверяется без jsdom и без браузера.
export interface KvEntry {
  key: string
  value: Uint8Array
}

export interface Kv {
  get(key: string): Promise<Uint8Array | null>
  put(key: string, value: Uint8Array): Promise<void>
  delete(key: string): Promise<void>
  // скан по префиксу; reverse — от старших ключей к младшим (хвост журнала)
  list(prefix: string, options?: { reverse?: boolean; limit?: number }): Promise<KvEntry[]>
  deletePrefix(prefix: string): Promise<void>
  clear(): Promise<void>
  // закрытие соединения перед полным удалением базы
  close(): void
}

// Ключи сравниваются как строки: журнал использует zero-padded номера,
// поэтому лексикографический порядок совпадает с числовым.
export function padSeq(seq: number): string {
  return String(seq).padStart(12, '0')
}

export class MemoryKv implements Kv {
  private readonly map = new Map<string, Uint8Array>()

  async get(key: string): Promise<Uint8Array | null> {
    const value = this.map.get(key)
    return value ? value.slice() : null
  }

  async put(key: string, value: Uint8Array): Promise<void> {
    this.map.set(key, value.slice())
  }

  async delete(key: string): Promise<void> {
    this.map.delete(key)
  }

  async list(prefix: string, options?: { reverse?: boolean; limit?: number }): Promise<KvEntry[]> {
    const keys = [...this.map.keys()].filter((k) => k.startsWith(prefix)).sort()
    const ordered = options?.reverse ? keys.reverse() : keys
    const limited = options?.limit !== undefined ? ordered.slice(0, options.limit) : ordered
    return limited.map((key) => ({ key, value: this.map.get(key)!.slice() }))
  }

  async deletePrefix(prefix: string): Promise<void> {
    for (const key of [...this.map.keys()]) if (key.startsWith(prefix)) this.map.delete(key)
  }

  async clear(): Promise<void> {
    this.map.clear()
  }

  close(): void {
    // у памяти соединения нет
  }
}

const DB_NAME = 'chat-web'
const DB_VERSION = 1
const STORE = 'kv'

// IndexedDB-реализация: одна объект-стор с ключом-строкой; префиксный скан —
// по диапазону ключей, поэтому хвост журнала читается без обхода истории
export class IdbKv implements Kv {
  private db: IDBDatabase | null = null

  private async open(): Promise<IDBDatabase> {
    if (this.db) return this.db
    this.db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION)
      request.onupgradeneeded = () => {
        const db = request.result
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
      }
      request.onsuccess = () => {
        const db = request.result
        // другая вкладка открыла новую версию — закрываемся, чтобы не блокировать
        db.onversionchange = () => {
          db.close()
          if (this.db === db) this.db = null
        }
        resolve(db)
      }
      request.onblocked = () => reject(new Error('IndexedDB заблокирована другой вкладкой'))
      request.onerror = () => reject(request.error ?? new Error('IndexedDB недоступна'))
    })
    return this.db
  }

  // ждём oncomplete транзакции, а не onsuccess запроса: только тогда запись
  // гарантированно на диске (иначе «WAL» outbox теряет данные при краше)
  private async tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await this.open()
    return new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(STORE, mode)
      const request = run(transaction.objectStore(STORE))
      let result: T
      request.onsuccess = () => {
        result = request.result
      }
      request.onerror = () => reject(request.error ?? new Error('ошибка IndexedDB'))
      transaction.oncomplete = () => resolve(result)
      transaction.onabort = () => reject(transaction.error ?? new Error('транзакция IndexedDB прервана'))
      transaction.onerror = () => reject(transaction.error ?? new Error('ошибка транзакции IndexedDB'))
    })
  }

  async get(key: string): Promise<Uint8Array | null> {
    const value = await this.tx<Uint8Array | undefined>('readonly', (store) => store.get(key))
    return value ? new Uint8Array(value) : null
  }

  async put(key: string, value: Uint8Array): Promise<void> {
    // копия view: structured clone иначе утащит весь базовый ArrayBuffer
    const copy = value.slice()
    await this.tx('readwrite', (store) => store.put(copy, key))
  }

  async delete(key: string): Promise<void> {
    await this.tx('readwrite', (store) => store.delete(key))
  }

  async list(prefix: string, options?: { reverse?: boolean; limit?: number }): Promise<KvEntry[]> {
    const db = await this.open()
    // \uffff — верхняя граница префикса: любой ключ с этим префиксом меньше
    const range = IDBKeyRange.bound(prefix, `${prefix}\uffff`)
    const direction: IDBCursorDirection = options?.reverse ? 'prev' : 'next'
    return new Promise<KvEntry[]>((resolve, reject) => {
      const out: KvEntry[] = []
      const limit = options?.limit ?? Number.POSITIVE_INFINITY
      const transaction = db.transaction(STORE, 'readonly')
      const request = transaction.objectStore(STORE).openCursor(range, direction)
      request.onsuccess = () => {
        const cursor = request.result
        if (!cursor || out.length >= limit) {
          resolve(out)
          return
        }
        out.push({ key: String(cursor.key), value: new Uint8Array(cursor.value as Uint8Array) })
        cursor.continue()
      }
      request.onerror = () => reject(request.error ?? new Error('ошибка скана IndexedDB'))
      transaction.onabort = () => reject(transaction.error ?? new Error('транзакция скана прервана'))
    })
  }

  async deletePrefix(prefix: string): Promise<void> {
    const entries = await this.list(prefix)
    for (const entry of entries) await this.delete(entry.key)
  }

  async clear(): Promise<void> {
    await this.tx('readwrite', (store) => store.clear())
  }

  close(): void {
    this.db?.close()
    this.db = null
  }

  // полное удаление базы: нужно «выйти и удалить всё» — deletePrefix оставляет
  // сами структуры и метаданные версии
  static async destroy(): Promise<void> {
    if (typeof indexedDB === 'undefined') return
    await new Promise<void>((resolve) => {
      const request = indexedDB.deleteDatabase(DB_NAME)
      request.onsuccess = () => resolve()
      request.onerror = () => resolve()
      request.onblocked = () => resolve()
    })
  }
}

// выбор хранилища: в браузере — IndexedDB, в тестах — память
export function defaultKv(): Kv {
  return typeof indexedDB === 'undefined' ? new MemoryKv() : new IdbKv()
}
