// Точка входа: собираем контекст, поднимаем оболочку, регистрируем SW.
import './ui/styles.css'
import { AppContext } from './app/context.js'
import { AppShell } from './ui/shell.js'
import { renderFatal } from './ui/fatal.js'

const root = document.getElementById('app')
if (!root) throw new Error('нет контейнера приложения')

// без WebCrypto (не https и не localhost) приложение не работает: показываем
// понятную страницу вместо белого экрана из упавшего модуля крипты
try {
  const context = await AppContext.create()
  const shell = new AppShell(root, context)

  // в dev-сборке контекст доступен из консоли: отладка и e2e-проверки
  if (import.meta.env.DEV) {
    ;(globalThis as { __chat?: unknown }).__chat = { context, shell }
  }

  // сервис-воркер регистрируется внутри shell.boot (там же проверка обновления)
  await shell.boot()

  // обновление страницы не должно терять активный звонок молча: предупреждаем
  window.addEventListener('beforeunload', (event) => {
    if (context.calls && context.calls.view.state.phase === 'active') {
      event.preventDefault()
      event.returnValue = ''
    }
  })
} catch (error) {
  renderFatal(root, error)
}

