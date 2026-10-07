// The directory-mtime short-circuit behind a warm hit. `isOutputsCurrent`
// stats the recorded FILES; the glob walk existed to prove the output SET
// (no strays, nothing missing) and cost 0.36 ms per hit — 365 ms of CPU on
// a warm 1000-project run. For whole-subtree globs (`dist/**`) every
// directory under the prefix is recorded after a save or restore; while all
// of them keep their mtime, no file was added or removed anywhere the glob
// could see, so the walk is skipped and only the per-file check runs.
//
// Stale-hit-critical, so both directions are pinned here: the skip is taken
// only when it is sound, and every way the set can change still forces the
// walk (and therefore the restore).

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Cache, OUTPUT_DIRS_CAP, OUTPUT_DIRS_RACY_MS } from '../src/cache/index.js'
import { run } from '../src/orchestrator/index.js'
import { defaultLogger } from '../src/orchestrator/logger.js'
import { wholeSubtreePrefixes } from '../src/util/index.js'
import { localWorkspaceSource } from './helpers/local-workspace.js'

describe('wholeSubtreePrefixes (eligibility)', () => {
  it('accepts only `<dir>/**` globs with a plain, non-root, non-escaping dir', () => {
    expect(wholeSubtreePrefixes(['dist/**'])).toEqual(['dist'])
    // the spellings normalizeGlob folds: the short-circuit must not lose them
    expect(wholeSubtreePrefixes(['./dist/**', 'build//out/**'])).toEqual(['dist', 'build/out'])
    // a route directory is a plain dir (item 667), in either spelling
    expect(wholeSubtreePrefixes(['app/[id]/**', 'app/\\[x\\]/**'])).toEqual(['app/[id]', 'app/[x]'])
    expect(wholeSubtreePrefixes(['dist/**', 'build/out/**', 'dist/**'])).toEqual([
      'dist',
      'build/out',
    ])
    for (const bad of [
      ['**/*.js'],
      ['dist/**/*.js'],
      ['dist/*'],
      ['./**'],
      ['../dist/**'],
      ['/abs/**'],
      ['dist/**', '**'],
      // A brace set or a negation in the prefix is no directory (E-18's
      // sweep widened the prefix alphabet with the suite green).
      ['{dist,build}/**'],
      ['dist/{a,b}/**'],
      ['!dist/**'],
    ]) {
      expect(wholeSubtreePrefixes(bad)).toBeNull()
    }
    expect(wholeSubtreePrefixes([])).toBeNull()
  })

  it('accepts a bare literal as the tree it may name (Next 27)', () => {
    // `asTrees` reads `dist` as the path or the tree under it; a literal
    // that names a file is refused by the snapshot itself (rows below).
    expect(wholeSubtreePrefixes(['dist'])).toEqual(['dist'])
    expect(wholeSubtreePrefixes(['dist/', './out', 'dist/**'])).toEqual(['dist', 'out'])
    expect(wholeSubtreePrefixes(['dist/**', 'coverage/lcov.info'])).toEqual([
      'dist',
      'coverage/lcov.info',
    ])
    for (const bad of [['!dist'], ['..'], ['../dist'], ['/abs'], ['.'], ['dist', 'src/*.js']]) {
      expect(wholeSubtreePrefixes(bad)).toBeNull()
    }
  })
})

