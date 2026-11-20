// «О себе»: предел длины и его проверка — чистая логика экрана профиля,
// вынесена из UI, чтобы не гонять валидацию через DOM.
export const BIO_MAX_LEN = 70

export function bioError(value: string): string | null {
  return value.length > BIO_MAX_LEN ? `не более ${BIO_MAX_LEN} символов` : null
}
