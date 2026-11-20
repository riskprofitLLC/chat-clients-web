// «О себе»: предел и текст ошибки — чистая логика экрана профиля.
import { describe, expect, it } from 'vitest'
import { BIO_MAX_LEN, bioError } from '../src/domain/profile-bio.js'

describe('bioError', () => {
  it('.текст в пределах предела проходит', () => {
    expect(bioError('')).toBeNull()
    expect(bioError('я'.repeat(BIO_MAX_LEN))).toBeNull()
  })

  it('.за пределами — внятная ошибка', () => {
    expect(bioError('я'.repeat(BIO_MAX_LEN + 1))).toBe(`не более ${BIO_MAX_LEN} символов`)
  })
})
