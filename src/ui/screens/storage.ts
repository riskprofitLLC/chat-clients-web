// Экран «Хранилище» (P-W1): свод занятого места в IndexedDB по категориям
// и очистка кэша медиа. Размеры считает store/storage.ts по плоскому скану
// Kv — здесь только показ и действие.
import { h, formatBytes } from '../dom.js'
import { icon, iconButton } from '../icons.js'
import { t } from '../../i18n/ru.js'
import type { AppHost } from '../host.js'
import { storageUsage } from '../../store/storage.js'
import type { StorageUsage } from '../../domain/storage.js'
import { confirmModal } from '../components/modal.js'
import { snackbar } from '../components/snackbar.js'

interface CategoryCard {
  id: 'media' | 'history' | 'queue' | 'other'
  label: string
  icon: 'image' | 'folder' | 'send' | 'shield'
}

const CATEGORIES: readonly CategoryCard[] = [
  { id: 'media', label: t('storageMedia'), icon: 'image' },
  { id: 'history', label: t('storageHistory'), icon: 'folder' },
  { id: 'queue', label: t('storageQueue'), icon: 'send' },
  { id: 'other', label: t('storageOther'), icon: 'shield' },
]

export class StorageScreen {
  readonly element: HTMLElement
  private readonly cards: HTMLElement
  private readonly total: HTMLElement
  private usage: StorageUsage = { mediaBytes: 0, historyBytes: 0, queueBytes: 0, otherBytes: 0, totalBytes: 0 }

  constructor(private readonly host: AppHost) {
    this.cards = h('div', { class: 'storage-cards' })
    this.total = h('div', { class: 'storage-total' })
    const header = h(
      'header',
      { class: 'topbar' },
      iconButton('back', t('back'), () => this.host.showSettings()),
      h('h1', { text: t('storageTitle') }),
    )
    const body = h(
      'div',
      { class: 'settings-body' },
      h('p', { class: 'hint', text: t('storageHint') }),
      this.total,
      this.cards,
      h('button', {
        class: 'btn block',
        text: t('storageClearMedia'),
        onclick: () => void this.clearMedia(),
      }),
    )
    this.element = h('main', { class: 'screen storage-screen' }, header, body)
  }

  async render(): Promise<void> {
    this.usage = await storageUsage(this.host.ctx.kv)
    this.paint()
  }

  private paint(): void {
    this.total.textContent = `${t('storageTotal')}: ${formatBytes(this.usage.totalBytes)}`
    this.cards.replaceChildren(
      ...CATEGORIES.map((category) =>
        h(
          'div',
          { class: 'storage-card setting-row' },
          h('span', { class: 'lead-icon' }, icon(category.icon, { size: 20 })),
          h('div', { class: 'setting-label' }, h('div', { text: category.label })),
          h('span', { class: 'row-value', text: formatBytes(this.usage[`${category.id}Bytes`]) }),
        ),
      ),
    )
  }

  // очистка кэша медиа с подтверждением: перекачанное скачается заново,
  // история и мета сообщений остаются на месте
  private async clearMedia(): Promise<void> {
    const ok = await confirmModal({ title: t('storageClearMedia'), message: t('storageHint'), danger: true })
    if (!ok) return
    await this.host.ctx.media.clear()
    snackbar(t('storageCleared'), { kind: 'success' })
    await this.render()
  }
}