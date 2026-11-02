// Валидаторы полей; регэкспы синхронны с сервером (go/auth.go) и Android.
const loginRe = /^[a-z0-9_-]{3,32}$/
const deviceRe = /^[a-z0-9_-]{1,32}$/
const emailRe = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/
const chatIdRe = /^[A-Za-z0-9_-]{1,64}$/

export function validLogin(login: string): boolean {
  return loginRe.test(login)
}

export function validDeviceId(deviceId: string): boolean {
  return deviceRe.test(deviceId)
}

export function validChatId(chatId: string): boolean {
  return chatIdRe.test(chatId)
}

export function validEmail(email: string): boolean {
  return emailRe.test(email)
}

export function validPassword(password: string): boolean {
  return password.length >= 6
}

export function validCode(code: string): boolean {
  return /^\d{4}$/.test(code)
}
