// A config the lock does not hold is not there for a run (owner, 2026-11-25:
// "Not in lock not there"). A run never looks for one: `--all`, the cwd, a
// `project#task`, a filter and `vx show` see only the lock's projects, with
// no "not in the lock yet" refusal. `vx lock` makes it a project.
import { mkdirSync, readdirSync, rmSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, expect, it } from 'bun:test'
import { addProject, makeWorkspace } from './helpers/workspace.js'
import { PARITY_TIMEOUT as TIMEOUT } from './helpers/parity.js'
import { BIN, vx as spawnVx } from './helpers/vx.js'

// The bare CLI: the test helper's `vx` locks before each run.
const vx = (cwd: string, args: string[]) => spawnVx(cwd, args, { bin: BIN })

// Each task leaves `ran-<word>` in the system temp dir's `marks`: a run's
// output shows no task's when several run.
const marks = path.join(tmpdir(), `vx-unlocked-marks-${process.pid}`)
const build = (word: string) =>
  `export default { tasks: { build: { exec: { command: 'touch ${marks}/ran-${word}' } } } }\n`

/** The `ran-*` marks tasks left since the last call, which clears them. */
function ran(): string[] {
  const found = readdirSync(marks).sort()
  for (const f of found) rmSync(path.join(marks, f))
  return found
}

beforeAll(() => mkdirSync(marks, { recursive: true }))
afterAll(() => rmSync(marks, { recursive: true, force: true }))

it(
  'an --all run with a config the lock lacks runs the locked projects, green',
  async () => {
    const root = await makeWorkspace({ prefix: 'vx-unlocked-all-', edges: {} })
    try {
      await addProject(root, 'd', { config: build('d') })
      expect((await vx(root, ['lock'])).code).toBe(0)
      await addProject(root, 'c', { config: build('c') })
      const r = await vx(root, ['run', 'build', '--all', '--no-cache'])
      expect({ code: r.code, ran: ran(), lock: r.text.includes('vx lock') }).toEqual({
        code: 0,
        ran: ['ran-d'],
        lock: false,
      })
      expect((await vx(root, ['lock'])).code).toBe(0)
      const after = await vx(root, ['run', 'build', '--all', '--no-cache'])
      expect({ code: after.code, ran: ran() }).toEqual({
        code: 0,
        ran: ['ran-c', 'ran-d'],
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
  TIMEOUT,
)

it(
  'a run from a directory whose config the lock lacks runs the locked project above it',
  async () => {
    const root = await makeWorkspace({ prefix: 'vx-unlocked-cwd-', workspaceFile: false })
    try {
      await writeFile(path.join(root, 'vx.config.mjs'), build('root'))
      expect((await vx(root, ['lock'])).code).toBe(0)
      const dir = path.join(root, 'packages', 'n')
      await mkdir(dir, { recursive: true })
      await writeFile(path.join(dir, 'vx.config.mjs'), build('n'))
      const r = await vx(dir, ['run', 'build', '--no-cache'])
      expect({ code: r.code, ran: ran() }).toEqual({ code: 0, ran: ['ran-root'] })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
  TIMEOUT,
)

it(
  "naming a locked config-less project whose config came after the lock runs the lock's build",
  async () => {
    // `d` depends on `c`: a configured dependant gives config-less `c` its default build.
    const root = await makeWorkspace({ prefix: 'vx-unlocked-config-', edges: { d: ['c'] } })
    try {
      const dir = await addProject(root, 'c', {})
      await addProject(root, 'd', { config: 'export default { tasks: {} }\n' })
      expect((await vx(root, ['lock'])).code).toBe(0)
      await writeFile(path.join(dir, 'vx.config.mjs'), build('c'))
      const r = await vx(root, ['run', 'c#build', '--no-cache'])
      expect({ code: r.code, ran: ran(), lock: r.text.includes('not in the lock') }).toEqual({
        code: 0,
        ran: [],
        lock: false,
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
  TIMEOUT,
)

it(
  'a directory or package whose config came after the lock is no project to name',
  async () => {
    const root = await makeWorkspace({ prefix: 'vx-unlocked-dir-', edges: {} })
    try {
      await addProject(root, 'a', { config: build('a') })
      expect((await vx(root, ['lock'])).code).toBe(0)
      await mkdir(path.join(root, 'c'), { recursive: true })
      await writeFile(path.join(root, 'c', 'vx.config.mjs'), build('c'))
      await addProject(root, '@s/newpkg', { config: build('new') })
      for (const args of [
        ['run', 'c#build'],
        ['run', '@s/newpkg#build'],
        ['run', 'build', '--filter', '@s/newpkg'],
        ['run', 'build', '--filter', './c'],
        ['show', 'c'],
        ['show', '@s/newpkg'],
      ]) {
        const r = await vx(root, args)
        expect({ args, code: r.code, ran: ran() }).toEqual({ args, code: 1, ran: [] })
        expect(r.text).not.toContain('not in the lock')
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
  TIMEOUT,
)

it(
  "an --all run asks nothing of a nested workspace's configs",
  async () => {
    const root = await makeWorkspace({ prefix: 'vx-unlocked-nested-', edges: {} })
    try {
      await addProject(root, 'd', { config: build('d') })
      const inner = path.join(root, 'inner')
      await mkdir(path.join(inner, '.vx'), { recursive: true })
      await writeFile(path.join(inner, '.vx', 'workspace.ts'), 'export default {}\n')
      expect((await vx(root, ['lock'])).code).toBe(0)
      await mkdir(path.join(inner, 'p'), { recursive: true })
      await writeFile(path.join(inner, 'p', 'vx.config.mjs'), 'export default { tasks: {} }\n')
      expect((await vx(root, ['run', 'build', '--all'])).code).toBe(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
  TIMEOUT,
)
