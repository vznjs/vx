// The helper the history laws share fetches HEAD's history and the tags,
// and no branch of origin: a branch ahead of HEAD broke git's own repack
// of the filtered fetch on CI (tests/helpers/history.ts).
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, expect, it } from 'bun:test'
import { fetchHistory } from './helpers/history.ts'

const dir = mkdtempSync(path.join(tmpdir(), 'vx-history-fetch-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const git = (cwd: string, ...args: string[]): string => {
  const r = Bun.spawnSync(['git', ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'a',
      GIT_AUTHOR_EMAIL: 'a@a',
      GIT_COMMITTER_NAME: 'a',
      GIT_COMMITTER_EMAIL: 'a@a',
    },
    stderr: 'pipe',
  })
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`)
  return r.stdout.toString().trim()
}

it('fetches HEAD history and tags, never a branch ahead of HEAD', () => {
  const origin = path.join(dir, 'origin')
  git(dir, 'init', '-q', '-b', 'main', origin)
  git(origin, 'config', 'uploadpack.allowFilter', 'true')
  git(origin, 'commit', '-q', '--allow-empty', '-m', 'first')
  const first = git(origin, 'rev-parse', 'HEAD')
  git(origin, 'tag', 'v1')
  git(origin, 'commit', '-q', '--allow-empty', '-m', 'second')
  const clone = path.join(dir, 'clone')
  // actions/checkout's remote fetches every branch, as --no-single-branch.
  git(dir, 'clone', '-q', '--depth', '1', '--no-single-branch', `file://${origin}`, clone)
  // Pushed while the run went on: its parent is the checkout's HEAD.
  git(origin, 'checkout', '-q', '-b', 'next')
  git(origin, 'commit', '-q', '--allow-empty', '-m', 'ahead')
  const ahead = git(origin, 'rev-parse', 'HEAD')

  fetchHistory(clone)

  expect(git(clone, 'rev-parse', '--is-shallow-repository')).toBe('false')
  expect(git(clone, 'rev-parse', 'v1^{commit}')).toBe(first)
  // Listed, not asked for: asking a partial clone for an object fetches it.
  const held = git(clone, 'cat-file', '--batch-all-objects', '--batch-check=%(objectname)')
  expect(held.split('\n')).toContain(first)
  expect(held.split('\n')).not.toContain(ahead)
})
