// `vx cache clean` with no bound, through the real binary: it deletes the
// workspace's `.vx/cache` and the store its index names (`~/.vx/<id>/cache`),
// and nothing else in `.vx`; `--global` takes every store under `~/.vx`.
// Before it, a bare prune was refused and the docs said to delete the
// store by hand (2026-10-14).

import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, readdirSync, realpathSync, symlinkSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { addProject, makeWorkspace } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, 'helpers', 'vx-locked.ts')
const TIMEOUT = 30_000

describe('vx cache clean with no bound clears the cache', () => {
  let root = ''
  let home = ''
  const vx = async (args: string[], env: Record<string, string> = {}) => {
    const proc = Bun.spawn([process.execPath, BIN, ...args], {
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, NO_COLOR: '1', HOME: home, VX_CACHE_DIR: '', ...env },
    })
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    return { code, out, err }
  }
  /** The repo's store under the fake home: `~/.vx/<id>/cache`. */
  const store = (): string => {
    const vxHome = path.join(home, '.vx')
    const [id] = readdirSync(vxHome)
    return path.join(vxHome, id!, 'cache')
  }

  beforeEach(async () => {
    home = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'vx-clear-home-')))
    root = realpathSync(await makeWorkspace({ prefix: 'vx-clear-', git: 'commit' }))
    await addProject(root, 'app', {
      config: `export default { tasks: { build: {
        exec: { command: 'mkdir -p dist && echo built > dist/out.txt' },
        inputs: { files: ['src/**'] }, cache: { outputs: { files: ['dist/**'] } },
      } } }\n`,
      files: { 'src/i.txt': 'x\n' },
    })
    await Bun.write(path.join(root, '.vx', 'sentinel.json'), '{}')
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true })
  })

  it(
    'a dry run deletes nothing; the real one deletes .vx/cache and the store, and nothing else',
    async () => {
      expect((await vx(['run', 'build', '--all'])).code).toBe(0)
      const dotVx = readdirSync(path.join(root, '.vx')).sort()
      expect(dotVx).toContain('cache')
      expect(readdirSync(store()).length).toBeGreaterThan(0)
      const st = store()

      const dry = await vx(['cache', 'clean', '--dry', '--format', 'json'])
      expect({ code: dry.code, err: dry.err }).toEqual({ code: 0, err: '' })
      const plan = JSON.parse(dry.out) as { dry: boolean; cleared: string[]; bytesFreed: number }
      expect([plan.dry, plan.cleared, plan.bytesFreed > 0]).toEqual([true, ['.vx/cache', st], true])
      expect([existsSync(path.join(root, '.vx', 'cache')), existsSync(st)]).toEqual([true, true])

      const real = await vx(['cache', 'clean'])
      expect({ code: real.code, err: real.err }).toEqual({ code: 0, err: '' })
      expect(real.out).toMatch(/^✓ vx cache clean {2}freed \d[^\n]*\n\n/)
      expect(real.out.split('\n\n')[1]).toBe(`  .vx/cache\n  ${st}\n`)
      expect([existsSync(path.join(root, '.vx', 'cache')), existsSync(st)]).toEqual([false, false])
      // The workspace config, the lock and .vx/.gitignore stay.
      expect(readdirSync(path.join(root, '.vx')).sort()).toEqual(dotVx.filter((e) => e !== 'cache'))

      // The next run misses and saves again.
      const again = await vx(['run', 'build', '--all'])
      expect(again.code).toBe(0)
      expect(again.out).not.toContain('cache hit')
      expect(existsSync(st)).toBe(true)
    },
    TIMEOUT,
  )

  it(
    '--global clears every store under ~/.vx; a bound with it is refused',
    async () => {
      expect((await vx(['run', 'build', '--all'])).code).toBe(0)
      const other = path.join(home, '.vx', 'another-repo', 'cache')
      await Bun.write(path.join(other, 'cache.db'), 'x')
      const bounded = await vx(['cache', 'clean', '--global', '--older-than', '1d'])
      expect([bounded.code, existsSync(other)]).toEqual([1, true])
      const r = await vx(['cache', 'clean', '--global', '--format', 'json'])
      expect(r.code).toBe(0)
      const cleared = (JSON.parse(r.out) as { cleared: string[] }).cleared
      expect(cleared).toContain(other)
      expect(cleared).toContain('.vx/cache')
      expect([existsSync(other), existsSync(path.join(root, '.vx', 'cache'))]).toEqual([
        false,
        false,
      ])
      expect(existsSync(path.join(home, '.vx'))).toBe(true)
    },
    TIMEOUT,
  )

  it(
    'deletes the store the index names only when it is a vx store',
    async () => {
      // The index is a file in the checkout: one a repo committed, or a CI
      // cache restored, named any directory, and the clear deleted it whole.
      expect((await vx(['run', 'build', '--all'])).code).toBe(0)
      const victim = path.join(home, 'projects')
      await Bun.write(path.join(victim, 'keep.txt'), 'mine')
      const db = new Database(path.join(root, '.vx', 'cache', 'cache.db'))
      db.query("UPDATE schema_meta SET value = ? WHERE key = 'store_dir'").run(victim)
      db.close()
      const r = await vx(['cache', 'clean'])
      expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: '' })
      expect(r.out).not.toContain(victim)
      expect(existsSync(path.join(victim, 'keep.txt'))).toBe(true)
      expect(existsSync(path.join(root, '.vx', 'cache'))).toBe(false)
    },
    TIMEOUT,
  )

  it(
    'a workspace that never ran has nothing to clear',
    async () => {
      const r = await vx(['cache', 'clean'])
      expect(r).toEqual({ code: 0, out: '› vx cache clean  nothing to free\n', err: '' })
    },
    TIMEOUT,
  )

  it(
    'a trim of a directory vx never wrote makes nothing there',
    async () => {
      // Opened to find nothing, it got an index and a `*` .gitignore that
      // hid the user's files from git.
      const dir = path.join(root, 'notes')
      await Bun.write(path.join(dir, 'keep.txt'), 'mine')
      const r = await vx(['cache', 'clean', '--older-than', '30d', '--cache-dir', 'notes'])
      expect(r).toEqual({ code: 0, out: '› vx cache clean  nothing to free\n', err: '' })
      expect(readdirSync(dir)).toEqual(['keep.txt'])
    },
    TIMEOUT,
  )

  it(
    'refuses a cache.dir that holds the workspace config',
    async () => {
      await Bun.write(path.join(root, '.vx', 'cache.db'), '')
      const r = await vx(['cache', 'clean', '--cache-dir', '.vx'])
      expect(r.code).toBe(1)
      expect(r.err).toContain('holds the workspace config and lock')
      expect(existsSync(path.join(root, '.vx', 'sentinel.json'))).toBe(true)
    },
    TIMEOUT,
  )
  it(
    'in a cache.dir the user named, deletes only what vx wrote there (item 968)',
    async () => {
      // `cache.dir` may be a shared directory (`build/`, `~/.cache`); the
      // clear took it whole, the user's own files with it.
      const shared = path.join(home, 'shared')
      const env = { VX_CACHE_DIR: shared }
      expect((await vx(['run', 'build', '--all'], env)).code).toBe(0)
      await Bun.write(path.join(shared, 'release.tar.zst'), 'mine')
      await Bun.write(path.join(shared, 'notes', 'keep.txt'), 'mine')
      expect(existsSync(path.join(shared, 'cache.db'))).toBe(true)

      const r = await vx(['cache', 'clean'], env)
      expect(r.code).toBe(0)
      expect(readdirSync(shared).sort()).toEqual(['notes', 'release.tar.zst'])
      expect(await Bun.file(path.join(shared, 'notes', 'keep.txt')).text()).toBe('mine')
      // Control: vx's own files are gone, so the next run misses and saves again.
      const again = await vx(['run', 'build', '--all'], env)
      expect(again.code).toBe(0)
      expect(existsSync(path.join(shared, 'cache.db'))).toBe(true)
    },
    TIMEOUT,
  )
  it(
    "in a cache.dir the user named, keeps the user's runs/, compiled/ and steps/",
    async () => {
      // vx writes no directory into a named one (history, steps, warnings and
      // failures are in cache.db, the config bundle in `.vx/cache/compiled`),
      // yet the clear took `runs` and `compiled`, and later `steps`.
      const shared = path.join(home, 'shared')
      const env = { VX_CACHE_DIR: shared }
      expect((await vx(['run', 'build', '--all'], env)).code).toBe(0)
      for (const dir of ['runs', 'compiled', 'steps'])
        expect(readdirSync(shared)).not.toContain(dir)
      await Bun.write(path.join(shared, 'runs', 'ci.log'), 'mine')
      await Bun.write(path.join(shared, 'compiled', 'app.js'), 'mine')
      await Bun.write(path.join(shared, 'steps', '0190a000-0000-7000-8000-000000000000.json'), '[]')

      const r = await vx(['cache', 'clean'], env)
      expect(r.code).toBe(0)
      expect(readdirSync(shared).sort()).toEqual(['compiled', 'runs', 'steps'])
    },
    TIMEOUT,
  )
  it(
    'clears an index SQLite cannot read, the recovery its own refusal names',
    async () => {
      expect((await vx(['run', 'build', '--all'])).code).toBe(0)
      const db = path.join(root, '.vx', 'cache', 'cache.db')
      for (const f of ['', '-wal', '-shm']) await rm(db + f, { force: true })
      await Bun.write(db, 'not a database '.repeat(200))

      const r = await vx(['cache', 'clean'])
      expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: '' })
      expect(existsSync(path.join(root, '.vx', 'cache'))).toBe(false)
      expect(existsSync(store())).toBe(false)
    },
    TIMEOUT,
  )
  it(
    'a .vx/cache that is a symlink: clears what it points at, not only the link',
    async () => {
      // CI restores the cache onto a volume and links it in.
      const mount = path.join(home, 'ci-mount')
      mkdirSync(mount)
      symlinkSync(mount, path.join(root, '.vx', 'cache'))
      expect((await vx(['run', 'build', '--all'])).code).toBe(0)
      expect(existsSync(path.join(mount, 'cache.db'))).toBe(true)

      const r = await vx(['cache', 'clean'])
      expect(r.code).toBe(0)
      expect(r.out).toContain('.vx/cache')
      expect(readdirSync(mount)).toEqual([])
    },
    TIMEOUT,
  )
})
