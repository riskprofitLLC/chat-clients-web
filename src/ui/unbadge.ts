// Общий вид бейджа непрочитанного: строка списка и таб «Чаты» одной логики.

// 99+ — потолок бейджа, дальше число не растёт (как в TG)
export function formatUnbadge(count: number): string {
  return count > 99 ? '99+' : String(count)
}

// суммарный счётчик непрочитанного для нижней навигации
export function totalUnread(summaries: readonly { unread?: number }[]): number {
  return summaries.reduce((sum, chat) => sum + (chat.unread ?? 0), 0)
}