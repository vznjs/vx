// One rule marks a workspace root, for the root walk and for `vx lock`'s
// discovery alike: a `.vx/workspace.*` entry, whatever it is. A broken link
// or a directory by that name counted as a nested workspace in discovery
// while the walk climbed past it, so its projects were in no lock and a run
// inside said "not inside a project". Now the walk stops there too and
// refuses the entry by name.
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, expect, it } from 'bun:test'
import { findWorkspaceRoot } from '../src/workspace/workspace.js'
import { addProject, gitIn, makeWorkspace } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const CONFIG = `export default { tasks: { build: { exec: { command: 'true' } } } }\n`
const home = await mkdtemp(path.join(os.tmpdir(), 'vx-ws-broken-home-'))
const made: string[] = []

afterAll(async () => {
  await Promise.all([home, ...made].map((d) => rm(d, { recursive: true, force: true })))
})

const vx = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync({
    cmd: [process.execPath, BIN, ...args],
    cwd,
    env: { ...process.env, HOME: home },
  })
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() }
}

const kinds = {
  'a broken link': (at: string) => symlink('../nowhere.ts', at),
  'not a file': (at: string) => mkdir(at),
} as const

for (const [kind, plant] of Object.entries(kinds))
  it(`a .vx/workspace.ts that is ${kind} stops the walk and is refused by name`, async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'vx-ws-broken-')))
    made.push(root)
    await Bun.write(path.join(root, '.vx/workspace.ts'), 'export default {}\n')
    await mkdir(path.join(root, 'inner/.vx'), { recursive: true })
    await mkdir(path.join(root, 'inner/src'))
    const at = path.join(root, 'inner/.vx/workspace.ts')
    await plant(at)
    const err = await findWorkspaceRoot(path.join(root, 'inner/src')).then(
      (r) => r,
      (e: Error) => e.message,
    )
    expect(err).toBe(`${at}: is ${kind} — fix or remove it`)
  })

it('a real .vx/workspace.* beside a broken one marks the root', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'vx-ws-broken-')))
  made.push(root)
  await Bun.write(path.join(root, '.vx/workspace.ts'), 'export default {}\n')
  await mkdir(path.join(root, 'inner/.vx'), { recursive: true })
  await symlink('../nowhere.ts', path.join(root, 'inner/.vx/workspace.ts'))
  await Bun.write(path.join(root, 'inner/.vx/workspace.mjs'), 'export default {}\n')
  expect(await findWorkspaceRoot(path.join(root, 'inner'))).toBe(path.join(root, 'inner'))
})

for (const git of ['init', false] as const)
  for (const [kind, plant] of Object.entries(kinds))
    it(`vx lock inside a nested workspace whose file is ${kind} refuses (git: ${git})`, async () => {
      const root = await realpath(await makeWorkspace({ prefix: 'vx-ws-broken-lock-', git }))
      made.push(root)
      await addProject(root, 'a', CONFIG)
      const inner = await addProject(root, 'inner', CONFIG)
      await mkdir(path.join(inner, '.vx'))
      await plant(path.join(inner, '.vx/workspace.ts'))
      // The outer lock leaves the nested workspace's project out.
      const outer = vx(root, 'lock')
      expect(outer.code).toBe(0)
      expect(outer.out).toContain('1 project config')
      const r = vx(inner, 'lock')
      expect(r.err).toContain(`${path.join(inner, '.vx/workspace.ts')}: is ${kind}`)
      expect(r.code).not.toBe(0)
    })

it('a tracked .vx/workspace.ts deleted from the worktree marks no nested workspace', async () => {
  const root = await realpath(await makeWorkspace({ prefix: 'vx-ws-broken-gone-' }))
  made.push(root)
  await addProject(root, 'a', CONFIG)
  const inner = await addProject(root, 'inner', CONFIG)
  await Bun.write(path.join(inner, '.vx/workspace.ts'), 'export default {}\n')
  gitIn(root)('add', '-A')
  await rm(path.join(inner, '.vx/workspace.ts'))
  // The walk from inside reaches the outer root, so the outer lock holds it.
  expect(await findWorkspaceRoot(inner)).toBe(root)
  const r = vx(root, 'lock')
  expect(r.code).toBe(0)
  expect(r.out).toContain('2 project configs')
})

for (const git of ['init', false] as const)
  it(`vx lock refuses a project config that is a broken link (git: ${git})`, async () => {
    const root = await realpath(await makeWorkspace({ prefix: 'vx-ws-broken-config-', git }))
    made.push(root)
    await addProject(root, 'a', CONFIG)
    const b = await addProject(root, 'b')
    await symlink('../nowhere.ts', path.join(b, 'vx.config.ts'))
    const r = vx(root, 'lock')
    expect(r.err).toContain(`${path.join(b, 'vx.config.ts')}: is a broken link`)
    expect(r.code).not.toBe(0)
  })
