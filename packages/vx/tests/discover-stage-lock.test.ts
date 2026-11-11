// A plugin's `discover` stage is run by `vx lock` and only read by runs
// (2026-11-11: "we never relock during runs ... it should always follow the
// lock blindly"). A run asked nx() for Nx's graph each time, and the live
// graph's edges decided it: an `implicitDependencies` added without
// `vx lock` ran the new dependency's build.
import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { localWorkspaceSource } from './helpers/local-workspace.js'
import { pluginSource } from './helpers/plugin.js'
import { addProject, makeWorkspace } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')

async function vx(root: string, args: string[]) {
  const proc = Bun.spawn([process.execPath, BIN, ...args], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, NO_COLOR: '1', VX_LOCK_REVIEW_FILES: 'false' },
  })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, out, err }
}

// The answer reads `edges.txt` at the root, as nx() reads Nx's graph, and
// logs each call: `b-on-a` gives b an edge to a; `gen` names tools/gen
// `gen`, anything else `generator`.
const EDGES = pluginSource(
  'org/edges',
  `{ discover(ctx) {
      const fs = require('node:fs')
      const p = require('node:path')
      fs.appendFileSync(p.join(ctx.workspaceRoot, 'discover.log'), 'called\\n')
      const said = fs.readFileSync(p.join(ctx.workspaceRoot, 'edges.txt'), 'utf8')
      return [
        { dir: 'packages/a', name: 'a', deps: [] },
        { dir: 'packages/b', name: 'b', deps: said.includes('b-on-a') ? ['packages/a'] : [] },
        { dir: 'tools/gen', name: said.includes('gen') ? 'gen' : 'generator' },
      ]
    } }`,
)

const build = (word: string): string =>
  `export default { tasks: { build: { exec: { command: 'echo built-${word}' }, dependsOn: ['^build'] } } }\n`

let root: string
beforeEach(async () => {
  root = await makeWorkspace({ prefix: 'vx-discover-lock-' })
  await addProject(root, 'a', { config: build('a') })
  await addProject(root, 'b', { config: build('b') })
  await mkdir(path.join(root, 'tools', 'gen'), { recursive: true })
  await Bun.write(path.join(root, 'tools', 'gen', 'vx.config.mjs'), build('gen'))
  await Bun.write(path.join(root, 'edges.txt'), 'gen\n')
  await Bun.write(path.join(root, '.vx/workspace.mjs'), localWorkspaceSource([EDGES]))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

const calls = async (): Promise<string> =>
  Bun.file(path.join(root, 'discover.log'))
    .text()
    .catch(() => '')

const run = (...args: string[]) =>
  vx(root, ['run', 'build', ...args, '--no-cache', '--output-logs', 'full'])

it('a run follows the discovery vx lock made, and calls no discover hook', async () => {
  const lock = await vx(root, ['lock'])
  expect(`${lock.code}\n${lock.err}`).toStartWith('0\n')
  const locked = await Bun.file(path.join(root, '.vx/projects.lock.json')).json()
  expect(locked.discoverStage).toEqual({
    plugins: ['vx-test-packages', 'org/edges'],
    projects: {
      'packages/a': { name: 'a', deps: [] },
      'packages/b': { name: 'b', deps: [] },
      'tools/gen': { name: 'gen' },
    },
  })
  const afterLock = await calls()

  // The answer changes, not relocked: the run keeps the locked edges and name.
  await Bun.write(path.join(root, 'edges.txt'), 'b-on-a\n')
  const stale = await run('--filter', 'b')
  expect(`${stale.code}\n${stale.err}`).toStartWith('0\n')
  expect(stale.out).toContain('built-b')
  expect(stale.out).not.toContain('built-a')
  const named = await run('--filter', 'gen')
  expect(`${named.code}\n${named.err}`).toStartWith('0\n')
  expect(named.out).toContain('built-gen')
  const shown = await vx(root, ['show', '--format', 'json'])
  expect(`${shown.code}\n${shown.err}`).toStartWith('0\n')
  expect(await calls()).toBe(afterLock)

  const check = await vx(root, ['lock', '--check'])
  expect(check.code).toBe(1)
  expect(check.err).toContain('packages/b: the `discover` stage finds it otherwise than the lock')
  expect(check.err).toContain('tools/gen: the `discover` stage finds it otherwise than the lock')

  expect((await vx(root, ['lock'])).code).toBe(0)
  const fresh = await run('--filter', 'b')
  expect(`${fresh.code}\n${fresh.err}`).toStartWith('0\n')
  expect(fresh.out).toContain('built-a')
  expect((await vx(root, ['lock', '--check'])).code).toBe(0)
}, 60_000)

it('a plugin swapped after vx lock discovers nothing until vx lock', async () => {
  // Every project a leaf: `^build` needs an edge source.
  const FLAT = pluginSource(
    'org/flat',
    `{ discover() {
      return [{ dir: 'packages/a', name: 'a', deps: [] }, { dir: 'packages/b', name: 'b', deps: [] }]
    } }`,
  )
  await Bun.write(path.join(root, 'edges.txt'), 'b-on-a gen\n')
  await Bun.write(path.join(root, '.vx/workspace.mjs'), localWorkspaceSource([FLAT]))
  expect((await vx(root, ['lock'])).code).toBe(0)
  await Bun.write(path.join(root, '.vx/workspace.mjs'), localWorkspaceSource([EDGES]))
  const r = await run('--filter', 'b')
  expect(`${r.code}\n${r.err}`).toStartWith('0\n')
  expect(r.out).not.toContain('built-a')
  expect(await calls()).toBe('')
  const check = await vx(root, ['lock', '--check'])
  expect(check.code).toBe(1)
  // The fixture's workspace file declares `vx-test-packages` first.
  expect(check.err).toContain(
    "the lock holds the `discover` stage of 'vx-test-packages', 'org/flat', not of 'vx-test-packages', 'org/edges'",
  )
}, 60_000)

it('and one dropped still runs what it discovered until vx lock', async () => {
  await Bun.write(path.join(root, 'edges.txt'), 'b-on-a gen\n')
  expect((await vx(root, ['lock'])).code).toBe(0)
  await Bun.write(path.join(root, '.vx/workspace.mjs'), localWorkspaceSource([]))
  const r = await run('--filter', 'b')
  expect(`${r.code}\n${r.err}`).toStartWith('0\n')
  expect(r.out).toContain('built-a')
  const check = await vx(root, ['lock', '--check'])
  expect(check.code).toBe(1)
  expect(check.err).toContain(
    "the lock holds the `discover` stage of 'vx-test-packages', 'org/edges', not of 'vx-test-packages'",
  )
}, 60_000)
