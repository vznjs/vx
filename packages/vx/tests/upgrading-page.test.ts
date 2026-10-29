// A squash message can hold its git trailers in the footer's own
// paragraph (#4876's did); the page shows the footer, never the trailers.
import { expect, it } from 'bun:test'
import { page } from '../scripts/upgrading.ts'

it('ends a footer at the git trailers that follow it', () => {
  const md = page([
    {
      subject: 'feat(cache)!: store each row (#1)',
      body: 'Why.\n\nBREAKING CHANGE: SCHEMA_VERSION is v51:\nthe index resets.\nCo-Authored-By: A <a@b.c>\nClaude-Session: https://x',
    },
  ])
  expect(md).toContain('## cache: store each row\n\nSCHEMA_VERSION is v51: the index resets.\n')
  expect(md).not.toContain('Co-Authored-By')
})
