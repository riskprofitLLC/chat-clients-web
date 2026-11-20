// Страница фатальной ошибки запуска: без WebCrypto (http, не localhost)
// приложение не работает — показываем понятную причину вместо белого экрана.
export function renderFatal(container: HTMLElement, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  const secure = typeof globalThis.crypto?.subtle !== 'undefined'
  container.textContent = ''
  const wrap = document.createElement('div')
  wrap.className = 'fatal'
  const title = document.createElement('h1')
  title.textContent = secure ? 'Не удалось запустить приложение' : 'Нужен https'
  const body = document.createElement('p')
  body.textContent = secure
    ? message
    : 'Криптография в браузере работает только по https (или на localhost). Откройте сайт по защищённому адресу.'
  const detail = document.createElement('pre')
  detail.textContent = secure ? '' : message
  wrap.append(title, body, detail)
  container.appendChild(wrap)
}
