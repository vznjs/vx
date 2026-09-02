// The cache directory ignores itself. Without this a `git add -A` commits
// the artifacts, and vx's own `git status -uall` walks every one of them on
// every run (2026-09-03: 1000 untracked artifacts doubled the enumeration
// on the bench workspace).
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Cache } from '../src/cache/index.js'

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-cache-ignore-'))
  Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root })
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const status = (): string =>
  new TextDecoder().decode(
    Bun.spawnSync({ cmd: ['git', 'status', '--porcelain', '-uall'], cwd: root }).stdout,
  )

describe('the cache directory is git-ignored by construction', () => {
  it('opening a cache writes a `*` .gitignore into it, and git sees nothing under it', () => {
    const dir = path.join(root, '.vx', 'cache')
    const cache = new Cache(dir)
    cache.close()
    expect(status()).toBe('')
    expect(Bun.file(path.join(dir, '.gitignore')).size).toBeGreaterThan(0)
  })

  it('a user-authored .gitignore in the cache dir is left alone', async () => {
    const dir = path.join(root, 'build', 'vx-cache')
    await Bun.write(path.join(dir, '.gitignore'), '# mine\n*\n')
    const cache = new Cache(dir)
    cache.close()
    expect(await readFile(path.join(dir, '.gitignore'), 'utf8')).toBe('# mine\n*\n')
  })

  it('a workspace-level ignore is not required for a clean status', async () => {
    // Control: a file OUTSIDE the cache dir still shows, so the empty
    // status above is the ignore working and not git seeing nothing.
    await writeFile(path.join(root, 'stray.txt'), 'x')
    const cache = new Cache(path.join(root, '.vx', 'cache'))
    cache.close()
    expect(status()).toBe('?? stray.txt\n')
  })
})
