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
  expect(md).toContain('### Store each row\n\nSCHEMA_VERSION is v51: the index resets.\n')
  expect(md).not.toContain('Co-Authored-By')
})

// A user reads only the releases after the one they run (v0.0.653 had none).
it('groups entries under the release tag that shipped them, newest first', () => {
  const brk = (n: string) => ({ subject: `feat!: ${n}`, body: `BREAKING CHANGE: do ${n}` })
  const md = page([brk('a'), { subject: 'fix: x', body: '', tag: 'v0.0.1' }, brk('b'), brk('c')])
  expect(md.slice(md.indexOf('## '))).toBe(
    '## After v0.0.1\n\n### C\n\nDo c\n\n### B\n\nDo b\n\n## v0.0.1\n\n### A\n\nDo a\n',
  )
})

// A heading is the change in a reader's words: no code scope, a capital
// first letter; a footer that starts with code keeps its case.
it('drops the scope and starts each entry with a capital', () => {
  const md = page([
    { subject: 'feat(cli)!: drop x', body: 'BREAKING CHANGE: --x is gone' },
    { subject: 'feat(cache)!: grow y', body: '' },
  ])
  expect(md).toContain('### Drop x\n\n--x is gone\n')
  expect(md).toContain('### Grow y\n\nNothing to change beyond the steps above.\n')
})