describe('Cache.recordOutputDirs / outputDirsCurrent', () => {
  let root: string
  let cache: Cache
  let proj: string
  const w = (rel: string, body = 'x') => {
    const abs = path.join(proj, rel)
    mkdirSync(path.dirname(abs), { recursive: true })
    writeFileSync(abs, body)
  }
  // Every directory the fixture (or a test) just touched carries an mtime of
  // NOW, and the racy-window guard refuses a snapshot that holds one — so a
  // record taken right after a write is dropped whatever else the test is
  // about. Sleeping past the window made that a claim about how fast the
  // test runs; stamping the tree old is the same claim proven. Symlinked
  // directories are left alone: the walk does not descend them.
  const age = (): void => {
    // Never on a whole second: that stamp reads as a file system keeping
    // whole seconds, whose window is a second wider (A-2).
    const t = Date.now() - 10 * OUTPUT_DIRS_RACY_MS
    const old = new Date(t % 1000 === 0 ? t - 1 : t)
    const walk = (dir: string): void => {
      utimesSync(dir, old, old)
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory() && !e.isSymbolicLink()) walk(path.join(dir, e.name))
      }
    }
    walk(proj)
  }
  beforeEach(async () => {
    root = mkdtempSync(path.join(os.tmpdir(), 'vx-outdirs-'))
    cache = new Cache(path.join(root, 'cache'))
    proj = path.join(root, 'proj')
    w('dist/a.js')
    w('dist/sub/b.js')
    w('dist/sub/deep/c.js')
    w('src/index.ts')
    // an entry row for the FK
    await cache.save({
      hash: 'h1',
      projectDir: proj,
      outputFiles: [path.join(proj, 'dist/a.js')],
      entry: { taskId: 'p#build', command: 'x', durationMs: 1, stdout: '' },
    })
    age()
  })
  afterEach(() => {
    cache.close()
    rmSync(root, { recursive: true, force: true })
  })
  const rows = () => cache.loadOutputDirsBatch(['h1']).get('h1') ?? []

  // A sweep of output-index.ts (A-27): ctime moves on every write, so on a
  // real file it masks the other fields of the skip-restore proof; each is
  // held by a planted row that matches in all but that one field.
  it('isOutputsCurrent trusts a row only when every field agrees', async () => {
    const file = path.join(proj, 'dist/a.js')
    const st = statSync(file)
    const row = {
      path: 'dist/a.js',
      size: st.size,
      mode: st.mode,
      mtimeMs: st.mtimeMs,
      ino: Number(st.ino),
      ctimeMs: Math.floor(st.ctimeMs),
    }
    expect(await cache.isOutputsCurrent(proj, [row])).toBe(true)
    for (const off of [
      { size: row.size + 1 },
      { mode: row.mode ^ 0o100 },
      { mtimeMs: row.mtimeMs + 5 },
      { ino: row.ino + 1 },
    ]) {
      expect(await cache.isOutputsCurrent(proj, [{ ...row, ...off }])).toBe(false)
    }
  })

  it('a stamp is taken only for a file that still matches its row', async () => {
    // Through the batch read, which overlays the pending stamps.
    const stamped = () => ({ ino: cache.loadOutputFilesBatch(['h1']).get('h1')![0]!.ino ?? null })
    w('dist/a.js', 'changed and longer')
    cache.recordOutputStamps('h1', proj, root)
    expect(stamped().ino).toBeNull()
    // CONTROL: the saved bytes back, same size and mtime as the row: stamped.
    w('dist/a.js', 'x')
    const r = cache.loadOutputFilesBatch(['h1']).get('h1')![0]!
    utimesSync(path.join(proj, 'dist/a.js'), new Date(r.mtimeMs), new Date(r.mtimeMs))
    cache.recordOutputStamps('h1', proj, root)
    expect(stamped().ino).not.toBeNull()
  })

  it('a re-save drops the stamp taken for the rows it replaces', async () => {
    const stamped = () => cache.loadOutputFilesBatch(['h1']).get('h1')![0]!.ino ?? null
    const save = () =>
      cache.save({
        hash: 'h1',
        projectDir: proj,
        outputFiles: [path.join(proj, 'dist/a.js')],
        entry: { taskId: 'p#build', command: 'x', durationMs: 1, stdout: '' },
      })
    // CONTROL: the file as saved is stamped, and the stamp is read pending.
    cache.recordOutputStamps('h1', proj, root)
    expect(stamped()).not.toBeNull()
    await save()
    expect(stamped()).toBeNull()
    // Nor does it land at close.
    cache.close()
    cache = new Cache(path.join(root, 'cache'))
    expect(stamped()).toBeNull()
  })

  it('a prefix recorded as a file is current while a regular file stands there', async () => {
    const row = [{ path: 'dist/a.js', mtimeMs: -2 }]
    expect(await cache.outputDirsCurrent(proj, row)).toBe(true)
    rmSync(path.join(proj, 'dist/a.js'))
    expect(await cache.outputDirsCurrent(proj, row)).toBe(false)
    symlinkSync(path.join(proj, 'dist/sub/b.js'), path.join(proj, 'dist/a.js'))
    expect(await cache.outputDirsCurrent(proj, row)).toBe(false)
    rmSync(path.join(proj, 'dist/a.js'))
    mkdirSync(path.join(proj, 'dist/a.js'))
    expect(await cache.outputDirsCurrent(proj, row)).toBe(false)
  })

  it('a directory recorded absent that now exists is not current', async () => {
    expect(await cache.outputDirsCurrent(proj, [{ path: 'gone', mtimeMs: -1 }])).toBe(true)
    mkdirSync(path.join(proj, 'gone'))
    expect(await cache.outputDirsCurrent(proj, [{ path: 'gone', mtimeMs: -1 }])).toBe(false)
  })

  it('the walk does not descend a symlinked directory', async () => {
    mkdirSync(path.join(root, 'elsewhere', 'inner'), { recursive: true })
    symlinkSync(path.join(root, 'elsewhere'), path.join(proj, 'dist/link'))
    age()
    await cache.recordOutputDirs('h1', proj, ['dist'])
    expect(
      rows()
        .map((r) => r.path)
        .sort(),
    ).toEqual(['dist', 'dist/sub', 'dist/sub/deep'])
  })

  it('records every directory under the prefix and reports current while nothing moves', async () => {
    await cache.recordOutputDirs('h1', proj, ['dist'])
    expect(
      rows()
        .map((r) => r.path)
        .sort(),
    ).toEqual(['dist', 'dist/sub', 'dist/sub/deep'])
    expect(await cache.outputDirsCurrent(proj, rows())).toBe(true)
    // An in-place EDIT does not move any directory: the set is unchanged
    // (the per-file check is what catches content).
    await Bun.sleep(5)
    w('dist/sub/b.js', 'edited')
    expect(await cache.outputDirsCurrent(proj, rows())).toBe(true)
  })

  it.each([
    ['a file added at the top', () => w('dist/new.js')],
    ['a file added in a nested directory', () => w('dist/sub/deep/new.js')],
    ['a new directory', () => mkdirSync(path.join(proj, 'dist/sub/fresh'))],
    ['a file removed', () => rmSync(path.join(proj, 'dist/sub/b.js'))],
    ['a directory removed', () => rmSync(path.join(proj, 'dist/sub/deep'), { recursive: true })],
    ['the prefix removed', () => rmSync(path.join(proj, 'dist'), { recursive: true })],
  ])('is no longer current after %s', async (_label, change) => {
    await cache.recordOutputDirs('h1', proj, ['dist'])
    await Bun.sleep(5) // a distinct millisecond for the directory mtime
    change()
    expect(await cache.outputDirsCurrent(proj, rows())).toBe(false)
  })

  it('a change OUTSIDE the prefix is invisible, as it is to the glob', async () => {
    await cache.recordOutputDirs('h1', proj, ['dist'])
    await Bun.sleep(5)
    w('src/other.ts')
    expect(await cache.outputDirsCurrent(proj, rows())).toBe(true)
  })

  it('does not descend a symlinked directory, records a missing prefix as absent, and nothing over the cap', async () => {
    mkdirSync(path.join(root, 'elsewhere/x'), { recursive: true })
    symlinkSync(path.join(root, 'elsewhere'), path.join(proj, 'dist/link'))
    // The symlink bumped dist/ into the racy window: without this the
    // snapshot is refused and every assertion below reads an EMPTY set —
    // `not.toContain` passed on nothing until 2026-09-19. `toContain` next
    // is the control that says the walk ran at all.
    age()
    await cache.recordOutputDirs('h1', proj, ['dist'])
    expect(rows().map((r) => r.path)).toContain('dist/sub')
    expect(rows().map((r) => r.path)).not.toContain('dist/link')
    expect(rows().map((r) => r.path)).not.toContain('dist/link/x')
    // A declared prefix the task never produced is recorded ABSENT (mtime
    // -1) rather than refusing the snapshot: current while it stays
    // absent, stale the moment something creates it.
    await cache.recordOutputDirs('h1', proj, ['nope'])
    expect(rows()).toEqual([{ path: 'nope', mtimeMs: -1 }])
    expect(await cache.outputDirsCurrent(proj, rows())).toBe(true)
    mkdirSync(path.join(proj, 'nope'))
    expect(await cache.outputDirsCurrent(proj, rows())).toBe(false)
    rmSync(path.join(proj, 'nope'), { recursive: true })
    for (let i = 0; i < OUTPUT_DIRS_CAP + 1; i++) mkdirSync(path.join(proj, 'dist', `d${i}`))
    age() // the cap is the reason these rows are dropped, not the window
    await cache.recordOutputDirs('h1', proj, ['dist'])
    expect(rows()).toEqual([])
    expect(await cache.outputDirsCurrent(proj, [])).toBe(false) // no rows ⇒ never a skip
    // Removed here, under this row's bound: left to the afterEach (bun's
    // 5 s default), the rm of 8,193 directories timed it out on a loaded
    // box (11.3 s for the row and its hooks, M-19).
    rmSync(path.join(proj, 'dist'), { recursive: true })
    // 8,193 mkdirs, the walk over them and their removal are real work:
    // 7.7 s on a loaded CI runner under four parallel shards (2026-09-16),
    // over bun's 5 s default. The bound matches the work and still catches
    // a hang.
  }, 30_000)

  it('a directory modified within the racy window is not snapshotted at all (coarse timestamps)', async () => {
    w('dist/fresh/x.js')
    // The guard compares the recorded mtimes against the clock INSIDE
    // recordOutputDirs, so `write, then record` only lands inside the window
    // while the test beats it there: a loaded macOS runner took longer than
    // the 50 ms and the fixture was snapshotted after all (CI, 2026-09-19).
    // Stamping the mtimes says what the write was standing in for.
    //
    // A stamp at the window's far edge is still a race — it buys 2× the
    // window (100 ms) between this line and that clock read, and a macOS
    // runner under three shards spent longer than that again (CI,
    // 2026-09-21, this row alone took 240 ms). So stamp far past the edge,
    // the mirror of `age()`'s 10× on the old side: at 20× no achievable
    // scheduling delay ages the fixture out of the window.
    //
    // What that trades, said plainly: this row pins the ARM (a directory
    // whose mtime is not safely in the PAST is dropped, and all of them
    // with it), not the window's WIDTH. The width is measured against a
    // clock `recordOutputDirs` reads itself, so no fixture can pin it
    // without holding that clock still — and the version that tried was
    // this flake.
    const fresh = new Date(Date.now() + 20 * OUTPUT_DIRS_RACY_MS)
    for (const rel of ['dist', 'dist/fresh']) utimesSync(path.join(proj, rel), fresh, fresh)
    await cache.recordOutputDirs('h1', proj, ['dist'])
    expect(rows()).toEqual([]) // all or nothing: dist/sub is dropped with them
    age()
    await cache.recordOutputDirs('h1', proj, ['dist'])
    expect(rows().map((r) => r.path)).toContain('dist/fresh')
  })

  it('a forged directory mtime is the accepted trade (documented, like touch -r on a file)', async () => {
    await cache.recordOutputDirs('h1', proj, ['dist'])
    const recorded = rows().find((r) => r.path === 'dist')!
    await Bun.sleep(5)
    w('dist/stray.js')
    utimesSync(path.join(proj, 'dist'), new Date(recorded.mtimeMs), new Date(recorded.mtimeMs))
    expect(await cache.outputDirsCurrent(proj, rows())).toBe(true) // the stray is invisible
  })

  it('a recorded directory replaced by a file is not current, even with every mtime forged', async () => {
    await cache.recordOutputDirs('h1', proj, ['dist'])
    const at = (rel: string) => rows().find((r) => r.path === rel)!.mtimeMs
    const deep = at('dist/sub/deep')
    const sub = at('dist/sub')
    rmSync(path.join(proj, 'dist/sub/deep'), { recursive: true })
    writeFileSync(path.join(proj, 'dist/sub/deep'), 'not a directory')
    utimesSync(path.join(proj, 'dist/sub/deep'), new Date(deep), new Date(deep))
    utimesSync(path.join(proj, 'dist/sub'), new Date(sub), new Date(sub))
    expect(await cache.outputDirsCurrent(proj, rows())).toBe(false)
  })

  it("a flushed snapshot is not written again over another process's newer one", async () => {
    // Two handles on one cache: this process flushed its snapshot; another
    // then snapshotted the changed tree. A later flush here (any read) must
    // not put the old rows back.
    await cache.recordOutputDirs('h1', proj, ['dist'])
    expect(rows().map((r) => r.path)).not.toContain('dist/fresh')
    mkdirSync(path.join(proj, 'dist/fresh'))
    age()
    const other = new Cache(path.join(root, 'cache'))
    await other.recordOutputDirs('h1', proj, ['dist'])
    other.close()
    rows()
    // A third handle reads what is stored, with no snapshot of its own to add.
    const reader = new Cache(path.join(root, 'cache'))
    try {
      expect(
        (reader.loadOutputDirsBatch(['h1']).get('h1') ?? []).map((r) => r.path).sort(),
      ).toEqual(['dist', 'dist/fresh', 'dist/sub', 'dist/sub/deep'])
    } finally {
      reader.close()
    }
  })

  it("a re-save replaces the entry's file rows rather than adding to them", async () => {
    await cache.save({
      hash: 'h1',
      projectDir: proj,
      outputFiles: [path.join(proj, 'dist/sub/b.js')],
      entry: { taskId: 'p#build', command: 'x', durationMs: 1, stdout: '' },
    })
    expect(
      cache
        .loadOutputFilesBatch(['h1'])
        .get('h1')
        ?.map((r) => r.path),
    ).toEqual(['dist/sub/b.js'])
  })

  it('a file row is current only while the file is there with its recorded size', async () => {
    // Stamped as the miss path does after a save (item 886).
    cache.recordOutputStamps('h1', proj, proj)
    const files = cache.loadOutputFilesBatch(['h1']).get('h1')!
    expect(await cache.isOutputsCurrent(proj, files)).toBe(true)
    // A different size under a forged identical mtime is not current (the
    // size and, since item 886, the rewrite's ctime both tell).
    const a = path.join(proj, 'dist/a.js')
    writeFileSync(a, 'longer than before')
    utimesSync(a, new Date(files[0]!.mtimeMs), new Date(files[0]!.mtimeMs))
    expect(await cache.isOutputsCurrent(proj, files)).toBe(false)
    rmSync(a)
    expect(await cache.isOutputsCurrent(proj, files)).toBe(false)
  })
  it('snapshots land together: pending until a read, a prune, a stat or close, then one transaction', async () => {
    // A snapshot is read by the NEXT run's hit check, never by the task
    // that took it, so nothing is written per task (a commit each was the
    // whole run-end stage at 1,000 projects, item 622). The batch loader
    // flushes first, so a same-process reader still sees every snapshot.
    await mkdir(path.join(proj, 'dist', 'a'), { recursive: true })
    await mkdir(path.join(proj, 'dist', 'b'), { recursive: true })
    await Bun.sleep(OUTPUT_DIRS_RACY_MS + 5)
    // The rows reference their entries; `h1` is the fixture's, `h2` a second.
    await cache.save({
      hash: 'h2',
      projectDir: proj,
      outputFiles: [path.join(proj, 'dist/a.js')],
      entry: { taskId: 'p#build', command: 'y', durationMs: 1, stdout: '' },
    })
    await cache.recordOutputDirs('h1', proj, ['dist'])
    await cache.recordOutputDirs('h2', proj, ['dist/a'])
    const count = () =>
      (cache.dbHandle().query('SELECT COUNT(*) AS n FROM output_dirs').get() as { n: number }).n
    expect(count()).toBe(0)
    expect((cache.loadOutputDirsBatch(['h1']).get('h1') ?? []).map((r) => r.path).sort()).toEqual([
      'dist',
      'dist/a',
      'dist/b',
      'dist/sub',
      'dist/sub/deep',
    ])
    // Both landed in that one flush, the second snapshot included.
    expect(count()).toBe(6)
    // A later snapshot for the same hash replaces the rows, again deferred.
    await cache.recordOutputDirs('h1', proj, ['dist/b'])
    expect(count()).toBe(6)
    expect((cache.loadOutputDirsBatch(['h1']).get('h1') ?? []).map((r) => r.path)).toEqual([
      'dist/b',
    ])
    expect(count()).toBe(2)
    // A snapshot whose entry another process pruned meanwhile lands as
    // nothing, and does not fail the flush for the rest.
    await cache.recordOutputDirs('h2', proj, ['dist/a'])
    cache.dbHandle().query('DELETE FROM entries WHERE hash = ?').run('h2')
    expect(cache.loadOutputDirsBatch(['h1', 'h2']).get('h1')?.length).toBe(1)
    expect(count()).toBe(1)
  })

  // The row above names four flush sites and drives one. The three below
  // each drive another, and each fails with its site's flush deleted
  // (item 628): a pending snapshot lives in the object, so a site that
  // does not land it loses it.
  it('a snapshot pending at close is what the next process reads (the vx watch cycle)', async () => {
    // Each `vx watch` cycle's run() closes its cache; the second cycle's
    // hit check reads rows the first wrote only because close lands them.
    await cache.recordOutputDirs('h1', proj, ['dist'])
    const dir = path.join(root, 'cache')
    cache.close()
    cache = new Cache(dir)
    expect(
      rows()
        .map((r) => r.path)
        .sort(),
    ).toEqual(['dist', 'dist/sub', 'dist/sub/deep'])
  })

  it('stats() lands a pending snapshot before it counts', async () => {
    await cache.recordOutputDirs('h1', proj, ['dist'])
    const count = () =>
      (cache.dbHandle().query('SELECT COUNT(*) AS n FROM output_dirs').get() as { n: number }).n
    expect(count()).toBe(0)
    cache.stats()
    expect(count()).toBe(3)
  })

  it("prune lands the kept entry's snapshot and leaves no rows for the evicted one", async () => {
    await cache.save({
      hash: 'h2',
      projectDir: proj,
      outputFiles: [path.join(proj, 'dist/a.js')],
      entry: { taskId: 'p#build', command: 'y', durationMs: 1, stdout: '' },
    })
    await cache.recordOutputDirs('h1', proj, ['dist'])
    await cache.recordOutputDirs('h2', proj, ['dist/sub'])
    // Evict h2 by age: its `accessed_at` is set back past the cutoff.
    cache.dbHandle().query('UPDATE entries SET accessed_at = 0 WHERE hash = ?').run('h2')
    const result = await cache.prune({ olderThanMs: 1 })
    expect(result.evicted).toBe(1)
    const all = cache
      .dbHandle()
      .query('SELECT entry_hash AS h, path FROM output_dirs ORDER BY h, path')
      .all() as Array<{ h: string; path: string }>
    // Held two ways: the flush before the delete lets the cascade take
    // h2's rows, and the flush's own entry check would drop them after
    // it. Either alone keeps the table free of orphans, so this row pins
    // the OUTCOME; the kept entry's rows are what the order alone holds.
    expect(all).toEqual([
      { h: 'h1', path: 'dist' },
      { h: 'h1', path: 'dist/sub' },
      { h: 'h1', path: 'dist/sub/deep' },
    ])
  })
})

