// Нижняя пилюля корневых разделов (мобильная раскладка): состав табов и
// какой из них активен для текущего маршрута. Чистая логика — тесты,
// DOM собирается в shell.
import type { IconName } from './icons.js'
import type { Route } from './host.js'

export type TabName = 'chats' | 'contacts' | 'settings' | 'profile'

export interface BottomTab {
  name: TabName
  labelKey: 'chatsTitle' | 'contactsTitle' | 'settingsTitle' | 'profileTitle'
  icon: IconName
}

// порядок табов = порядок в пилюле слева направо
export const BOTTOM_TABS: readonly BottomTab[] = [
  { name: 'chats', labelKey: 'chatsTitle', icon: 'send' },
  { name: 'contacts', labelKey: 'contactsTitle', icon: 'contact' },
  { name: 'settings', labelKey: 'settingsTitle', icon: 'settings' },
  { name: 'profile', labelKey: 'profileTitle', icon: 'user' },
]

// активный таб маршрута; диалог, звонки и вход пилюлю не подсвечивают
export function activeTab(route?: Route): TabName | null {
  const name = route?.name
  return BOTTOM_TABS.find((tab) => tab.name === name)?.name ?? null
}