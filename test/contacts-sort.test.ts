// Тесты чистой сортировки контактов: имя, время захода, неизвестное время
// и защита от мусора в настройках.
import { describe, expect, it } from 'vitest'
import {
  CONTACTS_SORTS,
  DEFAULT_CONTACTS_SORT,
  sanitizeContactsSort,
  sortContacts,
  type LastSeenMap,
} from '../src/domain/contacts-sort.js'
import type { Contact } from '../src/store/contacts.js'

function contact(login: string, name: string): Contact {
  return { login, name, updatedAt: 1_700_000_000_000 }
}

describe('sortContacts', () => {
  it('по имени без учёта регистра', () => {
    const items = [contact('bob', 'Bob'), contact('alice', 'АЛИСА'), contact('carol', 'carol')]
    expect(sortContacts(items, 'name').map((item) => item.login)).toEqual(['alice', 'bob', 'carol'])
    // исходный порядок не меняется
    expect(items.map((item) => item.login)).toEqual(['bob', 'alice', 'carol'])
  })

  it('по времени захода: свежие сверху', () => {
    const items = [contact('alice', 'Алиса'), contact('bob', 'Боб')]
    const seen: LastSeenMap = new Map([
      ['alice', 1_000],
      ['bob', 2_000],
    ])
    expect(sortContacts(items, 'lastSeen', seen).map((item) => item.login)).toEqual(['bob', 'alice'])
  })

  it('неизвестное время уходит вниз', () => {
    const items = [contact('unknown', 'Без захода'), contact('zero', 'Ноль'), contact('fresh', 'Свежий')]
    const seen: LastSeenMap = new Map([
      ['zero', 0],
      ['fresh', 3_000],
    ])
    expect(sortContacts(items, 'lastSeen', seen).map((item) => item.login)).toEqual(['fresh', 'unknown', 'zero'])
  })

  it('при равенстве времени сортирует по имени', () => {
    const items = [contact('bob', 'Боб'), contact('alice', 'Алиса')]
    const seen: LastSeenMap = new Map([
      ['bob', 5_000],
      ['alice', 5_000],
    ])
    expect(sortContacts(items, 'lastSeen', seen).map((item) => item.login)).toEqual(['alice', 'bob'])
  })
})

describe('настройки сортировки', () => {
  it('дефолт и список вариантов', () => {
    expect(DEFAULT_CONTACTS_SORT).toBe('name')
    expect(CONTACTS_SORTS.map((item) => item.id)).toEqual(['name', 'lastSeen'])
  })

  it('мусор в настройках читается как «по имени»', () => {
    expect(sanitizeContactsSort('lastSeen')).toBe('lastSeen')
    for (const raw of ['name', '', 'мусор', null, undefined, 42, {}, []]) {
      expect(sanitizeContactsSort(raw)).toBe('name')
    }
  })
})
