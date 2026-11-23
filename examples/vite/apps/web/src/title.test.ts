import { expect, test } from 'vitest'
import { title } from './title.ts'

test('the title counts unread mail', () => {
  expect(title(2)).toBe('Inbox (2)')
})
