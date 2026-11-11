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
  expect(md).toContain('### cache: store each row\n\nSCHEMA_VERSION is v51: the index resets.\n')
  expect(md).not.toContain('Co-Authored-By')
})

// A user reads only the releases after the one they run (v0.0.653 had none).
it('groups entries under the release tag that shipped them, newest first', () => {
  const brk = (n: string) => ({ subject: `feat!: ${n}`, body: `BREAKING CHANGE: do ${n}` })
  const md = page([brk('a'), { subject: 'fix: x', body: '', tag: 'v0.0.1' }, brk('b'), brk('c')])
  expect(md.slice(md.indexOf('## '))).toBe(
    '## After v0.0.1\n\n### c\n\ndo c\n\n### b\n\ndo b\n\n## v0.0.1\n\n### a\n\ndo a\n',
  )
})
