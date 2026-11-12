// `vx cache clean` with no bound, through the real binary: it deletes the
// workspace's `.vx/cache` and the store its index names (`~/.vx/<id>/cache`),
// and nothing else in `.vx`; `--global` takes every store under `~/.vx`.
// Before it, a bare prune was refused and the docs said to delete the
// store by hand (2026-10-14). A bounded clean's history prune is here too:
// it shares the workspace and the binary.

import { Database } from 'bun:sqlite'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { mkdtemp, rename, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { addProject, gitIn, makeWorkspace } from './helpers/workspace.js'
import { holdCacheDir, holdStore } from '../src/cache/index.js'
import { acquireRunLock } from '../src/orchestrator/index.js'

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
        inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] }, cache: true,
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
      expect(real.out.split('\n\n').slice(1)).toEqual([
        `  .vx/cache\n  ${st}`,
        // The index holds the run history: say so where the user decides.
        '  run history cleared too: vx last and vx why start over\n',
      ])
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
    '--global clears every store under ~/.vx and nothing else there; a bound with it is refused',
    async () => {
      expect((await vx(['run', 'build', '--all'])).code).toBe(0)
      const st = store()
      const other = path.join(home, '.vx', 'another-repo', 'cache')
      await Bun.write(path.join(other, 'store.db'), 'x')
      // A `cache` directory with no store.db is not a store: --global
      // deleted it whole, as it deleted any `~/.vx/*/cache`.
      const notStore = path.join(home, '.vx', 'mine', 'cache')
      await Bun.write(path.join(notStore, 'keep.txt'), 'mine')
      const bounded = await vx(['cache', 'clean', '--global', '--older-than', '1d'])
      expect([bounded.code, existsSync(other)]).toEqual([1, true])
      const r = await vx(['cache', 'clean', '--global', '--format', 'json'])
      expect(r.code).toBe(0)
      const cleared = (JSON.parse(r.out) as { cleared: string[] }).cleared
      expect(cleared.sort()).toEqual(['.vx/cache', other, st].sort())
      expect(existsSync(path.join(notStore, 'keep.txt'))).toBe(true)
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
  // The store is shared by every checkout of the repository, and each one's
  // run lock is its own: a clean in one deleted store.db under a run in
  // another, and that run's entries went with it. A run holds the store
  // open from start to end; the clean and the trim wait for it to close.
  it.each([
    ['a clear', ['cache', 'clean']],
    ['a trim', ['cache', 'clean', '--max-size', '1B']],
  ])(
    '%s waits for a process that holds the store open (a run in another checkout)',
    async (_, args) => {
      expect((await vx(['run', 'build', '--all'])).code).toBe(0)
      const st = store()
      const held = new Database(path.join(st, 'store.db'))
      held.query('SELECT count(*) FROM entries').get()
      const proc = Bun.spawn([process.execPath, BIN, ...args], {
        cwd: root,
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, NO_COLOR: '1', HOME: home, VX_CACHE_DIR: '' },
      })
      const out = new Response(proc.stdout).text()
      // Released once the clean says it waits, not after a fixed sleep: a
      // CI runner's stall outlasted 1.5 s before the clean reached the
      // store, so it never waited and never said so (2026-11-07).
      let err = ''
      const reader = proc.stderr.getReader()
      const decoder = new TextDecoder()
      try {
        while (!err.includes('waiting for another vx process')) {
          const { done, value } = await reader.read()
          if (done) break
          err += decoder.decode(value, { stream: true })
        }
        expect(err).toContain(`waiting for another vx process using the cache store ${st}`)
        expect([proc.exitCode, existsSync(path.join(st, 'store.db'))]).toEqual([null, true])
        expect((held.query('SELECT count(*) AS n FROM entries').get() as { n: number }).n).toBe(1)
      } finally {
        held.close()
      }
      // Drained to the end, so the clean never writes into a closed pipe.
      for (let c = await reader.read(); !c.done; c = await reader.read()) decoder.decode(c.value)
      const r = { code: await proc.exited, out: await out }
      expect(r.code).toBe(0)
      if (args.length === 2) expect(existsSync(st)).toBe(false)
      else expect(r.out).toContain('1 entry')
    },
    TIMEOUT,
  )
  /** Spawn `args` and read its stderr until it says `notice` or ends; the rest drains later. */
  const spawnUntil = async (
    cwd: string,
    args: string[],
    env: Record<string, string>,
    notice: string,
  ) => {
    const proc = Bun.spawn([process.execPath, BIN, ...args], {
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, NO_COLOR: '1', HOME: home, ...env },
    })
    const out = new Response(proc.stdout).text()
    let err = ''
    const reader = proc.stderr.getReader()
    const decoder = new TextDecoder()
    while (!err.includes(notice)) {
      const { done, value } = await reader.read()
      if (done) break
      err += decoder.decode(value, { stream: true })
    }
    const said = err
    const ended = (async () => {
      for (let c = await reader.read(); !c.done; c = await reader.read())
        err += decoder.decode(c.value, { stream: true })
      return { code: await proc.exited, out: await out, err }
    })()
    return { proc, said, ended }
  }
  // A cache directory with no store (`--cache-dir`, `cache.dir`,
  // `VX_CACHE_DIR`) may be shared by workspaces, each with a run lock of its
  // own: a clear in one deleted the directory under a run of another, which
  // died opening it (ENOENT on its .gitignore, SQLite's disk I/O error). A
  // run that found no index there held nothing, and the clear deleted the
  // index it made: the run ended green and its entry was gone.
  it.each([
    ['its index there', 'index'],
    ['no directory there yet', 'none'],
    ['an empty directory there', 'empty'],
  ])(
    'a clear of a shared cache directory waits for a run of another workspace on it, %s',
    async (_, before) => {
      const shared = path.join(home, 'shared')
      const env = { VX_CACHE_DIR: shared }
      if (before === 'index') expect((await vx(['run', 'build', '--all'], env)).code).toBe(0)
      if (before === 'empty') mkdirSync(shared)
      const other = realpathSync(await makeWorkspace({ prefix: 'vx-clear-other-', git: 'commit' }))
      try {
        const gate = await addProject(other, 'gate', {
          config: `export default { tasks: { hold: { exec: { command: 'touch started && while [ ! -f release ]; do sleep 0.05; done' } } } }\n`,
        })
        const run = Bun.spawn([process.execPath, BIN, 'run', 'hold', '--all'], {
          cwd: other,
          stdout: 'ignore',
          stderr: 'pipe',
          env: { ...process.env, NO_COLOR: '1', HOME: home, ...env },
        })
        const runErr = new Response(run.stderr).text()
        const deadline = Date.now() + 10_000
        while (!existsSync(path.join(gate, 'started'))) {
          if (Date.now() > deadline) throw new Error('the other run never started its task')
          await Bun.sleep(20)
        }
        // Released once the clear says it waits, never after a fixed sleep.
        const clear = await spawnUntil(
          root,
          ['cache', 'clean'],
          env,
          'waiting for another vx process using the cache directory',
        )
        expect(clear.said).toContain(
          `waiting for another vx process using the cache directory ${shared}`,
        )
        expect([clear.proc.exitCode, existsSync(path.join(shared, 'cache.db'))]).toEqual([
          null,
          true,
        ])
        await Bun.write(path.join(gate, 'release'), '')
        expect(`${await run.exited}\n${await runErr}`).toStartWith('0\n')
        const r = await clear.ended
        expect(r.code).toBe(0)
        expect(existsSync(path.join(shared, 'cache.db'))).toBe(false)
      } finally {
        await rm(other, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )
  it(
    'a run on a shared cache directory waits for a clear of it before it opens the cache',
    async () => {
      const shared = path.join(home, 'shared')
      expect((await vx(['run', 'build', '--all'], { VX_CACHE_DIR: shared })).code).toBe(0)
      // Stands in for another workspace's clear, holding the directory.
      const release = await holdCacheDir(shared, 'exclusive', () => {})
      let released = false
      try {
        const run = await spawnUntil(
          root,
          ['run', 'build', '--all'],
          { VX_CACHE_DIR: shared },
          'waiting for a vx cache clean',
        )
        expect(run.said).toContain(`waiting for a vx cache clean of ${shared} to finish`)
        expect(run.proc.exitCode).toBe(null)
        // The clear deletes the directory while it holds it; the run then
        // opens a cache of its own there, misses and saves.
        await rm(shared, { recursive: true })
        release()
        released = true
        const r = await run.ended
        expect(`${r.code}\n${r.err}`).toStartWith('0\n')
        expect(r.out).toContain('local 1\u2191')
        expect(existsSync(path.join(shared, 'cache.db'))).toBe(true)
      } finally {
        if (!released) release()
      }
    },
    TIMEOUT,
  )
  // The store is shared by every checkout of the repository, each with a
  // run lock of its own: a run in one opening the store while a clean in
  // another held it died after 5 s on SQLite's "database is locked", or,
  // let in sooner, saved into the store.db the clean had unlinked and made
  // the directory again open to others, with no .gitignore. The clean moves
  // the store aside under its hold and deletes it after (cli/cache.ts), and
  // a run in a third checkout may make the store again meanwhile.
  it.each([
    ['deleted it', (st: string) => rm(st, { recursive: true })],
    [
      'moved it aside, and another run made it again',
      async (st: string) => {
        await rename(st, `${st}.removing`)
        mkdirSync(st, { mode: 0o700 })
        const made = new Database(path.join(st, 'store.db'))
        made.exec('PRAGMA journal_mode = WAL')
        made.close()
      },
    ],
  ])(
    'a run waits for a clean of the store, which then %s: it opens the store there now',
    async (_, clean) => {
      expect((await vx(['run', 'build', '--all'])).code).toBe(0)
      const st = store()
      // Stands in for another checkout's clean, holding the store.
      const release = await holdStore(st, () => {})
      let released = false
      try {
        const run = await spawnUntil(
          root,
          ['run', 'build', '--all'],
          { VX_CACHE_DIR: '' },
          'waiting for a vx cache clean',
        )
        expect(run.said).toContain(`waiting for a vx cache clean of ${st} to finish`)
        expect(run.proc.exitCode).toBe(null)
        // Let go mid-open: the run's next open waits on the hold up to a
        // second, with the old store.db open. The run then makes a store of
        // its own there, misses and saves into it.
        await Bun.sleep(300)
        await clean(st)
        release()
        released = true
        const r = await run.ended
        expect(`${r.code}\n${r.err}`).toStartWith('0\n')
        expect(r.out).toContain('local 1↑')
        expect(statSync(st).mode & 0o777).toBe(0o700)
        expect(existsSync(path.join(st, '.gitignore'))).toBe(true)
        const db = new Database(path.join(st, 'store.db'), { readonly: true })
        try {
          expect((db.query('SELECT count(*) AS n FROM entries').get() as { n: number }).n).toBe(1)
        } finally {
          db.close()
        }
        expect((await vx(['run', 'build', '--all'])).out).toContain('local 1✓')
      } finally {
        if (!released) release()
      }
    },
    TIMEOUT,
  )
  // Deleted where it stood, the store's index went first and its other
  // files after, and a run in another checkout in between made a store.db
  // there that the delete then took, with the entry the run saved.
  it(
    'a run in another checkout while a clean deletes the store keeps what it saves',
    async () => {
      const wt = `${root}-wt`
      gitIn(root)('worktree', 'add', '-q', wt)
      try {
        cpSync(path.join(root, 'packages', 'app'), path.join(wt, 'packages', 'app'), {
          recursive: true,
        })
        expect((await vx(['run', 'build', '--all'])).code).toBe(0)
        const st = store()
        // Entries beside the index, most of which a delete in place takes
        // after it, in whatever order the directory lists them.
        for (let d = 0; d < 100; d++) {
          mkdirSync(path.join(st, `junk${d}`))
          for (let i = 0; i < 150; i++) writeFileSync(path.join(st, `junk${d}`, String(i)), '')
        }
        // The run waits on its own lock, held here, until the delete is on:
        // it takes that lock just before it opens the store.
        const lock = await acquireRunLock(wt, { log: () => {} })
        const run = await spawnUntil(
          wt,
          ['run', 'build', '--all'],
          { VX_CACHE_DIR: '' },
          'waiting for another vx run',
        )
        const clean = Bun.spawn([process.execPath, BIN, 'cache', 'clean'], {
          cwd: root,
          stdout: 'ignore',
          stderr: 'ignore',
          env: { ...process.env, NO_COLOR: '1', HOME: home, VX_CACHE_DIR: '' },
        })
        while (existsSync(path.join(st, 'store.db')) && clean.exitCode === null) await Bun.sleep(1)
        await lock()
        const r = await run.ended
        expect(`${r.code}\n${r.err}`).toStartWith('0\n')
        expect(await clean.exited).toBe(0)
        expect(r.out).toContain('local 1↑')
        const again = Bun.spawnSync([process.execPath, BIN, 'run', 'build', '--all'], {
          cwd: wt,
          env: { ...process.env, NO_COLOR: '1', HOME: home, VX_CACHE_DIR: '' },
        })
        expect(again.stdout.toString()).toContain('local 1✓')
      } finally {
        await rm(wt, { recursive: true, force: true })
      }
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
  it(
    "a linked .vx/cache: the clear deletes only vx's entries where it points",
    async () => {
      // The clear emptied the link's target entry by entry, whatever it held.
      const mount = path.join(home, 'ci-mount')
      mkdirSync(mount)
      symlinkSync(mount, path.join(root, '.vx', 'cache'))
      expect((await vx(['run', 'build', '--all'])).code).toBe(0)
      await Bun.write(path.join(mount, 'notes', 'keep.txt'), 'mine')
      await Bun.write(path.join(mount, 'keep.txt'), 'mine')

      const r = await vx(['cache', 'clean'])
      expect(r.code).toBe(0)
      expect(readdirSync(mount).sort()).toEqual(['keep.txt', 'notes'])
    },
    TIMEOUT,
  )
  it.each([
    ['the home directory', () => home],
    ['the workspace root', () => '..'],
  ])(
    'a .vx/cache linked to %s is refused by the run and by the clear',
    async (_, target) => {
      // Compared unresolved, the link passed every check: the run wrote its
      // index into home, and the clear then deleted every entry there (the
      // workspace's .git, package.json and .vx/workspace.ts with `..`).
      await Bun.write(path.join(home, 'keep.txt'), 'mine')
      symlinkSync(target(), path.join(root, '.vx', 'cache'))
      const run = await vx(['run', 'build', '--all'])
      expect(run.code).toBe(1)
      expect(run.err).toMatch(/cache directory \S+ (resolves to|holds a package\.json)/)
      expect(existsSync(path.join(home, 'cache.db'))).toBe(false)
      expect(existsSync(path.join(root, 'cache.db'))).toBe(false)
      // The config bundle went there before the index opened.
      expect(existsSync(path.join(realpathSync(path.join(root, '.vx', 'cache')), 'compiled'))).toBe(
        false,
      )
      // An index already there (an older vx wrote it) does not make it vx's.
      await Bun.write(path.join(realpathSync(path.join(root, '.vx', 'cache')), 'cache.db'), '')
      const clean = await vx(['cache', 'clean'])
      expect(clean.code).toBe(1)
      expect(clean.err).toContain('resolves to')
      const again = await vx(['run', 'build', '--all'])
      expect(again.code).toBe(1)
      expect(again.err).toContain('resolves to')
      expect(existsSync(path.join(home, 'keep.txt'))).toBe(true)
      for (const f of ['.git', 'package.json', path.join('.vx', 'workspace.mjs')])
        expect(existsSync(path.join(root, f))).toBe(true)
    },
    TIMEOUT,
  )
  it(
    "keeps the store the index names when it is another workspace's",
    async () => {
      // An index copied or committed from another workspace named that
      // workspace's store, and the clear deleted it: it has a store's shape.
      expect((await vx(['run', 'build', '--all'])).code).toBe(0)
      const other = path.join(home, '.vx', '0123456789abcdef', 'cache')
      cpSync(store(), other, { recursive: true })
      const db = new Database(path.join(root, '.vx', 'cache', 'cache.db'))
      db.query("UPDATE schema_meta SET value = ? WHERE key = 'store_dir'").run(other)
      db.close()
      const r = await vx(['cache', 'clean'])
      expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: '' })
      expect(r.out).not.toContain(other)
      expect(existsSync(path.join(other, 'store.db'))).toBe(true)
      expect(existsSync(path.join(root, '.vx', 'cache'))).toBe(false)
    },
    TIMEOUT,
  )

  it(
    'a bounded clean gives back the pages of the history it drops, and says so',
    async () => {
      // Months of runs left a 140 MB index: the prune dropped 722k rows, the
      // file kept its size, and the verb said "nothing to free".
      expect((await vx(['run', 'build', '--all'])).code).toBe(0)
      const dbFile = path.join(root, '.vx', 'cache', 'cache.db')
      const old = Date.now() - 40 * 86_400_000
      const db = new Database(dbFile)
      db.run('PRAGMA journal_mode = DELETE')
      const insert = db.query(
        "INSERT INTO runs (hash, project, task, status, exit_code, duration_ms, started_at, ended_at) VALUES (?, 'app', 'build', 'success', 0, 1, ?, ?)",
      )
      db.transaction(() => {
        for (let i = 0; i < 20_000; i++) insert.run(`h${i}`.padEnd(64, 'x'), old, old)
      })()
      db.close()
      const before = statSync(dbFile).size
      expect(before).toBeGreaterThan(2 * 1024 * 1024)

      const dry = await vx(['cache', 'clean', '--older-than', '30d', '--dry'])
      expect(statSync(dbFile).size).toBe(before)
      expect(dry.out).not.toContain('history')

      const r = await vx(['cache', 'clean', '--older-than', '30d', '--format', 'json'])
      expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: '' })
      const out = JSON.parse(r.out) as { historyRows: number; historyBytes: number }
      expect(out.historyRows).toBe(20_000)
      const after = statSync(dbFile).size
      expect(after).toBeLessThan(before / 2)
      expect(out.historyBytes).toBe(before - after)

      // Nothing left to drop: nothing to free.
      const again = await vx(['cache', 'clean', '--older-than', '30d'])
      expect(again).toEqual({ code: 0, out: '› vx cache clean  nothing to free\n', err: '' })
    },
    TIMEOUT,
  )
})
