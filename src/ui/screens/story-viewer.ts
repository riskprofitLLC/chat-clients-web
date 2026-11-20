// Просмотрщик историй: фото автора, подпись и время до истечения.
// Истории — обычные медиа-записи со storyExp, отдельных данных у них нет.
import { h } from '../dom.js'
import { t } from '../../i18n/ru.js'
import { thumbUrl } from '../../media/media.js'
import { storyLeftParts, type StoryItem } from '../../domain/story-feed.js'
import { openModal } from '../components/modal.js'

// остаток времени в виде «12ч 05м», как в Android-клиенте
export function formatStoryLeft(ms: number): string {
  const { hours, minutes } = storyLeftParts(ms)
  if (hours > 0) return `${hours}${t('storiesHours')} ${String(minutes).padStart(2, '0')}${t('storiesMinutes')}`
  return `${minutes}${t('storiesMinutes')}`
}

export function openStoryViewer(author: string, items: StoryItem[]): void {
  let index = 0
  const box = h('div', { class: 'story-view' })
  const step = (delta: number): void => {
    index = (index + delta + items.length) % items.length
    paint()
  }
  const paint = (): void => {
    const item = items[index]!
    const left = Math.max(0, item.exp - Date.now())
    box.replaceChildren(
      h(
        'div',
        { class: 'story-head' },
        h('span', { class: 'story-author', text: author }),
        h('span', { class: 'story-left', text: formatStoryLeft(left) }),
      ),
      h('img', { class: 'story-photo', src: thumbUrl(item.media.thumb), alt: item.caption ?? '' }),
      ...(item.caption ? [h('p', { class: 'story-caption', text: item.caption })] : []),
      ...(items.length > 1
        ? [
            h(
              'div',
              { class: 'story-nav' },
              h('button', { class: 'btn small', text: '<', onclick: () => step(-1) }),
              h('button', { class: 'btn small', text: '>', onclick: () => step(1) }),
            ),
          ]
        : []),
    )
  }
  paint()
  const controller = openModal({
    title: t('storiesMy'),
    content: box,
    actions: [h('button', { class: 'btn primary', text: t('close'), onclick: () => controller.close() })],
  })
}
