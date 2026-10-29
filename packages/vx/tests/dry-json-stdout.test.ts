// `vx run --dry=json` is a machine's input: stdout carries the plan and
// nothing else. A `project` stage's warning (turbo() warns there) went
// through the plan's default logger to stdout ahead of the JSON, and the
// output did not parse (C-6).
import { writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { localWorkspaceSource } from './helpers/local-workspace.js'
import { pluginSource } from './helpers/plugin.js'
import { gitInitCommit } from './helpers/workspace.js'

const CLI = path.join(import.meta.dir, 'helpers', 'vx-locked.ts')
const BIN = path.join(import.meta.dir, '..', 'src', 'bin.ts')
let root: string

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-dry-json-'))
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ workspaces: ['pkgs/*'] }))
  await mkdir(path.join(root, 'pkgs', 'app'), { recursive: true })
  await writeFile(path.join(root, 'pkgs', 'app', 'package.json'), JSON.stringify({ name: 'app' }))
  await writeFile(
    path.join(root, 'pkgs', 'app', 'vx.config.mjs'),
    "export default { tasks: { build: { exec: { command: 'true' } } } }\n",
  )
  await Bun.write(
    path.join(root, '.vx/workspace.mjs'),
    localWorkspaceSource([
      pluginSource('org/warner', `{ project(config, ctx) { ctx.warn('careful: app') } }`),
    ]),
  )
  gitInitCommit(root)
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

it('a stage warning goes to stderr, and --dry=json stdout parses', () => {
  const p = Bun.spawnSync({
    cmd: ['bun', CLI, 'run', 'build', '--all', '--dry=json'],
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, CI: '', GITHUB_ACTIONS: '', NO_COLOR: '1' },
  })
  const tasks = (() => {
    try {
      return (JSON.parse(p.stdout.toString()) as { tasks: { id: string }[] }).tasks.map((t) => t.id)
    } catch {
      return `unparseable: ${p.stdout.toString().slice(0, 80)}`
    }
  })()
  expect({ code: p.exitCode, tasks, warned: p.stderr.toString().includes('careful: app') }).toEqual(
    { code: 0, tasks: ['app#build'], warned: true },
  )
})

it('`vx lock` and the run over its lock each print a stage warning once', () => {
  const count = (args: string[]) => {
    const p = Bun.spawnSync({
      cmd: ['bun', BIN, ...args],
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        CI: '1',
        GITHUB_ACTIONS: '',
        VX_LOCK_REVIEW_FILES: 'false',
        NO_COLOR: '1',
      },
    })
    const all = p.stdout.toString() + p.stderr.toString()
    return { code: p.exitCode, warned: all.split('careful: app').length - 1 }
  }
  // Each loads the plugin once: the lock to stage the configs, the run to stage the locked ones.
  expect({
    lock: count(['lock']),
    dry: count(['run', 'build', '--all', '--dry']),
    run: count(['run', 'build', '--all']),
  }).toEqual({
    lock: { code: 0, warned: 1 },
    dry: { code: 0, warned: 1 },
    run: { code: 0, warned: 1 },
  })
})

// vercel/turborepo#2067: "Remote computation caching enabled" printed on
// stdout ahead of the JSON. A remote layer that answers and one that fails
// each leave stdout the plan alone.
it('--dry=json stdout parses with a remote cache layer, answering or failing', () => {
  writeFileSync(
    path.join(root, 'pkgs', 'app', 'vx.config.mjs'),
    `export default { tasks: { build: { exec: { command: 'true' }, inputs: { files: ['package.json'] }, cache: { outputs: { files: [] } } } } }\n`,
  )
  const plan = (fail: boolean) => {
    writeFileSync(
      path.join(root, '.vx/workspace.mjs'),
      localWorkspaceSource([
        pluginSource(
          'org/remote',
          `{ cache() { return {
            endpoint: 'mem://remote',
            async has() { ${fail ? "throw new Error('remote down')" : 'return null'} },
            async get() { return null },
            async put() {},
          } } }`,
        ),
      ]),
    )
    const p = Bun.spawnSync({
      cmd: ['bun', CLI, 'run', 'build', '--all', '--dry=json'],
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, CI: '', GITHUB_ACTIONS: '', NO_COLOR: '1' },
    })
    let tasks: string[] | string
    try {
      tasks = (JSON.parse(p.stdout.toString()) as { tasks: { id: string }[] }).tasks.map(
        (t) => t.id,
      )
    } catch {
      tasks = `unparseable: ${p.stdout.toString().slice(0, 80)}`
    }
    return { code: p.exitCode, tasks, stderr: p.stderr.toString() }
  }
  const ok = plan(false)
  expect({ code: ok.code, tasks: ok.tasks }).toEqual({ code: 0, tasks: ['app#build'] })
  const down = plan(true)
  expect({ code: down.code, tasks: down.tasks }).toEqual({ code: 0, tasks: ['app#build'] })
  // CONTROL: the failing remote was asked, and said so where a machine does not read.
  expect(down.stderr).toContain('remote down')
})

// Turbo #10375: `--dry` refused what only a real run's resources decide
// (more persistent tasks than `--concurrency`, interactive tasks off a TTY).
it('--dry=json plans three servers at --concurrency 1, off a TTY', () => {
  writeFileSync(
    path.join(root, 'pkgs', 'app', 'vx.config.mjs'),
    `export default { tasks: Object.fromEntries(['a', 'b', 'c'].map((t) => [t, { exec: { command: 'sleep 30', persistent: {}, interactive: true } }])) }\n`,
  )
  const p = Bun.spawnSync({
    cmd: [
      process.execPath,
      CLI,
      'run',
      'app#a',
      'app#b',
      'app#c',
      '--concurrency',
      '1',
      '--dry=json',
    ],
    cwd: root,
    env: { ...process.env, CI: '', GITHUB_ACTIONS: '', NO_COLOR: '1' },
  })
  // The workspace's warner plugin says its one line; nothing else.
  expect([p.exitCode, p.stderr.toString()]).toEqual([0, 'careful: app\n'])
  const plan = JSON.parse(p.stdout.toString()) as { tasks: { id: string }[] }
  expect(plan.tasks.map((t) => t.id).sort()).toEqual(['app#a', 'app#b', 'app#c'])
})
