import { badge } from 'ui'

export function title(unread: number): string {
  return badge('Inbox', unread)
}
