// A tracked symlink points inside the repo by a relative path. #5458
// committed `packages/vx/vx` and `packages/vx-lockfile/vx-lockfile` as
// links to one machine's absolute checkout: dangling in every other clone,
// and in a workspace that links `@vzn/vx` from a second worktree, the
// lockfile plugin's walk of the linked directory followed it into the first
// worktree and hashed its files. Unsafe: it reads the index.
import { readlinkSync } from 'node:fs'
import path from 'node:path'
import { expect, it } from 'bun:test'

const repo = path.resolve(import.meta.dir, '..', '..', '..')

it('every tracked symlink is relative and stays in the repo', () => {
  const ls = Bun.spawnSync(['git', 'ls-files', '-s', '-z'], { cwd: repo })
  expect(ls.exitCode).toBe(0)
  const bad: string[] = []
  for (const entry of ls.stdout.toString().split('\0')) {
    if (!entry.startsWith('120000 ')) continue
    const rel = entry.slice(entry.indexOf('\t') + 1)
    const target = readlinkSync(path.join(repo, rel))
    const at = path.resolve(path.dirname(path.join(repo, rel)), target)
    if (path.isAbsolute(target) || !at.startsWith(repo + path.sep)) bad.push(`${rel} -> ${target}`)
  }
  expect(bad).toEqual([])
})
