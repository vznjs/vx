// The notes auto-release.yml writes for each release (scripts/release-notes.ts).
import { describe, expect, it } from 'bun:test'
import { parseLog, releaseNotes } from '../scripts/release-notes.js'

const c = (subject: string, body = ''): { subject: string; body: string } => ({ subject, body })

describe('releaseNotes', () => {
  it('lists feat, fix and perf in that order, breaking changes first, and counts the rest', () => {
    const notes = releaseNotes([
      c('fix(cache): bound a body (L-5)'),
      c('docs(site): fix a guide'),
      c('feat(cli)!: drop vx stats'),
      c('perf: skip a stat'),
      c('test(runner): pin a row'),
      c(
        'fix(plugin): refuse a bad hook',
        'Why.\n\nBREAKING CHANGE: a hook that returned 5 now fails.',
      ),
      c('Merge branch main'),
      c('feat(examples): a starter CI'),
    ])
    expect(notes).toBe(
      [
        '## Breaking changes',
        '',
        '- **cli:** drop vx stats',
        '- **plugin:** refuse a bad hook',
        '',
        '## Features',
        '',
        '- **cli:** drop vx stats',
        '- **examples:** a starter CI',
        '',
        '## Fixes',
        '',
        '- **cache:** bound a body (L-5)',
        '- **plugin:** refuse a bad hook',
        '',
        '## Performance',
        '',
        '- skip a stat',
        '',
        '3 other commits (docs, tests, refactors, CI).',
        '',
      ].join('\n'),
    )
  })

  it('says so when nothing changed, and drops an empty section', () => {
    expect(releaseNotes([])).toBe('No changes.\n')
    expect(releaseNotes([c('fix: one')])).toBe('## Fixes\n\n- one\n')
    expect(releaseNotes([c('docs: one')])).toBe('1 other commit (docs, tests, refactors, CI).\n')
  })

  it('reads a body only as a footer: a BREAKING CHANGE mid-line is not one', () => {
    expect(releaseNotes([c('fix: a', 'see the BREAKING CHANGE: note in #12')])).toBe(
      '## Fixes\n\n- a\n',
    )
  })
})

describe('parseLog', () => {
  it('splits git log records, bodies with blank lines included', () => {
    expect(parseLog('feat: a\0line 1\n\nline 3\n\x1e\nfix(x): b\0\x1e\n')).toEqual([
      { subject: 'feat: a', body: 'line 1\n\nline 3\n' },
      { subject: 'fix(x): b', body: '' },
    ])
  })
})
