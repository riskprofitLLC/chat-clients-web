// Меню сообщения: на мобильном — bottom-sheet, на десктопе — popover у курсора.
// Быстрые реакции + полный пикер эмодзи (вместо window.prompt), действия
// с учётом прав (править — только своё текстовое).
import { h } from '../dom.js'
import { icon } from '../icons.js'
import { t } from '../../i18n/ru.js'
import { REACTION_EMOJIS, isValidEmoji } from '../../protocol/formats.js'
import { closeModal, openModal } from './modal.js'

export interface MessageMenuActions {
  react: (emoji: string) => void
  reply: () => void
  copy: () => void
  pin: () => void
  edit?: () => void
  remove?: () => void
}

const EXTRA_EMOJI = ['😀', '😂', '🥰', '😎', '🤔', '😢', '😡', '👍', '👎', '🙏', '👏', '🔥', '❤️', '💔', '🎉', '✅', '👀', '🤝', '💯', '😴', '🤯', '🥳']

export function openMessageMenu(anchor: { x: number; y: number }, actions: MessageMenuActions): void {
  const quick = h(
    'div',
    { class: 'reaction-quick' },
    ...REACTION_EMOJIS.slice(0, 7).map((emoji) =>
      h('button', {
        class: 'reaction-quick-btn',
        text: emoji,
        'aria-label': `${t('react')} ${emoji}`,
        onclick: () => {
          closeModal()
          actions.react(emoji)
        },
      }),
    ),
    h('button', {
      class: 'reaction-quick-btn more',
      'aria-label': t('moreEmoji'),
      onclick: (event: Event) => {
        event.stopPropagation()
        openEmojiPicker((emoji) => {
          closeModal()
          actions.react(emoji)
        })
      },
    }, icon('plus', { size: 18 })),
  )
  const items: HTMLElement[] = [
    h('button', { class: 'menu-item', onclick: () => { closeModal(); actions.reply() } }, icon('reply', { size: 20 }), t('reply')),
    h('button', { class: 'menu-item', onclick: () => { closeModal(); actions.copy() } }, icon('copy', { size: 20 }), t('copy')),
    h('button', { class: 'menu-item', onclick: () => { closeModal(); actions.pin() } }, icon('pin', { size: 20 }), t('pin')),
  ]
  if (actions.edit) {
    items.push(h('button', { class: 'menu-item', onclick: () => { closeModal(); actions.edit?.() } }, icon('edit', { size: 20 }), t('edit')))
  }
  if (actions.remove) {
    items.push(
      h('button', { class: 'menu-item danger', onclick: () => { closeModal(); actions.remove?.() } }, icon('trash', { size: 20 }), t('deleteForAll')),
    )
  }
  const sheet = h('div', { class: 'menu-sheet' }, quick, h('div', { class: 'menu-list' }, ...items))
  const desktop = window.matchMedia('(min-width: 900px)').matches
  if (desktop) {
    sheet.classList.add('menu-popover')
    const width = 280
    const left = Math.max(8, Math.min(anchor.x, window.innerWidth - width - 8))
    const top = Math.min(anchor.y + 8, window.innerHeight - 320)
    sheet.style.left = `${left}px`
    sheet.style.top = `${Math.max(8, top)}px`
  }
  openModal({ content: sheet })
}

export function openEmojiPicker(onPick: (emoji: string) => void): void {
  const input = h('input', { class: 'emoji-input', placeholder: 'вставьте или введите эмодзи', maxlength: '8' })
  const grid = h(
    'div',
    { class: 'emoji-grid' },
    ...EXTRA_EMOJI.map((emoji) =>
      h('button', { class: 'emoji-cell', text: emoji, onclick: () => { closeModal(); onPick(emoji) } }),
    ),
  )
  const confirm = h('button', {
    class: 'btn primary',
    text: t('save'),
    onclick: () => {
      const value = input.value.trim()
      if (!value || !isValidEmoji(value)) {
        input.classList.add('shake')
        setTimeout(() => input.classList.remove('shake'), 400)
        return
      }
      closeModal()
      onPick(value)
    },
  })
  openModal({
    title: t('moreEmoji'),
    content: h('div', { class: 'form' }, grid, input),
    actions: [h('button', { class: 'btn', text: t('cancel'), onclick: () => closeModal() }), confirm],
  })
}
