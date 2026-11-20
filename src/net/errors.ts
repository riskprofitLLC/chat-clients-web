// Человекочитаемый текст ошибки для UI.
// Сырое тело ответа сервера наружу не показываем: типизированный код
// («bad_code» из {"error":"bad_code","message":...}) маппится на строку
// интерфейса, для остальных ответов берём общую формулировку по статусу.
import { t, type I18nKey } from '../i18n/ru.js'
import { RelayError } from './api.js'

// коды ошибок сервера (go/: writeErr) → строки интерфейса
const CODE_KEYS: Record<string, I18nKey> = {
  bad_code: 'errorBadCode',
  email_taken: 'errorEmailTaken',
  bad_password: 'errorBadPassword',
  cloudpw_required: 'errorCloudPassword',
  link_expired: 'errorLinkExpired',
  key_mismatch: 'errorKeyMismatch',
  device_conflict: 'errorDeviceConflict',
  current_device: 'errorCurrentDevice',
  login_busy: 'errorLoginBusy',
  store_unavailable: 'errorStoreUnavailable',
  not_found: 'errorNotFound',
}

// общие формулировки по HTTP-статусу ответа сервера без известного кода
const STATUS_KEYS: Array<[number, I18nKey]> = [
  [400, 'errorBadRequest'],
  [401, 'errorTokenRevoked'],
  [403, 'errorForbidden'],
  [404, 'errorNotFound'],
  [409, 'errorConflict'],
  [410, 'errorGone'],
  [413, 'errorTooLarge'],
  [429, 'errorRateLimited'],
]

export function relayErrorText(error: RelayError): string {
  const key = error.code ? CODE_KEYS[error.code] : undefined
  if (key) return t(key)
  // локальные ошибки клиента несут свой человекочитаемый текст — его оставляем
  if (!error.fromServer) return error.message
  for (const [status, statusKey] of STATUS_KEYS) {
    if (error.status === status) return t(statusKey)
  }
  if (error.status >= 500) return t('errorServer')
  if (error.status === 0) return t('errorNetwork')
  return t('errorGeneric')
}

export function errorText(error: unknown): string {
  if (error instanceof RelayError) return relayErrorText(error)
  if (error instanceof Error) return error.message
  return t('errorGeneric')
}