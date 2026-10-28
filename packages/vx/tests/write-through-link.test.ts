// A generated file is never written through a symlink the repo carries: a
// committed `vx.config.ts -> /outside/x` made `vx init` create /outside/x.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'bun:test'
import { applyMigration, type MigrationPlan } from '../src/workspace/index.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const CONFIG = `export default { tasks: { build: { exec: { command: 'true' } } } }\n`

let root: string
let outside: string
let victim: string
beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'vx-link-write-')))
  outside = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'vx-link-outside-')))
  victim = path.join(outside, 'x')
  expect(Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root }).exitCode).toBe(0)
})
afterEach(async () => {
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
})

function vx(...args: string[]): { code: number; err: string } {
  const p = Bun.spawnSync({
    cmd: [process.execPath, BIN, ...args],
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return { code: p.exitCode, err: p.stderr.toString() }
}

const refused = (at: string): string =>
  `refusing to write ${at}: it is a symlink to ${victim}; remove the link and run again`

it('vx init refuses a dangling vx.config.ts link and writes nothing', () => {
  symlinkSync(victim, path.join(root, 'vx.config.ts'))
  const r = vx('init')
  expect([r.code, existsSync(victim)]).toEqual([1, false])
  expect(r.err).toContain(refused(path.join(root, 'vx.config.ts')))
  // Refused before any write: no half-made workspace.
  expect(existsSync(path.join(root, '.vx', 'workspace.ts'))).toBe(false)
})

it('vx init refuses a dangling .vx/.gitignore link', () => {
  mkdirSync(path.join(root, '.vx'))
  symlinkSync(victim, path.join(root, '.vx', '.gitignore'))
  const r = vx('init')
  expect([r.code, existsSync(victim)]).toEqual([1, false])
  expect(r.err).toContain(refused(path.join(root, '.vx', '.gitignore')))
})

it('vx init --force leaves the file a link points at as it was', () => {
  writeFileSync(victim, 'mine\n')
  symlinkSync(victim, path.join(root, 'vx.config.ts'))
  const r = vx('init', '--force')
  expect([r.code, readFileSync(victim, 'utf8')]).toEqual([1, 'mine\n'])
  expect(r.err).toContain(refused(path.join(root, 'vx.config.ts')))
})

const migrate = (force: boolean) => {
  const plan: MigrationPlan = {
    headerNotes: [],
    projects: [{ name: 'a', dir: path.join(root, 'packages', 'a'), importLines: [], tasks: [] }],
    extraFiles: [],
    notes: [],
  }
  return applyMigration({
    root,
    metas: [],
    plan,
    source: 'turbo.json',
    verb: 'vx-migrate',
    dry: false,
    force,
  })
}

for (const [what, existing] of [
  ['a dangling', false],
  ['an existing', true],
] as const) {
  it(`a migration refuses a config that is a link to ${what} file`, async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    if (existing) writeFileSync(victim, 'mine\n')
    mkdirSync(path.join(root, 'packages', 'a'), { recursive: true })
    const at = path.join(root, 'packages', 'a', 'vx.config.ts')
    symlinkSync(victim, at)
    // --force: an existing file's own conflict check would refuse first.
    await expect(migrate(existing)).rejects.toThrow(refused(at))
    expect(existing ? readFileSync(victim, 'utf8') : existsSync(victim)).toEqual(
      existing ? 'mine\n' : false,
    )
    expect(existsSync(path.join(root, '.vx', 'workspace.ts'))).toBe(false)
  })
}

for (const [what, existing] of [
  ['a dangling', false],
  ['an existing', true],
] as const) {
  it(`vx lock refuses a review copy that is a link to ${what} file`, () => {
    mkdirSync(path.join(root, '.vx'))
    writeFileSync(path.join(root, '.vx', 'workspace.mjs'), 'export default { plugins: [] }\n')
    writeFileSync(path.join(root, 'vx.config.mjs'), CONFIG)
    if (existing) writeFileSync(victim, 'mine\n')
    const at = path.join(root, 'vx.lock.json')
    symlinkSync(victim, at)
    const r = vx('lock')
    expect(r.code).toBe(1)
    expect(r.err).toContain(refused(at))
    expect(existing ? readFileSync(victim, 'utf8') : existsSync(victim)).toEqual(
      existing ? 'mine\n' : false,
    )
  })
}
