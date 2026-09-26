// `cli/workspace-config.ts`: the `--cache-dir` flag every reading verb
// parses, where its value resolves, and the staged project load those
// verbs share, which stores a pure config's evaluation for the next reader.

import { Database } from 'bun:sqlite'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { cliCacheDir, parseCacheDirFlag } from '../src/cli/workspace-config.js'
import { gitIn, makeWorkspace } from './helpers/workspace.js'

describe('parseCacheDirFlag', () => {
  it('the = form takes a value that starts with a dash; the space form refuses one', () => {
    expect(parseCacheDirFlag(['--cache-dir=-cache'], 0)).toEqual({ cacheDir: '-cache', next: 0 })
    expect(parseCacheDirFlag(['--cache-dir', '-cache'], 0)).toEqual({
      error: '--cache-dir requires a path, got flag: -cache',
    })
  })
})

describe('cliCacheDir', () => {
  it('resolves a relative --cache-dir against the working directory, as vx run does', async () => {
    // A directory that exists under the working directory (the suite's own).
    expect(await cliCacheDir('/nowhere', 'tests')).toBe(path.resolve(process.cwd(), 'tests'))
  })

  it('refuses a --cache-dir that is not there, by name (item 900)', async () => {
    let threw = ''
    await cliCacheDir('/nowhere', 'rel/cache').catch((err: Error) => {
      threw = err.message
    })
    expect(threw).toBe(
      `--cache-dir rel/cache: no such directory (${path.resolve(process.cwd(), 'rel/cache')})`,
    )
  })
})

describe("a reading verb stores a pure config's evaluation", () => {
  const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
  let root: string
  beforeAll(async () => {
    root = await makeWorkspace({ prefix: 'vx-cli-evalcache-', git: false })
    const dir = path.join(root, 'packages', 'app')
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'app' }))
    await writeFile(
      path.join(dir, 'vx.config.mjs'),
      "export default { tasks: { build: { exec: { command: 'true' } } } }\n",
    )
    const git = gitIn(root)
    git('init', '-q')
    git('add', '-A')
  })
  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('`vx show` leaves the evaluation in the cache for the next reader', async () => {
    // A pure config has no side effect to count evaluations by, so the row
    // reads the store: the staged load that `show`, `watch` and the picker
    // share must open it, or every verb re-evaluates every config.
    const proc = Bun.spawn([process.execPath, BIN, 'show'], {
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(await proc.exited).toBe(0)
    const db = new Database(path.join(root, '.vx', 'cache', 'cache.db'), { readonly: true })
    try {
      expect((db.query('SELECT COUNT(*) AS n FROM config_evals').get() as { n: number }).n).toBe(1)
    } finally {
      db.close()
    }
  }, 30_000)
})
