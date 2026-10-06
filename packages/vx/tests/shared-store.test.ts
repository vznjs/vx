// The default cache layout (v32): each workspace keeps its index, history
// and memos in its own `.vx/cache`, and the entries and artifacts live in
// the user's shared store, so one workspace hits what another saved. The
// suite runs with VX_CACHE_DIR set (vx.config.ts); every row here unsets
// it and points XDG_CACHE_HOME at a temp directory of its own.

import { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Cache, SCHEMA_VERSION } from '../src/cache/index.js'
import { run } from '../src/orchestrator/index.js'
import { resolveStoreRoot } from '../src/workspace/index.js'
import { restoreEnv } from './helpers/env.js'
import {
  addProject,
  makeWorkspace,
  silentLogger,
  type Fixture,
} from './helpers/orchestrator-fixture.js'

const BUILD = `export default {
  tasks: {
    build: {
      exec: { command: 'cat in.txt > out.txt' },
      cache: { inputs: { files: ['in.txt'] }, outputs: { files: ['out.txt'] } },
    },
  },
}
`

const saved = { ...process.env }
let xdg: string
const made: string[] = []

beforeEach(async () => {
  xdg = await mkdtemp(path.join(os.tmpdir(), 'vx-xdg-'))
  made.push(xdg)
  delete process.env['VX_CACHE_DIR']
  process.env['XDG_CACHE_HOME'] = xdg
})

