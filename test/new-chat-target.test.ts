import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { classifyNewChat, emailHash, normalizeEmail } from '../src/domain/new-chat-target.js'

// Чистая логика «нового чата»: строка без «@» — логин, с «@» — email (дискавери).
describe('новый чат: логин vs email', () => {
  it('логин без «@» идёт путём логина', () => {
    expect(classifyNewChat('Bob_User-1')).toEqual({ kind: 'login', login: 'bob_user-1' })
  })

  it('email идёт путём дискавери и нормализуется', () => {
    expect(classifyNewChat('  User@Example.COM ')).toEqual({ kind: 'email', email: 'user@example.com' })
  })

  it('пусто и мусор — invalid', () => {
    expect(classifyNewChat('').kind).toBe('invalid')
    expect(classifyNewChat('   ').kind).toBe('invalid')
    expect(classifyNewChat('ab').kind).toBe('invalid')
    expect(classifyNewChat('not an email@').kind).toBe('invalid')
  })

  // хэш уходит на сервер вместо адреса: сверяем с эталонным SHA-256
  it('хэш email — SHA-256 hex нормализованного адреса', async () => {
    const expected = createHash('sha256').update(normalizeEmail('User@Example.COM'), 'utf8').digest('hex')
    expect(await emailHash('User@Example.COM')).toBe(expected)
    expect(expected).toHaveLength(64)
  })
})