// Разбор тела ошибки сервера: пользователь видит строку интерфейса по коду,
// а не сырой JSON {"error":"bad_code","message":"..."} (баг владельца).
import { describe, expect, it } from 'vitest'
import { RelayError } from '../src/net/api.js'
import { errorText, relayErrorText } from '../src/net/errors.js'

const serverBody = (code: string, message: string): string =>
  JSON.stringify({ error: code, message })

describe('errorText', () => {
  it('код bad_code даёт человеческую строку, не тело ответа', () => {
    const error = new RelayError(400, 'bad_code', serverBody('bad_code', 'неверный или истёкший код'), true)
    expect(errorText(error)).toBe('Неверный или истёкший код')
    expect(errorText(error)).not.toContain('{')
  })

  it('все типизированные коды сервера маппятся на строки', () => {
    const cases: Array<[string, string]> = [
      ['bad_code', 'Неверный или истёкший код'],
      ['email_taken', 'Этот email уже зарегистрирован'],
      ['bad_password', 'Неверный пароль'],
      ['cloudpw_required', 'Требуется облачный пароль'],
      ['link_expired', 'Код привязки не найден или истёк'],
      ['key_mismatch', 'Ключ в коде не совпадает — код недействителен'],
      ['device_conflict', 'Устройство уже закреплено с другим ключом'],
      ['current_device', 'Текущее устройство отключить нельзя — выйдите из аккаунта'],
      ['login_busy', 'Не удалось создать логин, попробуйте ещё раз'],
      ['store_unavailable', 'Хранилище недоступно'],
    ]
    for (const [code, expected] of cases) {
      const error = new RelayError(400, code, serverBody(code, expected), true)
      expect(errorText(error), code).toBe(expected)
    }
  })

  it('ответ сервера без известного кода — общая фраза по статусу, не тело', () => {
    const raw = serverBody('mystery', 'служебный текст')
    expect(relayErrorText(new RelayError(404, null, raw, true))).toBe('Пользователь не найден')
    expect(relayErrorText(new RelayError(401, null, raw, true))).toBe('Сессия истекла — войдите заново')
    expect(relayErrorText(new RelayError(429, null, raw, true))).toBe('Слишком много попыток, подождите немного')
    expect(relayErrorText(new RelayError(500, null, raw, true))).toBe('Сервер недоступен, попробуйте позже')
    // текстовые ответы http.Error тоже не показываем как есть
    expect(relayErrorText(new RelayError(400, null, 'некорректное тело\n', true))).toBe('Проверьте введённые данные')
  })

  it('локальные ошибки клиента сохраняют свой текст', () => {
    expect(errorText(new RelayError(410, null, 'медиа истекло'))).toBe('медиа истекло')
    expect(errorText(new RelayError(0, null, 'сеть недоступна: fetch failed'))).toContain('сеть недоступна')
  })

  it('не-ошибки и прочие исключения дают общую фразу или свой текст', () => {
    expect(errorText(new Error('локальный сбой'))).toBe('локальный сбой')
    expect(errorText('строка')).toBe('Что-то пошло не так')
  })
})