afterEach(async () => {
  restoreEnv(saved)
  await Promise.all(made.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

const store = (): string => path.join(xdg, 'vx', `store-${SCHEMA_VERSION}`)

async function workspace(input = 'hi\n'): Promise<Fixture & { pkg: string }> {
  const f = await makeWorkspace('vx-shared-')
  made.push(f.root)
  const pkg = await addProject(f.root, 'app', { config: BUILD, files: { 'in.txt': input } })
  return { ...f, pkg }
}

async function build(f: Fixture): Promise<{ status: string; restored: boolean | undefined }> {
  const r = await run({ cwd: f.root, tasks: ['build'], log: silentLogger(f) })
  expect(r.ok).toBe(true)
  const o = r.outcomes.find((x) => x.node.id === 'app#build')!
  return { status: o.status, restored: o.restored }
}

/** Rows of `table` in a workspace's own index, read beside vx's handle. */
function rows(f: Fixture, sql: string): unknown[] {
  const db = new Database(path.join(f.root, '.vx', 'cache', 'cache.db'), { readonly: true })
  try {
    return db.query(sql).all()
  } finally {
    db.close()
  }
}

describe('the shared store', () => {
  it('a workspace hits what another saved, and restores it', async () => {
    const a = await workspace()
    const b = await workspace()
    expect(await build(a)).toEqual({ status: 'success', restored: undefined })
    await rm(path.join(a.pkg, 'out.txt'))
    expect(await build(b)).toEqual({ status: 'cache-hit', restored: true })
    expect(await readFile(path.join(b.pkg, 'out.txt'), 'utf8')).toBe('hi\n')
    // The entry and its artifact are the store's, not either workspace's.
    const artifacts = (await Array.fromAsync(new Bun.Glob('*.tar.zst').scan(store()))).length
    expect(artifacts).toBe(1)
    expect(
      await Array.fromAsync(new Bun.Glob('*.tar.zst').scan(path.join(a.root, '.vx', 'cache'))),
    ).toEqual([])
    expect(
      rows(a, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'entries'"),
    ).toEqual([])
  })

  it('each workspace reads its own history', async () => {
    const a = await workspace()
    const b = await workspace()
    await build(a)
    await build(a)
    await build(b)
    expect(rows(a, 'SELECT status FROM runs ORDER BY id')).toEqual([
      { status: 'success' },
      { status: 'cache-hit' },
    ])
    expect(rows(b, 'SELECT status FROM runs ORDER BY id')).toEqual([{ status: 'cache-hit' }])
  })

  it('two worktrees on one entry each stay up to date', async () => {
    // Each workspace stamps the files it restored in its own index: stamps
    // kept on the shared entry were overwritten by the other worktree, and
    // every switch between the two restored.
    const a = await workspace()
    const b = await workspace()
    await build(a)
    expect(await build(a)).toEqual({ status: 'cache-hit', restored: false })
    expect(await build(b)).toEqual({ status: 'cache-hit', restored: true })
    expect(await build(b)).toEqual({ status: 'cache-hit', restored: false })
    expect(await build(a)).toEqual({ status: 'cache-hit', restored: false })
  })

  it('a different input misses, in either workspace', async () => {
    const a = await workspace('one\n')
    const b = await workspace('two\n')
    await build(a)
    expect((await build(b)).status).toBe('success')
    expect(await readFile(path.join(b.pkg, 'out.txt'), 'utf8')).toBe('two\n')
  })

  it('a named cache dir holds everything and shares nothing', async () => {
    process.env['VX_CACHE_DIR'] = '.vx/own'
    const a = await workspace()
    const b = await workspace()
    await build(a)
    expect((await build(b)).status).toBe('success')
    expect(existsSync(path.join(xdg, 'vx'))).toBe(false)
    expect(existsSync(path.join(a.root, '.vx', 'own', 'cache.db'))).toBe(true)
  })

  it('an unusable store keeps the entries in the workspace, said once', async () => {
    // A file where the store's root should be: mkdir fails as any user.
    await writeFile(path.join(xdg, 'vx'), '')
    const a = await workspace()
    expect((await build(a)).status).toBe('success')
    expect((await build(a)).status).toBe('cache-hit')
    const fallback = path.join(a.root, '.vx', 'cache', `store-${SCHEMA_VERSION}`)
    expect(existsSync(path.join(fallback, 'store.db'))).toBe(true)
    const said = a.log.filter((l) => l.includes('shared cache store'))
    expect(said).toHaveLength(1)
    expect(said[0]).toStartWith(`[vx] shared cache store ${store()} (`)
    expect(said[0]).toEndWith(
      `is not usable; entries stay in ${fallback}, where no other workspace hits them`,
    )
  })

  it('a workspace that held its own entries moves them out once, keeping its history', async () => {
    const a = await workspace()
    process.env['VX_CACHE_DIR'] = '.vx/cache'
    await build(a)
    delete process.env['VX_CACHE_DIR']
    // The index held `entries`: left in place, it would shadow the store's.
    expect((await build(a)).status).toBe('success')
    expect(a.log.filter((l) => l.includes('now live in the shared store'))).toHaveLength(1)
    expect((await build(a)).status).toBe('cache-hit')
    expect(rows(a, 'SELECT status FROM runs ORDER BY id')).toEqual([
      { status: 'success' },
      { status: 'success' },
      { status: 'cache-hit' },
    ])
    expect(a.log.filter((l) => l.includes('now live in the shared store'))).toHaveLength(1)
  })

  it("a reading verb's handle follows the store the index records", async () => {
    const a = await workspace()
    await build(a)
    const cache = Cache.inspect(path.join(a.root, '.vx', 'cache'))
    try {
      expect(cache.storeDir).toBe(store())
      expect(cache.stats().entryCount).toBe(1)
    } finally {
      cache.close()
    }
  })
})

describe('resolveStoreRoot', () => {
  it("is vx under the user's cache directory", () => {
    expect(resolveStoreRoot(null)).toBe(path.join(xdg, 'vx'))
  })

  it('ignores a relative XDG_CACHE_HOME, as the spec says to', () => {
    process.env['XDG_CACHE_HOME'] = 'rel'
    process.env['HOME'] = '/home/someone'
    const base =
      process.platform === 'darwin'
        ? path.join('/home/someone', 'Library', 'Caches')
        : path.join('/home/someone', '.cache')
    expect(resolveStoreRoot(null)).toBe(path.join(base, 'vx'))
  })

  it('is null when the workspace names its cache dir', () => {
    expect(resolveStoreRoot({ cacheDir: '.cache/vx' })).toBeNull()
    process.env['VX_CACHE_DIR'] = '.cache/vx'
    expect(resolveStoreRoot(null)).toBeNull()
  })
})
