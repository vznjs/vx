import { expect, test } from 'vitest'
import { badge } from './index.ts'

test('badge shows the count when there is one', () => {
  expect(badge('Inbox', 3)).toBe('Inbox (3)')
  expect(badge('Inbox', 0)).toBe('Inbox')
})
