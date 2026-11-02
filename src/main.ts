// Точка входа: собираем контекст, поднимаем оболочку, регистрируем SW.
import './ui/styles.css'
import { AppContext } from './app/context.js'
import { AppShell } from './ui/shell.js'
import { registerServiceWorker } from './pwa.js'

const root = document.getElementById('app')
if (!root) throw new Error('нет контейнера приложения')

const context = await AppContext.create()
const shell = new AppShell(root, context)

// в dev-сборке контекст доступен из консоли: отладка и e2e-проверки
if (import.meta.env.DEV) {
  ;(globalThis as { __chat?: unknown }).__chat = { context, shell }
}

// сервис-воркер регистрируем до boot: он нужен для уведомлений и офлайн-шелла
void registerServiceWorker()

await shell.boot()

// обновление страницы не должно терять активный звонок молча: предупреждаем
window.addEventListener('beforeunload', (event) => {
  if (context.calls && context.calls.view.state.phase === 'active') {
    event.preventDefault()
    event.returnValue = ''
  }
})
