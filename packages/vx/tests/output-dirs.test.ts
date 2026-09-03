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
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Cache, OUTPUT_DIRS_CAP } from '../src/cache/index.js'
import { run } from '../src/orchestrator/index.js'
import { defaultLogger } from '../src/orchestrator/logger.js'
import { wholeSubtreePrefixes } from '../src/util/index.js'
import { localWorkspaceSource } from './helpers/local-workspace.js'

describe('wholeSubtreePrefixes (eligibility)', () => {
  it('accepts only `<dir>/**` globs with a plain, non-root, non-escaping dir', () => {
    expect(wholeSubtreePrefixes(['dist/**'])).toEqual(['dist'])
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
    ]) {
      expect(wholeSubtreePrefixes(bad)).toBeNull()
    }
    expect(wholeSubtreePrefixes([])).toBeNull()
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
  })
  afterEach(() => {
    cache.close()
    rmSync(root, { recursive: true, force: true })
  })
  const rows = () => cache.loadOutputDirsBatch(['h1']).get('h1') ?? []

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

  it('does not descend a symlinked directory, and records nothing over the cap or for a missing prefix', async () => {
    mkdirSync(path.join(root, 'elsewhere/x'), { recursive: true })
    symlinkSync(path.join(root, 'elsewhere'), path.join(proj, 'dist/link'))
    await cache.recordOutputDirs('h1', proj, ['dist'])
    expect(rows().map((r) => r.path)).not.toContain('dist/link')
    expect(rows().map((r) => r.path)).not.toContain('dist/link/x')
    await cache.recordOutputDirs('h1', proj, ['nope'])
    expect(rows()).toEqual([])
    for (let i = 0; i < OUTPUT_DIRS_CAP + 1; i++) mkdirSync(path.join(proj, 'dist', `d${i}`))
    await cache.recordOutputDirs('h1', proj, ['dist'])
    expect(rows()).toEqual([])
    expect(await cache.outputDirsCurrent(proj, [])).toBe(false) // no rows ⇒ never a skip
  })

  it('a forged directory mtime is the accepted trade (documented, like touch -r on a file)', async () => {
    await cache.recordOutputDirs('h1', proj, ['dist'])
    const recorded = rows().find((r) => r.path === 'dist')!
    await Bun.sleep(5)
    w('dist/stray.js')
    utimesSync(path.join(proj, 'dist'), new Date(recorded.mtimeMs), new Date(recorded.mtimeMs))
    expect(await cache.outputDirsCurrent(proj, rows())).toBe(true) // the stray is invisible
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

  it('the miss records the directories; a warm hit is current; an added stray still forces the restore', async () => {
    expect((await runBuild()).ok).toBe(true)
    const c = db()
    const hash = (
      c.dbHandle().query("SELECT hash FROM entries WHERE task = 'build'").get() as { hash: string }
    ).hash
    const recorded = c.loadOutputDirsBatch([hash]).get(hash) ?? []
    c.close()
    expect(recorded.map((r) => r.path).sort()).toEqual(['dist', 'dist/sub'])

    expect((await runBuild()).ok).toBe(true) // warm hit, tree current
    await Bun.sleep(5)
    writeFileSync(path.join(dist(), 'stray.js'), 'stale')
    expect((await runBuild()).ok).toBe(true)
    // Strict ownership: the hit re-restored the declared outputs, so the
    // stray that the directory mtime exposed is gone.
    expect(existsSync(path.join(dist(), 'stray.js'))).toBe(false)
    expect(existsSync(path.join(dist(), 'sub/in.js'))).toBe(true)
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
