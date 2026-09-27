// A save's artifact and its index rows go live together (A-3). The artifact
// was renamed into place before the rows' transaction, so a commit that
// failed — the write lock held past the busy timeout by another process on
// the same cache directory, a full disk — left the new bytes beside the
// previous save's rows, and every later restore of the key failed the task:
// "artifact is missing 1 recorded output(s)". The rename now happens inside
// the IMMEDIATE transaction, once the lock is held.

import { Database } from 'bun:sqlite'
import { existsSync, readdirSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Cache } from '../src/cache/index.js'

let root: string
let cacheDir: string
let proj: string

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-save-lock-'))
  cacheDir = path.join(root, 'cache')
  proj = path.join(root, 'p')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** Build `dist/<file>` alone and save it under `h1`. */
async function saveBuild(cache: Cache, file: string): Promise<void> {
  await rm(path.join(proj, 'dist'), { recursive: true, force: true })
  await mkdir(path.join(proj, 'dist'), { recursive: true })
  await writeFile(path.join(proj, 'dist', file), file)
  await cache.save({
    hash: 'h1',
    projectDir: proj,
    outputFiles: [path.join(proj, 'dist', file)],
    entry: { taskId: 'p#build', command: 'build', durationMs: 1, stdout: file },
  })
}

describe('a save whose index transaction cannot commit', () => {
  it('leaves the previous entry whole: its bytes, its rows, and no temp', async () => {
    const first = new Cache(cacheDir)
    await saveBuild(first, 'chunk-aaaa.js')
    first.close()

    // A `--force` run rebuilds the key with a differently named chunk while
    // another writer holds the lock past this handle's busy timeout.
    const forced = new Cache(cacheDir, { read: false, write: true })
    forced.dbHandle().exec('PRAGMA busy_timeout = 50')
    const holder = new Database(path.join(cacheDir, 'cache.db'))
    holder.exec('BEGIN IMMEDIATE')
    let refused: unknown
    try {
      await saveBuild(forced, 'chunk-bbbb.js')
    } catch (err) {
      refused = err
    } finally {
      holder.exec('ROLLBACK')
      holder.close()
      forced.close()
    }
    expect(String(refused)).toContain('database is locked')
    expect(readdirSync(cacheDir).filter((n) => n.includes('.tmp-'))).toEqual([])

    const reader = new Cache(cacheDir)
    try {
      const hit = await reader.get('h1')
      expect(hit?.stdout).toBe('chunk-aaaa.js')
      const into = path.join(root, 'restore')
      await reader.restoreOutputs('h1', into)
      expect(await readFile(path.join(into, 'dist', 'chunk-aaaa.js'), 'utf8')).toBe('chunk-aaaa.js')
      expect(existsSync(path.join(into, 'dist', 'chunk-bbbb.js'))).toBe(false)
    } finally {
      reader.close()
    }
  })

  it('one that fails after the rename takes the artifact back out: the key misses', async () => {
    const first = new Cache(cacheDir)
    await saveBuild(first, 'chunk-aaaa.js')
    first.close()
    // The rows' insert fails once the lock is held and the bytes are in
    // place — the shape of a full disk at the commit.
    const db = new Database(path.join(cacheDir, 'cache.db'))
    db.exec(
      "CREATE TRIGGER refuse BEFORE INSERT ON entries BEGIN SELECT RAISE(ABORT, 'refused'); END",
    )
    db.close()
    const forced = new Cache(cacheDir, { read: false, write: true })
    let refused: unknown
    try {
      await saveBuild(forced, 'chunk-bbbb.js')
    } catch (err) {
      refused = err
    } finally {
      forced.close()
    }
    expect(String(refused)).toContain('refused')
    expect(readdirSync(cacheDir).filter((n) => n.includes('.tar.zst'))).toEqual([])
    const reader = new Cache(cacheDir)
    try {
      expect(await reader.get('h1')).toBeNull()
    } finally {
      reader.close()
    }
  })

  it('control: with the lock free, the re-save replaces bytes and rows together', async () => {
    const first = new Cache(cacheDir)
    await saveBuild(first, 'chunk-aaaa.js')
    first.close()
    const forced = new Cache(cacheDir, { read: false, write: true })
    await saveBuild(forced, 'chunk-bbbb.js')
    forced.close()
    const reader = new Cache(cacheDir)
    try {
      expect((await reader.get('h1'))?.stdout).toBe('chunk-bbbb.js')
      const into = path.join(root, 'restore')
      await reader.restoreOutputs('h1', into)
      expect(readdirSync(path.join(into, 'dist'))).toEqual(['chunk-bbbb.js'])
    } finally {
      reader.close()
    }
  })
})
