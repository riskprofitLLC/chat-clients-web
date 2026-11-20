// Сортировка контактов (аналог Telegram): по имени или по времени захода.
// Чистая логика — без DOM и без стора, покрывается vitest.
import type { Contact } from '../store/contacts.js'

export type ContactsSort = 'name' | 'lastSeen'

export const CONTACTS_SORTS: readonly { id: ContactsSort; labelKey: 'contactsSortName' | 'contactsSortLastSeen' }[] = [
  { id: 'name', labelKey: 'contactsSortName' },
  { id: 'lastSeen', labelKey: 'contactsSortLastSeen' },
]

export const DEFAULT_CONTACTS_SORT: ContactsSort = 'name'

// мусор из настроек читается как «по имени»
export function sanitizeContactsSort(raw: unknown): ContactsSort {
  return raw === 'lastSeen' ? 'lastSeen' : DEFAULT_CONTACTS_SORT
}

// время последнего захода в млс; 0 — неизвестно (сортируется в конец)
export type LastSeenMap = ReadonlyMap<string, number>

function byName(a: Contact, b: Contact): number {
  const an = (a.name || `@${a.login}`).toLowerCase()
  const bn = (b.name || `@${b.login}`).toLowerCase()
  return an.localeCompare(bn, 'ru') || a.login.localeCompare(b.login, 'ru')
}

// по времени захода: свежие сверху, неизвестное время — вниз, при равенстве по имени
export function sortContacts(contacts: readonly Contact[], mode: ContactsSort, lastSeen?: LastSeenMap): Contact[] {
  const list = [...contacts]
  if (mode === 'lastSeen') {
    list.sort((a, b) => {
      const sa = lastSeen?.get(a.login) ?? 0
      const sb = lastSeen?.get(b.login) ?? 0
      if (sa !== sb) return sb - sa
      return byName(a, b)
    })
    return list
  }
  list.sort(byName)
  return list
}