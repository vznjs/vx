// `vx run --dry=json` is a machine's input: stdout carries the plan and
// nothing else. A `project` stage's warning (turbo() warns there) went
// through the plan's default logger to stdout ahead of the JSON, and the
// output did not parse (C-6).
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { localWorkspaceSource } from './helpers/local-workspace.js'
import { pluginSource } from './helpers/plugin.js'
import { gitInitCommit } from './helpers/workspace.js'

const CLI = path.join(import.meta.dir, '..', 'src', 'bin.ts')
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
  await writeFile(
    path.join(root, 'vx.workspace.mjs'),
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
