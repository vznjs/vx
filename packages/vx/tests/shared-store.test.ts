// The default cache layout (v32): each workspace keeps its index, history
// and memos in its own `.vx/cache`, and the entries and artifacts live in
// its repository's store under `~/.vx/<id>/cache`, so one checkout hits what
// another saved and another repository does not. The
// suite runs with VX_CACHE_DIR set (vx.config.ts); every row here unsets
// it and points HOME at a temp directory of its own.

import { Database } from 'bun:sqlite'
import { existsSync, rmSync, statSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Cache } from '../src/cache/index.js'
import { run } from '../src/orchestrator/index.js'
import { resolveStoreRoot } from '../src/workspace/index.js'
import { parseGitConfigRemotes, parseRemoteUrl, repoIdOf } from '../src/workspace/repo-id.js'
import { restoreEnv } from './helpers/env.js'
import { gitIn, gitInitCommit } from './helpers/workspace.js'
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
let home: string
const made: string[] = []

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'vx-home-'))
  made.push(home)
  delete process.env['VX_CACHE_DIR']
  process.env['HOME'] = home
})

afterEach(async () => {
  restoreEnv(saved)
  await Promise.all(made.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

const ORIGIN = 'https://github.com/acme/app.git'

/** The one store under the home, wherever its repository id put it. */
async function stores(): Promise<string[]> {
  const glob = new Bun.Glob('*/cache/store.db')
  const found = await Array.fromAsync(glob.scan({ cwd: path.join(home, '.vx') }))
  return found.map((f) => path.join(home, '.vx', path.dirname(f))).sort()
}

async function store(): Promise<string> {
  const all = await stores()
  expect(all).toHaveLength(1)
  return all[0]!
}

/** A checkout of the repository at `origin` (none: a repository of its own). */
async function workspace(
  input = 'hi\n',
  origin: string | null = ORIGIN,
): Promise<Fixture & { pkg: string }> {
  const f = await makeWorkspace('vx-shared-')
  made.push(f.root)
  if (origin !== null) gitIn(f.root)('remote', 'add', 'origin', origin)
  const pkg = await addProject(f.root, 'app', { config: BUILD, files: { 'in.txt': input } })
  return { ...f, pkg }
}

async function build(f: Fixture): Promise<{ status: string; restored: boolean | undefined }> {
  const r = await run({ cwd: f.root, tasks: ['build'], log: silentLogger(f) })
  expect(r.ok).toBe(true)
  const o = r.outcomes.find((x) => x.node.id === 'app#build')!
  return { status: o.status, restored: o.restored }
}

/**
 * What the runs said besides each run's summary block: the task lines, and
 * any line vx printed of its own (a store fallback, a move, a reset).
 */
function said(f: Fixture): { log: string[]; err: string[] } {
  const summary = /^(|─ vx .*|  (projects|tasks|cache|info|time|result) .*| {12}\S.*)$/
  return { log: f.log.filter((l) => !summary.test(l)), err: f.err }
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
    const artifacts = (await Array.fromAsync(new Bun.Glob('*.tar.zst').scan(await store()))).length
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
    expect(existsSync(path.join(home, '.vx'))).toBe(false)
    expect(existsSync(path.join(a.root, '.vx', 'own', 'cache.db'))).toBe(true)
  })

  it('an unusable store keeps the entries in the workspace, in silence', async () => {
    // A file where the store's root should be: mkdir fails as any user.
    await writeFile(path.join(home, '.vx'), '')
    const a = await workspace()
    expect((await build(a)).status).toBe('success')
    expect((await build(a)).status).toBe('cache-hit')
    const fallback = path.join(a.root, '.vx', 'cache')
    expect(existsSync(path.join(fallback, 'store.db'))).toBe(true)
    expect(said(a)).toEqual({
      log: ['task app#build success', 'task app#build cache-hit'],
      err: [],
    })
  })

  it('a ~/.vx of ours open to other users is closed to 700 and used', async () => {
    await mkdir(path.join(home, '.vx'), { mode: 0o755 })
    await chmod(path.join(home, '.vx'), 0o755)
    const a = await workspace()
    expect((await build(a)).status).toBe('success')
    expect([
      (statSync(path.join(home, '.vx')).mode & 0o777).toString(8),
      said(a),
      (await stores()).length,
    ]).toEqual(['700', { log: ['task app#build success'], err: [] }, 1])
  })

  it('makes each level of the store owner-only', async () => {
    const a = await workspace()
    await build(a)
    const root = path.join(home, '.vx', (await repoIdOf(a.root))!)
    for (const d of [path.join(home, '.vx'), root, path.join(root, 'cache')]) {
      expect((statSync(d).mode & 0o777).toString(8)).toBe('700')
    }
  })

  it('a workspace that held its own entries moves them out once, keeping its history', async () => {
    const a = await workspace()
    process.env['VX_CACHE_DIR'] = '.vx/cache'
    await build(a)
    delete process.env['VX_CACHE_DIR']
    // The index held `entries`: left in place, it would shadow the store's.
    expect((await build(a)).status).toBe('success')
    expect((await build(a)).status).toBe('cache-hit')
    expect(rows(a, 'SELECT status FROM runs ORDER BY id')).toEqual([
      { status: 'success' },
      { status: 'success' },
      { status: 'cache-hit' },
    ])
    // The move is vx's own upkeep: nothing printed (owner, 2026-10-06).
    expect(said(a)).toEqual({
      log: ['task app#build success', 'task app#build success', 'task app#build cache-hit'],
      err: [],
    })
  })

  it('another repository keeps its own store', async () => {
    const a = await workspace()
    const b = await workspace('hi\n', 'git@github.com:acme/other.git')
    await build(a)
    expect((await build(b)).status).toBe('success')
    expect(await stores()).toHaveLength(2)
  })

  it("a clone over ssh shares the https clone's store", async () => {
    const a = await workspace()
    const b = await workspace('hi\n', 'git@github.com:Acme/app.git')
    await build(a)
    expect((await build(b)).status).toBe('cache-hit')
  })

  it('a repository with no identity holds everything and shares nothing', async () => {
    // No remote and no commit yet: nothing a second clone would agree on.
    const a = await workspace('hi\n', null)
    await build(a)
    expect(existsSync(path.join(home, '.vx'))).toBe(false)
    expect(
      rows(a, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'entries'"),
    ).toEqual([{ name: 'entries' }])
  })

  it('a store of another schema loses its inventory, not its artifacts', async () => {
    const a = await workspace()
    await build(a)
    const db = new Database(path.join(await store(), 'store.db'))
    // Another vx's tables: this one could not read them.
    db.exec("UPDATE store_meta SET value = 'v0' WHERE key = 'schema'")
    db.exec('DROP TABLE entries; CREATE TABLE entries (hash TEXT PRIMARY KEY, other TEXT)')
    db.close()
    await rm(path.join(a.pkg, 'out.txt'))
    expect(await build(a)).toEqual({ status: 'cache-hit', restored: true })
    expect(await build(a)).toEqual({ status: 'cache-hit', restored: false })
    expect(said(a)).toEqual({
      log: ['task app#build success', 'task app#build cache-hit', 'task app#build cache-hit'],
      err: [],
    })
  })

  it("a reading verb's handle follows the store the index records", async () => {
    const a = await workspace()
    await build(a)
    const cache = Cache.inspect(path.join(a.root, '.vx', 'cache'))
    try {
      expect(cache.storeDir).toBe(await store())
      expect(cache.stats().entryCount).toBe(1)
    } finally {
      cache.close()
    }
  })
})

describe('resolveStoreRoot', () => {
  it('is ~/.vx/<repo id>/cache on every platform', async () => {
    process.env['XDG_CACHE_HOME'] = '/elsewhere'
    const a = await workspace()
    expect(await resolveStoreRoot(a.root, null)).toBe(
      path.join(home, '.vx', (await repoIdOf(a.root))!, 'cache'),
    )
  })

  it('is null when the workspace names its cache dir', async () => {
    const a = await workspace()
    expect(await resolveStoreRoot(a.root, { cacheDir: '.cache/vx' })).toBeNull()
    process.env['VX_CACHE_DIR'] = '.cache/vx'
    expect(await resolveStoreRoot(a.root, null)).toBeNull()
  })
})

describe('repoIdOf', () => {
  it('is one id for every spelling of one remote', async () => {
    const ids = new Set<string | null>()
    for (const url of [
      'https://github.com/acme/app.git',
      'https://x-access-token:t0k@github.com/Acme/App',
      'git@github.com:acme/app.git',
      'ssh://git@github.com:22/acme/app.git',
    ]) {
      const f = await workspace('hi\n', url)
      ids.add(await repoIdOf(f.root))
    }
    expect([...ids]).toHaveLength(1)
    expect([...ids][0]).toMatch(/^[0-9a-f]{16}$/)
  })

  it('tells workspaces in one repository apart by their path in it', async () => {
    const f = await workspace()
    const sub = path.join(f.root, 'packages', 'app')
    expect(await repoIdOf(sub)).not.toBeNull()
    expect(await repoIdOf(sub)).not.toBe(await repoIdOf(f.root))
  })

  it('is the first commit with no remote, which a clone shares and a shallow clone lacks', async () => {
    const a = await workspace('hi\n', null)
    gitInitCommit(a.root)
    const tmp = await realpath(os.tmpdir())
    const clone = path.join(tmp, `vx-clone-${process.pid}-${Date.now()}`)
    made.push(clone)
    gitIn(tmp)('clone', '-q', a.root, clone)
    gitIn(clone)('remote', 'remove', 'origin')
    expect(await repoIdOf(clone)).toBe(await repoIdOf(a.root))
    expect(await repoIdOf(a.root)).toMatch(/^[0-9a-f]{16}$/)
    const shallow = path.join(tmp, `vx-shallow-${process.pid}-${Date.now()}`)
    made.push(shallow)
    gitIn(tmp)('clone', '-q', '--depth=1', `file://${a.root}`, shallow)
    gitIn(shallow)('remote', 'remove', 'origin')
    expect(await repoIdOf(shallow)).toBeNull()
    const b = await workspace('hi\n', null)
    expect(await repoIdOf(b.root)).toBeNull()
  })

  it('a worktree is its repository', async () => {
    const a = await workspace()
    gitInitCommit(a.root)
    const wt = path.join(await realpath(os.tmpdir()), `vx-wt-${process.pid}-${Date.now()}`)
    made.push(wt)
    gitIn(a.root)('worktree', 'add', '-q', wt)
    expect(await repoIdOf(wt)).toBe(await repoIdOf(a.root))
  })

  it('is null outside git', async () => {
    const d = await mkdtemp(path.join(os.tmpdir(), 'vx-nogit-'))
    made.push(d)
    expect(await repoIdOf(d)).toBeNull()
  })

  it('reads origin, then upstream, then base, then the first remote', async () => {
    const f = await workspace('hi\n', null)
    const git = gitIn(f.root)
    git('remote', 'add', 'fork', 'https://github.com/me/fork.git')
    git('remote', 'add', 'base', 'https://github.com/acme/base.git')
    const id = await repoIdOf(f.root)
    git('remote', 'remove', 'base')
    git('remote', 'add', 'base', 'git@github.com:Acme/base.git')
    expect(await repoIdOf(f.root)).toBe(id)
    git('remote', 'remove', 'base')
    expect(await repoIdOf(f.root)).not.toBe(id)
  })

  it('leaves to git a config it cannot read whole', () => {
    expect(
      parseGitConfigRemotes('[include]\n\tpath = x\n[remote "origin"]\n\turl = a\n'),
    ).toBeNull()
    expect(parseGitConfigRemotes('[url "git@h:"]\n\tinsteadOf = gh:\n')).toBeNull()
    expect(parseGitConfigRemotes('[remote "origin"]\n\turl = a # b\n')).toBeNull()
    expect(
      parseGitConfigRemotes(
        '[remote "origin"]\n\turl = "a"\n\turl = b\n[remote "up"]\n\turl = c\n',
      ),
    ).toEqual([
      ['origin', 'a'],
      ['up', 'c'],
    ])
  })

  // X-17: with `.vx/cache` deleted the prune and `vx info` read no index,
  // so no store: "0 entries" while every entry stayed restorable.
  it('prune and info reach the store with the index deleted', async () => {
    const a = await workspace()
    await build(a)
    await rm(path.join(a.root, '.vx', 'cache'), { recursive: true })
    const bin = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
    const vx = (...args: string[]): string => {
      const p = Bun.spawnSync({
        cmd: [process.execPath, bin, ...args],
        cwd: a.root,
        env: { ...process.env, NO_COLOR: '1' },
      })
      return `${p.exitCode} ${p.stdout.toString()}`
    }
    const info = vx('info')
    expect(info).toMatch(/cache entries:\s+1 \(/)
    expect(vx('cache', 'prune', '--max-size', '1B', '--dry-run')).toMatch(
      /^0 Would prune 1 entry \(/,
    )
    expect(vx('cache', 'prune', '--max-size', '1B')).toMatch(/^0 Pruned 1 entry \(/)
    rmSync(path.join(a.root, '.vx', 'cache'), { recursive: true })
    expect(await build(a)).toEqual({ status: 'success', restored: undefined })
  })

  // The dry prune on an earlier index counted only the workspace's own
  // directory, so it named 0 entries where the real prune, which resets the
  // index and keeps the store, evicted the store's.
  it('a dry prune on an earlier index names what the real prune takes from the store', async () => {
    const a = await workspace()
    await build(a)
    const db = new Database(path.join(a.root, '.vx', 'cache', 'cache.db'))
    db.query("UPDATE schema_meta SET value = 'v0' WHERE key = 'version'").run()
    db.close()
    const bin = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
    const vx = (...args: string[]): string[] => {
      const p = Bun.spawnSync({
        cmd: [process.execPath, bin, 'cache', 'prune', '--max-size', '1B', ...args],
        cwd: a.root,
        env: { ...process.env, NO_COLOR: '1' },
      })
      return [String(p.exitCode), p.stdout.toString(), p.stderr.toString()]
    }
    const dry = vx('--dry-run', '--format', 'json')
    const wet = vx('--format', 'json')
    expect(dry).toEqual(['0', wet[1]!.replace('"dryRun":false', '"dryRun":true'), ''])
    expect(JSON.parse(wet[1]!)).toMatchObject({ evicted: 1 })
  })

  it('reads the four url shapes Nx reads', () => {
    expect(parseRemoteUrl('git@GitHub.com:Acme/App.git')).toBe('GitHub.com/Acme/App')
    expect(parseRemoteUrl('https://u:p@github.com/acme/app.git')).toBe('github.com/acme/app')
    expect(parseRemoteUrl('http://github.com/acme/app')).toBe('github.com/acme/app')
    expect(parseRemoteUrl('ssh://git@github.com:22/acme/app.git')).toBe('github.com/acme/app')
    expect(parseRemoteUrl('/srv/git/app.git')).toBeNull()
  })
})
