// The notes auto-release.yml writes for each release (scripts/release-notes.ts).
import { describe, expect, it } from 'bun:test'
import {
  nextVersion,
  parseLog,
  postNotes,
  postPath,
  releaseNotes,
} from '../scripts/release-notes.js'
import { stale } from '../scripts/release-sync.js'

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

describe('nextVersion', () => {
  it('before 1.0: a feat or a breaking change is a minor, anything else a patch', () => {
    expect(nextVersion('v0.4.2', [c('fix: a'), c('docs: b')])).toBe('0.4.3')
    expect(nextVersion('v0.4.2', [c('fix: a'), c('feat(cli): b')])).toBe('0.5.0')
    expect(nextVersion('v0.4.2', [c('fix!: a')])).toBe('0.5.0')
    expect(nextVersion('v0.4.2', [c('fix: a', 'BREAKING CHANGE: gone')])).toBe('0.5.0')
    expect(nextVersion('v0.4.2', [])).toBe('0.4.3')
  })

  it('from 1.0: breaking is a major, feat a minor, the rest a patch', () => {
    expect(nextVersion('v1.2.3', [c('feat: a'), c('refactor!: b')])).toBe('2.0.0')
    expect(nextVersion('1.2.3', [c('feat: a'), c('fix: b')])).toBe('1.3.0')
    expect(nextVersion('v1.2.3', [c('perf: a')])).toBe('1.2.4')
  })

  it('the first release is 0.0.1, and below 0.1.0 every release is a patch', () => {
    expect(nextVersion('', [c('feat: a')])).toBe('0.0.1')
    // Cutting 0.1.0 is the owner's (roadmap-1.0.md, item 1.4).
    expect(nextVersion('v0.0.100', [c('feat!: a')])).toBe('0.0.101')
  })
})

describe('postNotes', () => {
  const post = [
    '---',
    "title: 'A core that knows no language'",
    'tags:',
    '  - release',
    '---',
    '',
    'Intro. See [CI](../../guides/ci/#lock) and [below](#breaking-changes).',
    '',
  ].join('\n')

  it('is the post under its title, links absolute, ending with a link to the post', () => {
    expect(postNotes(post, '0.0.637')).toBe(
      [
        '# A core that knows no language',
        '',
        'Intro. See [CI](https://vznjs.github.io/vx/guides/ci/#lock) and [below](#breaking-changes).',
        '',
        '[Read it on the site](https://vznjs.github.io/vx/releases/vx-0-0-637/)',
        '',
      ].join('\n'),
    )
  })

  it('finds the post by version', () => {
    expect(postPath('0.0.637')).toBe('private/vx-docs/src/content/docs/releases/vx-0-0-637.md')
  })
})

describe('stale', () => {
  const post = "---\ntitle: 'T'\n---\nBody.\n"
  const want = postNotes(post, '0.0.3')

  it('rewrites only a release whose post says something else', () => {
    expect(
      stale(
        [
          { id: 1, tag_name: 'v0.0.1', body: 'changelog' },
          { id: 2, tag_name: 'v0.0.2', body: 'changelog' },
          { id: 3, tag_name: 'v0.0.3', body: want.replaceAll('\n', '\r\n') },
        ],
        (v) => (v === '0.0.1' ? undefined : post),
      ).map((r) => r.id),
    ).toEqual([2])
  })
})