describe('warm hits through run() with the short-circuit', () => {
  let root: string
  const log = defaultLogger({ enabled: false })
  const runBuild = () => run({ cwd: root, tasks: ['build'], log, handleSignals: false })
  const dist = () => path.join(root, 'packages/a/dist')
  const db = () => new Cache(path.join(root, '.vx/cache'))

  beforeEach(async () => {
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'vx-outdirs-run-')))
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'ws', private: true }))
    await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
    await writeFile(path.join(root, 'vx.workspace.mjs'), localWorkspaceSource())
    await mkdir(path.join(root, 'packages/a/src'), { recursive: true })
    await writeFile(path.join(root, 'packages/a/package.json'), JSON.stringify({ name: 'a' }))
    await writeFile(path.join(root, 'packages/a/src/index.js'), 'export const v = 1\n')
    await writeFile(
      path.join(root, 'packages/a/vx.config.mjs'),
      "export default { tasks: { build: { exec: { command: 'mkdir -p dist/sub && cp src/index.js dist/out.js && cp src/index.js dist/sub/in.js' }, cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] } } } } }\n",
    )
    Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root })
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('the first aged hit records the directories; an added stray still forces the restore', async () => {
    expect((await runBuild()).ok).toBe(true) // the miss
    const recordedDirs = () => {
      const c = db()
      const hash = (
        c.dbHandle().query("SELECT hash FROM entries WHERE task = 'build'").get() as {
          hash: string
        }
      ).hash
      const recorded = (c.loadOutputDirsBatch([hash]).get(hash) ?? []).map((r) => r.path).sort()
      c.close()
      return recorded
    }
    // Whether the MISS recorded anything depends on how long its build and
    // save took against the racy window (a slow macOS runner exceeded it and
    // recorded; this box does not) — the racy rule is pinned deterministically
    // at the Cache level above, so only the aged hit is asserted here.
    await Bun.sleep(OUTPUT_DIRS_RACY_MS + 10)
    expect((await runBuild()).ok).toBe(true) // warm hit: the walk proves the tree, old enough to record
    expect(recordedDirs()).toEqual(['dist', 'dist/sub'])
    expect((await runBuild()).ok).toBe(true) // warm hit, directories trusted
    await Bun.sleep(5)
    writeFileSync(path.join(dist(), 'stray.js'), 'stale')
    expect((await runBuild()).ok).toBe(true)
    // Strict ownership: the hit re-restored the declared outputs, so the
    // stray that the directory mtime exposed is gone.
    expect(existsSync(path.join(dist(), 'stray.js'))).toBe(false)
    expect(existsSync(path.join(dist(), 'sub/in.js'))).toBe(true)
  })

  it('a restore records the directories at run end, once they are old enough', async () => {
    // The restore renames into its directories inside the racy window, so
    // a snapshot taken right after it was refused and the first warm run
    // after EVERY restore walked its output trees (payload: 41 of 45 tasks,
    // 14,430 files, 2026-09-11). Deferred to run end, like the miss path.
    // `b` is an uncached task that keeps the run open past the window, so
    // `a`'s restore has aged by the time the snapshot is taken.
    await mkdir(path.join(root, 'packages/b'), { recursive: true })
    await writeFile(path.join(root, 'packages/b/package.json'), JSON.stringify({ name: 'b' }))
    await writeFile(
      path.join(root, 'packages/b/vx.config.mjs'),
      `export default { tasks: { build: { exec: { command: 'sleep ${(OUTPUT_DIRS_RACY_MS * 3) / 1000}' } } } }\n`,
    )
    expect((await runBuild()).ok).toBe(true) // the miss
    const recordedDirs = () => {
      const c = db()
      const hash = (
        c.dbHandle().query("SELECT hash FROM entries WHERE task = 'build'").get() as {
          hash: string
        }
      ).hash
      const recorded = (c.loadOutputDirsBatch([hash]).get(hash) ?? []).map((r) => r.path).sort()
      c.close()
      return recorded
    }
    await rm(dist(), { recursive: true, force: true })
    const restored = await runBuild()
    expect(restored.ok).toBe(true)
    expect(restored.outcomes.find((o) => o.node.id === 'a#build')!.status).toBe('cache-hit')
    expect(existsSync(path.join(dist(), 'sub/in.js'))).toBe(true)
    expect(recordedDirs()).toEqual(['dist', 'dist/sub'])
  })

  // Item 1087: the snapshot is taken at run end, and a task after the save
  // wrote into the output tree before then. The walk recorded the tree
  // with the stray as the entry's, and every later hit trusted it.
  it('a stray written into the outputs before run end is not recorded as the entry', async () => {
    await writeFile(
      path.join(root, 'packages/a/vx.config.mjs'),
      `export default { tasks: {
        build: { exec: { command: 'mkdir -p dist/sub && cp src/index.js dist/out.js && cp src/index.js dist/sub/in.js' }, cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] } } },
        post: { dependsOn: ['build'], exec: { command: 'echo stray > dist/sub/stray.js && sleep ${(OUTPUT_DIRS_RACY_MS * 3) / 1000}' } },
      } }\n`,
    )
    const hashOf = () => {
      const c = db()
      const hash = (
        c.dbHandle().query("SELECT hash FROM entries WHERE task = 'build'").get() as {
          hash: string
        }
      ).hash
      const recorded = (c.loadOutputDirsBatch([hash]).get(hash) ?? []).map((r) => r.path)
      c.close()
      return recorded
    }
    expect((await run({ cwd: root, tasks: ['post'], log, handleSignals: false })).ok).toBe(true)
    expect(existsSync(path.join(dist(), 'sub/stray.js'))).toBe(true)
    expect(hashOf()).toEqual([])
    const again = await runBuild()
    expect(again.outcomes.find((o) => o.node.id === 'a#build')!.status).toBe('cache-hit')
    expect(existsSync(path.join(dist(), 'sub/in.js'))).toBe(true)
    expect(existsSync(path.join(dist(), 'sub/stray.js'))).toBe(false)
  })

  // A sweep of miss-save.ts (A-24): the snapshot's count check and the push
  // itself held no row. Removing the count let a walk that saw FEWER files
  // than the entry's rows vouch for the tree, so the next hit skipped the
  // restore and the deleted file stayed gone.
  const buildThen = (post: string) =>
    writeFile(
      path.join(root, 'packages/a/vx.config.mjs'),
      `export default { tasks: {
        build: { exec: { command: 'mkdir -p dist/sub && cp src/index.js dist/out.js && cp src/index.js dist/sub/in.js' }, cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] } } },
        post: { dependsOn: ['build'], exec: { command: '${post}sleep ${(OUTPUT_DIRS_RACY_MS * 3) / 1000}' } },
      } }\n`,
    )
  const recordedForBuild = () => {
    const c = db()
    const hash = (
      c.dbHandle().query("SELECT hash FROM entries WHERE task = 'build'").get() as { hash: string }
    ).hash
    const recorded = (c.loadOutputDirsBatch([hash]).get(hash) ?? []).map((r) => r.path).sort()
    c.close()
    return recorded
  }

  it('a run records the saved tree at run end', async () => {
    await buildThen('')
    expect((await run({ cwd: root, tasks: ['post'], log, handleSignals: false })).ok).toBe(true)
    expect(recordedForBuild()).toEqual(['dist', 'dist/sub'])
  })

  it('an entry file removed before run end is not vouched for; the next hit restores it', async () => {
    await buildThen('rm dist/sub/in.js && ')
    expect((await run({ cwd: root, tasks: ['post'], log, handleSignals: false })).ok).toBe(true)
    expect(existsSync(path.join(dist(), 'sub/in.js'))).toBe(false)
    expect(recordedForBuild()).toEqual([])
    const again = await runBuild()
    expect(again.outcomes.find((o) => o.node.id === 'a#build')!.status).toBe('cache-hit')
    expect(existsSync(path.join(dist(), 'sub/in.js'))).toBe(true)
  })

  // Next 27: nx() maps an extensionless output to `<dir>/**`, which saves
  // nothing under a FILE; the bare path saves either, and now keeps the
  // directory stats a `<dir>/**` glob gets.
  it('a bare literal directory output records its directories; a stray still forces the restore', async () => {
    await writeFile(
      path.join(root, 'packages/a/vx.config.mjs'),
      "export default { tasks: { build: { exec: { command: 'mkdir -p dist/sub && cp src/index.js dist/out.js && cp src/index.js dist/sub/in.js' }, cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist'] } } } } }\n",
    )
    expect((await runBuild()).ok).toBe(true)
    await Bun.sleep(OUTPUT_DIRS_RACY_MS + 10)
    expect((await runBuild()).ok).toBe(true)
    const c = db()
    const paths = (
      c.dbHandle().query('SELECT path FROM output_dirs ORDER BY path').all() as {
        path: string
      }[]
    ).map((r) => r.path)
    c.close()
    expect(paths).toEqual(['dist', 'dist/sub'])
    await Bun.sleep(5)
    writeFileSync(path.join(dist(), 'sub', 'stray.js'), 'stale')
    expect((await runBuild()).ok).toBe(true)
    expect(existsSync(path.join(dist(), 'sub/stray.js'))).toBe(false)
    expect(existsSync(path.join(dist(), 'sub/in.js'))).toBe(true)
  })

  it('a bare literal FILE output records the file, skips the walk, and is still restored when it changes (U-5)', async () => {
    await writeFile(
      path.join(root, 'packages/a/vx.config.mjs'),
      "export default { tasks: { build: { exec: { command: 'mkdir -p dist && cp src/index.js dist/tool' }, cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist/tool'] } } } } }\n",
    )
    const recorded = () => {
      const c = db()
      const r = c.dbHandle().query('SELECT path, mtime_ms FROM output_dirs').all()
      c.close()
      return r
    }
    expect((await runBuild()).ok).toBe(true)
    await Bun.sleep(OUTPUT_DIRS_RACY_MS + 10)
    expect((await runBuild()).ok).toBe(true)
    // Recorded as a file, so the next hit takes the stats and not the walk.
    expect(recorded()).toEqual([{ path: 'dist/tool', mtime_ms: -2 }])
    const tool = path.join(dist(), 'tool')
    writeFileSync(tool, 'tampered')
    expect((await runBuild()).ok).toBe(true)
    expect(readFileSync(tool, 'utf8')).toBe('export const v = 1\n')
    // A directory where the file was: the set changed, so it is restored.
    await Bun.sleep(OUTPUT_DIRS_RACY_MS + 10)
    expect((await runBuild()).ok).toBe(true)
    expect(recorded()).toEqual([{ path: 'dist/tool', mtime_ms: -2 }])
    rmSync(tool)
    mkdirSync(tool)
    writeFileSync(path.join(tool, 'stray.js'), 'stale')
    expect((await runBuild()).ok).toBe(true)
    expect(readFileSync(tool, 'utf8')).toBe('export const v = 1\n')
  })

  it('a root-anchored glob records nothing and keeps the walk (control)', async () => {
    await writeFile(
      path.join(root, 'packages/a/vx.config.mjs'),
      "export default { tasks: { build: { exec: { command: 'mkdir -p dist && cp src/index.js dist/out.js' }, cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**/*.js'] } } } } }\n",
    )
    expect((await runBuild()).ok).toBe(true)
    expect((await runBuild()).ok).toBe(true)
    const c = db()
    const n = (c.dbHandle().query('SELECT COUNT(*) AS n FROM output_dirs').get() as { n: number }).n
    c.close()
    expect(n).toBe(0)
    await Bun.sleep(5)
    writeFileSync(path.join(dist(), 'stray.js'), 'stale')
    expect((await runBuild()).ok).toBe(true)
    expect(existsSync(path.join(dist(), 'stray.js'))).toBe(false)
  })
})
