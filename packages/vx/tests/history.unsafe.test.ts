// A DTE worker checks out one commit; the laws that read history fetch
// it themselves (helpers/history.ts).
//
// `.unsafe`: it runs git, and a sandboxed shard has no git.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, expect, it } from 'bun:test'
import { fetchHistory } from './helpers/history.js'

const dir = mkdtempSync(path.join(tmpdir(), 'vx-history-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const git = (cwd: string, ...args: string[]): string => {
  const r = Bun.spawnSync(['git', '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    cwd,
    stderr: 'pipe',
  })
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`)
  return r.stdout.toString().trim()
}

it('a shallow checkout fetches every commit and tag, even from tasks at once', async () => {
  const origin = path.join(dir, 'origin')
  git(dir, 'init', '-q', '-b', 'main', origin)
  git(origin, 'config', 'uploadpack.allowFilter', 'true')
  for (const n of [1, 2, 3]) {
    await Bun.write(path.join(origin, 'f'), String(n))
    git(origin, 'add', 'f')
    git(origin, 'commit', '-q', '-m', `feat: ${n}`)
    if (n === 1) git(origin, 'tag', 'v0.0.1')
  }
  const work = path.join(dir, 'work')
  git(dir, 'clone', '-q', '--depth=1', '--no-tags', `file://${origin}`, work)
  expect(git(work, 'rev-parse', '--is-shallow-repository')).toBe('true')

  const twice = ['a', 'b'].map(
    () =>
      Bun.spawn([
        'bun',
        '-e',
        `require(${JSON.stringify(require.resolve('./helpers/history.ts'))}).fetchHistory(${JSON.stringify(work)})`,
      ]).exited,
  )
  expect(await Promise.all(twice)).toEqual([0, 0])
  fetchHistory(work)

  expect(git(work, 'rev-parse', '--is-shallow-repository')).toBe('false')
  expect(git(work, 'tag', '--list', 'v*', '--merged', 'HEAD')).toBe('v0.0.1')
  expect(git(work, 'log', '--format=%s', 'v0.0.1..HEAD')).toBe('feat: 3\nfeat: 2')
})
