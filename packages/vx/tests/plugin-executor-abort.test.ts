// A plugin executor's child is its own: core cannot reach it (`killTree`
// signals a process group the local executor made, and a plugin's child
// leads none). Before `ExecuteRequest.signal`, a Ctrl-C left such a child
// running after vx exited, and an embedder's abort waited on it (the H
// plugin-author walk, 2026-09-27). The row stops a run whose one task runs
// on a plugin executor that listens to the signal.

import { rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { isAlive, waitForDead } from './helpers/alive.js'
import { localWorkspaceSource } from './helpers/local-workspace.js'
import { pluginSource } from './helpers/plugin.js'
import { addProject, makeWorkspace } from './helpers/workspace.js'
import { run, type Logger } from '../src/orchestrator/index.js'

const silent: Logger = { status() {}, taskStdout() {}, taskStderr() {}, taskComplete() {} }

/** The pid the task wrote; a fresh `Bun.file` per look, since one handle kept reading empty. */
async function waitForPid(file: string): Promise<number> {
  for (;;) {
    const f = Bun.file(file)
    const pid = (await f.exists()) ? Number((await f.text()).trim()) : 0
    if (Number.isInteger(pid) && pid > 0) return pid
    await Bun.sleep(20)
  }
}

let root: string
beforeEach(async () => {
  root = await makeWorkspace({ prefix: 'vx-plugin-abort-' })
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

it("an aborted run aborts a plugin executor's request, so its child ends and run() returns", async () => {
  await Bun.write(
    path.join(root, 'vx.workspace.mjs'),
    localWorkspaceSource([
      pluginSource(
        'org/spawner',
        `{ executor() { return { name: 'spawner', async execute(req) {
            const child = Bun.spawn(['sh', '-c', req.command], { cwd: req.cwd, env: req.env })
            req.signal?.addEventListener('abort', () => child.kill(), { once: true })
            const exitCode = await child.exited
            return { exitCode, durationMs: 0, stdout: '', stderr: '', violations: [] }
          } } } }`,
      ),
    ]),
  )
  const dir = await addProject(
    root,
    'app',
    `export default { tasks: { slow: { exec: { command: 'echo $$ > pid.txt; exec sleep 30' } } } }`,
  )
  const ac = new AbortController()
  const started = Date.now()
  const running = run({
    cwd: root,
    tasks: ['slow'],
    projects: ['app'],
    log: silent,
    handleSignals: false,
    signal: ac.signal,
  })
  const pid = await waitForPid(path.join(dir, 'pid.txt'))
  expect(isAlive(pid)).toBe(true)
  ac.abort()
  const r = await running
  expect(r.outcomes.map((o) => [o.node.id, o.status])).toEqual([['app#slow', 'aborted']])
  expect(Date.now() - started).toBeLessThan(10_000)
  expect(await waitForDead(pid, 1_000)).toBe(true)
}, 20_000)

it("exec.timeout aborts a plugin executor's request, and the task fails as timed out", async () => {
  await Bun.write(
    path.join(root, 'vx.workspace.mjs'),
    localWorkspaceSource([
      pluginSource(
        'org/spawner',
        `{ executor() { return { name: 'spawner', async execute(req) {
            const child = Bun.spawn(['sh', '-c', req.command], { cwd: req.cwd, env: req.env })
            req.signal?.addEventListener('abort', () => child.kill(), { once: true })
            const exitCode = await child.exited
            return { exitCode, durationMs: 0, stdout: '', stderr: '', violations: [] }
          } } } }`,
      ),
    ]),
  )
  await addProject(
    root,
    'app',
    `export default { tasks: { slow: { exec: { command: 'exec sleep 30', timeout: 300 } } } }`,
  )
  const started = Date.now()
  const r = await run({
    cwd: root,
    tasks: ['slow'],
    projects: ['app'],
    log: silent,
    handleSignals: false,
  })
  expect(r.outcomes.map((o) => [o.node.id, o.status, o.timedOut === true])).toEqual([
    ['app#slow', 'failed', true],
  ])
  expect(Date.now() - started).toBeLessThan(10_000)
}, 20_000)

// An executor that never looks at `signal` held the task, and the run, past
// both the timeout and the stop (H-14). Core now waits the kill grace after
// the abort and settles the attempt without it.
describe('an executor that ignores the signal', () => {
  const deaf = pluginSource(
    'org/deaf',
    `{ executor() { return { name: 'deaf', execute(req) {
        req.onStderr('started\\n')
        return new Promise(() => {})
      } } } }`,
  )
  let grace: string | undefined
  beforeEach(() => {
    grace = process.env['VX_KILL_GRACE_MS']
    process.env['VX_KILL_GRACE_MS'] = '200'
  })
  afterEach(() => {
    if (grace === undefined) delete process.env['VX_KILL_GRACE_MS']
    else process.env['VX_KILL_GRACE_MS'] = grace
  })

  it('is abandoned after the grace once exec.timeout fires, and the task times out', async () => {
    await Bun.write(path.join(root, 'vx.workspace.mjs'), localWorkspaceSource([deaf]))
    await addProject(
      root,
      'app',
      `export default { tasks: { slow: { exec: { command: 'true', timeout: 300 } } } }`,
    )
    const stderr: string[] = []
    const started = Date.now()
    const r = await run({
      cwd: root,
      tasks: ['slow'],
      projects: ['app'],
      log: { ...silent, taskStderr: (_n, chunk) => stderr.push(chunk) },
      handleSignals: false,
    })
    expect(r.outcomes.map((o) => [o.node.id, o.status, o.timedOut === true])).toEqual([
      ['app#slow', 'failed', true],
    ])
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(stderr.join('')).toContain(
      "vx: plugin 'org/deaf' (executor 'deaf') did not return within 200ms of the timeout (300ms); abandoned\n",
    )
  }, 20_000)

  it('is abandoned after the grace once the run stops, and the task is aborted', async () => {
    await Bun.write(path.join(root, 'vx.workspace.mjs'), localWorkspaceSource([deaf]))
    await addProject(
      root,
      'app',
      `export default { tasks: { slow: { exec: { command: 'true' } } } }`,
    )
    const ac = new AbortController()
    const r = await run({
      cwd: root,
      tasks: ['slow'],
      projects: ['app'],
      log: { ...silent, taskStderr: () => ac.abort() },
      handleSignals: false,
      signal: ac.signal,
    })
    expect(r.outcomes.map((o) => [o.node.id, o.status])).toEqual([['app#slow', 'aborted']])
  }, 20_000)
})
