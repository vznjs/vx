// A store `vx run` will not use (another user's after one `sudo vx run`, a
// `~/.vx` others can write) leaves the entries in `.vx/cache`, silently.
// Only the run's open decided that: `vx info` and a dry prune read the
// refused store, so info counted entries no run used (or died on EACCES)
// and the dry prune named another set than the real one took; a clear with
// no bound removed `.vx/cache`, then failed on the store.
//
// Root bypasses the permission bits, so as root each vx drops the
// capabilities that bypass them (`setpriv`); without `setpriv` root skips.

import { chmodSync, existsSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { skipAsRoot } from './helpers/nonroot-gate.js'
import { addProject, makeWorkspace } from './helpers/workspace.js'

const BIN = path.join(import.meta.dir, 'helpers', 'vx-locked.ts')
const SIZE = path.join(import.meta.dir, '..', 'src', 'util', 'size.ts')
const ROOT = process.getuid?.() === 0
const CAPS = '-dac_override,-dac_read_search,-fowner'
const SETPRIV = ROOT ? Bun.which('setpriv') : null
const DROP = SETPRIV === null ? [] : [SETPRIV, `--bounding-set=${CAPS}`, `--inh-caps=${CAPS}`, '--']
// Root in a sandbox (a shard's bwrap) may not drop its own capabilities.
const dropped = DROP.length > 0 && Bun.spawnSync([...DROP, 'true']).exitCode === 0
const skip =
  process.platform === 'win32' || (ROOT && !dropped && skipAsRoot('a store this user cannot use'))
const TIMEOUT = 60_000

let home = ''
let root = ''
let app = ''
let locked: string[] = []

async function vx(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn([...DROP, process.execPath, BIN, ...args], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, NO_COLOR: '1', HOME: home, VX_CACHE_DIR: '', CI: '' },
  })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, out, err }
}

async function build(input: string): Promise<void> {
  await writeFile(path.join(app, 'src/i.txt'), input)
  const r = await vx(['run', 'build', '--all'])
  expect(`${r.code}\n${r.err}`).toBe('0\n')
}

/** The store under the home: `~/.vx/<id>/cache`. */
function store(): string {
  const [id] = readdirSync(path.join(home, '.vx'))
  return path.join(home, '.vx', id!, 'cache')
}

function lock(dir: string, mode: number): void {
  chmodSync(dir, mode)
  locked.push(dir)
}

beforeEach(async () => {
  home = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'vx-foreign-home-')))
  root = realpathSync(await makeWorkspace({ prefix: 'vx-foreign-store-', git: 'commit' }))
  app = await addProject(root, 'app', {
    config: `export default { tasks: { build: {
      exec: { command: 'mkdir -p dist && cat src/i.txt > dist/out.txt' },
      inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] }, cache: true,
    } } }\n`,
    files: { 'src/i.txt': 'x\n', '.gitignore': 'dist/\n' },
  })
})

afterEach(async () => {
  for (const d of locked.splice(0)) chmodSync(d, 0o700)
  await rm(root, { recursive: true, force: true })
  await rm(home, { recursive: true, force: true })
})

describe('a store vx run will not use', () => {
  it.skipIf(skip)(
    'with ~/.vx others can write, info and a dry prune read the entries runs use',
    async () => {
      await build('a\n')
      await build('b\n')
      // Two entries in the store; the run below refuses it and saves one in
      // `.vx/cache`.
      lock(path.join(home, '.vx'), 0o777)
      await build('c\n')
      const fallback = path.join(root, '.vx', 'cache')
      expect(existsSync(path.join(fallback, 'store.db'))).toBe(true)

      const info = await vx(['info', '--format', 'json'])
      const facts = JSON.parse(info.out) as { cacheStore: string; cacheEntries: number }
      expect([info.code, facts.cacheStore, facts.cacheEntries]).toEqual([0, fallback, 1])

      const dry = await vx(['cache', 'clean', '--max-size', '1B', '--dry', '--format', 'json'])
      const wet = await vx(['cache', 'clean', '--max-size', '1B', '--format', 'json'])
      expect([dry.code, dry.out, dry.err]).toEqual([
        0,
        wet.out.replace('"dry":false', '"dry":true'),
        '',
      ])
      expect(JSON.parse(wet.out)).toMatchObject({ evicted: 1 })
    },
    TIMEOUT,
  )

  it.skipIf(skip)(
    'with a store this user cannot read, info reports the workspace entries',
    async () => {
      await build('a\n')
      await build('b\n')
      lock(store(), 0o000)
      await build('c\n')
      const info = await vx(['info', '--format', 'json'])
      expect([info.code, info.err]).toEqual([0, ''])
      const facts = JSON.parse(info.out) as { cacheStore: string; cacheEntries: number }
      expect([facts.cacheStore, facts.cacheEntries]).toEqual([path.join(root, '.vx', 'cache'), 1])
    },
    TIMEOUT,
  )

  it.skipIf(skip)(
    'a clear leaves a store it cannot remove, and says so',
    async () => {
      await build('a\n')
      const s = store()
      lock(s, 0o000)
      await build('b\n')
      const note = `! vx  cache store ${s} left as is: this user cannot remove it (EACCES)\n`
      const dry = await vx(['cache', 'clean', '--dry', '--format', 'json'])
      expect([dry.code, JSON.parse(dry.out).cleared, dry.err]).toEqual([0, ['.vx/cache'], note])
      const wet = await vx(['cache', 'clean', '--format', 'json'])
      expect([wet.code, JSON.parse(wet.out).cleared, wet.err]).toEqual([0, ['.vx/cache'], note])
      expect([existsSync(path.join(root, '.vx', 'cache')), existsSync(s)]).toEqual([false, true])
    },
    TIMEOUT,
  )

  it.skipIf(skip)(
    'a clear refuses a cache directory it cannot remove before deleting anything',
    async () => {
      await build('a\n')
      const s = store()
      const own = path.join(root, '.vx', 'cache')
      lock(own, 0o500)
      const wet = await vx(['cache', 'clean'])
      expect([wet.code, wet.out, existsSync(path.join(s, 'store.db'))]).toEqual([1, '', true])
      expect(wet.err).toContain(
        `cache directory ${own} cannot be removed by this user (EACCES); nothing was deleted`,
      )
    },
    TIMEOUT,
  )

  it.skipIf(skip)('treeBytes counts a directory this user cannot list as 0', async () => {
    const dir = path.join(home, 'tree')
    mkdirSync(path.join(dir, 'shut'), { recursive: true })
    writeFileSync(path.join(dir, 'a'), '12345')
    writeFileSync(path.join(dir, 'shut', 'b'), '678')
    lock(path.join(dir, 'shut'), 0o000)
    const p = Bun.spawnSync([
      ...DROP,
      process.execPath,
      '-e',
      `import { treeBytes } from ${JSON.stringify(SIZE)}; console.log(treeBytes(${JSON.stringify(dir)}))`,
    ])
    expect(`${p.exitCode} ${p.stdout.toString().trim()}`).toBe('0 5')
  })
})
