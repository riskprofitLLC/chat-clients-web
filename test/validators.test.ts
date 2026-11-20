// Валидаторы протокола: регэкспы синхронны с сервером (go/auth.go) —
// регрессия ломает и регистрацию, и дискавери по email.
import { describe, expect, it } from 'vitest'
import { validChatId, validCode, validDeviceId, validEmail, validLogin, validPassword } from '../src/protocol/validators.js'

describe('validLogin', () => {
  it('принимает 3–32 символа из разрешённого набора', () => {
    expect(validLogin('bob')).toBe(true)
    expect(validLogin('a'.repeat(32))).toBe(true)
    expect(validLogin('user_1-2')).toBe(true)
  })

  it('отвергает короткие, длинные и недопустимые символы', () => {
    expect(validLogin('ab')).toBe(false)
    expect(validLogin('a'.repeat(33))).toBe(false)
    expect(validLogin('Боб')).toBe(false)
    expect(validLogin('bob@mail')).toBe(false)
  })
})

describe('validDeviceId', () => {
  it('принимает 1–32 символа', () => {
    expect(validDeviceId('d')).toBe(true)
    expect(validDeviceId('dev-1_2')).toBe(true)
  })

  it('отвергает пустую строку и мусор', () => {
    expect(validDeviceId('')).toBe(false)
    expect(validDeviceId('a'.repeat(33))).toBe(false)
    expect(validDeviceId('dev.1')).toBe(false)
  })
})

describe('validChatId', () => {
  it('принимает идентификатор чата до 64 символов', () => {
    expect(validChatId('bob')).toBe(true)
    expect(validChatId('g_123-abc')).toBe(true)
  })

  it('отвергает пустой, слишком длинный и разделители', () => {
    expect(validChatId('')).toBe(false)
    expect(validChatId('a'.repeat(65))).toBe(false)
    expect(validChatId('chat/id')).toBe(false)
  })
})

describe('validEmail', () => {
  it('принимает обычные адреса', () => {
    expect(validEmail('bob@mail.com')).toBe(true)
    expect(validEmail('first.last+tag@sub.example.org')).toBe(true)
  })

  it('отвергает адреса без @, домена или с коротким TLD', () => {
    expect(validEmail('bob.mail.com')).toBe(false)
    expect(validEmail('bob@mail')).toBe(false)
    expect(validEmail('bob@mail.c')).toBe(false)
    expect(validEmail('@mail.com')).toBe(false)
  })
})

describe('пароль и код подтверждения', () => {
  it('пароль от шести символов', () => {
    expect(validPassword('12345')).toBe(false)
    expect(validPassword('123456')).toBe(true)
  })

  it('код — ровно четыре цифры', () => {
    expect(validCode('1234')).toBe(true)
    expect(validCode('123')).toBe(false)
    expect(validCode('12345')).toBe(false)
    expect(validCode('12a4')).toBe(false)
  })
})