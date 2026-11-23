// A squash message can hold its git trailers in the footer's own
// paragraph (#4876's did); the page shows the footer, never the trailers.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, it } from 'bun:test'
import { page, STEPS, taggedCommits } from '../scripts/upgrading.ts'

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
    '## Unreleased\n\n<Deeper level="details" title="In the next release">\n\n### C\n\nDo c\n\n### B\n\nDo b\n\n</Deeper>\n\n</div>\n\n<div data-release="v0.0.1">\n\n## v0.0.1\n\n### A\n\nDo a\n\n</div>\n\n{/* END of the generated releases. */}',
  )
})

// A heading is the change in a reader's words: no code scope, a capital
// first letter; a footer that starts with code keeps its case.
it('drops the scope and starts each entry with a capital', () => {
  const md = page([
    { subject: 'feat(cli)!: drop x', body: 'BREAKING CHANGE: --x is gone' },
    { subject: 'feat(cache)!: grow y', body: '' },
  ])
  expect(md).toContain('### Drop x\n\n`--x` is gone\n')
  // An entry with nothing to do is left out.
  expect(md).not.toContain('Grow y')
})

// A footer is history; the exact step a reader takes is added beside it,
// and a change that merged with no footer still gets its entry.
it('adds the step after the footer and lists an unflagged change it names', () => {
  const [subject, step] = Object.entries(STEPS).find(([, s]) => s.title !== undefined)!
  const md = page([
    { subject: 'feat(x)!: drop x (#1)', body: 'BREAKING CHANGE: x is gone' },
    { subject: `${subject} (#2)`, body: '' },
  ])
  expect(md).toContain(`### ${step.title}\n\n${step.steps}\n`)
  expect(md).toContain('### Drop x\n\nX is gone\n')
})

// Regenerated in a shallow clone, the page lost every release before the
// clone's first commit (2026-11-23 day branch).
it('refuses to read the history of a shallow clone', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'vx-upgrading-'))
  try {
    const git = (cwd: string, ...args: string[]) =>
      expect(Bun.spawnSync(['git', ...args], { cwd }).exitCode).toBe(0)
    const src = path.join(dir, 'src')
    git(dir, 'init', '-q', src)
    for (const n of ['a', 'b'])
      git(
        src,
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@t',
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        n,
      )
    git(dir, 'clone', '-q', '--depth=1', `file://${src}`, 'shallow')
    expect(taggedCommits(src).map((c) => c.subject)).toEqual(['a', 'b'])
    expect(() => taggedCommits(path.join(dir, 'shallow'))).toThrow('git fetch --unshallow')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
