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
import { type Logger } from '../src/report/index.js'
import { run } from './helpers/orchestrator.js'

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
    path.join(root, '.vx/workspace.mjs'),
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
}, 30_000)

// A task a stop killed on another machine read `aborted` with no machine,
// though it ran there (a vx-dte Ctrl-C).
it('a task a stop aborts keeps where its executor ran it', async () => {
  await Bun.write(
    path.join(root, '.vx/workspace.mjs'),
    localWorkspaceSource([
      pluginSource(
        'org/elsewhere',
        `{ executor() { return { name: 'elsewhere', async execute(req) {
            globalThis.__vxElsewhereStarted = true
            await new Promise((resolve) => req.signal?.addEventListener('abort', resolve, { once: true }))
            return { exitCode: 143, signal: 'SIGTERM', durationMs: 0, stdout: '', stderr: '', violations: [], where: 'worker-1' }
          } } } }`,
      ),
    ]),
  )
  await addProject(
    root,
    'app',
    `export default { tasks: { slow: { exec: { command: 'sleep 30' } } } }`,
  )
  const ac = new AbortController()
  const running = run({
    cwd: root,
    tasks: ['slow'],
    projects: ['app'],
    log: silent,
    handleSignals: false,
    signal: ac.signal,
  })
  const g = globalThis as { __vxElsewhereStarted?: boolean }
  while (g.__vxElsewhereStarted !== true) await Bun.sleep(10)
  ac.abort()
  const r = await running
  expect(r.outcomes.map((o) => [o.node.id, o.status, o.placement?.where])).toEqual([
    ['app#slow', 'aborted', 'worker-1'],
  ])
}, 30_000)

it("exec.timeout aborts a plugin executor's request, and the task fails as timed out", async () => {
  await Bun.write(
    path.join(root, '.vx/workspace.mjs'),
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
    `export default { tasks: { slow: { exec: { command: 'exec sleep 30', timeout: '300ms' } } } }`,
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
}, 30_000)

// A child that traps the TERM and exits 0 is the shape the local executor
// fails as timed out (its partial outputs are never cached). On a plugin
// executor the 0 read as a pass, and the partial outputs were saved and
// replayed as a green hit (X-125).
it("an exit 0 after exec.timeout's abort is a timeout on a plugin executor too (X-125)", async () => {
  await Bun.write(
    path.join(root, '.vx/workspace.mjs'),
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
    `export default { tasks: { slow: {
      exec: {
        command: "trap 'exit 0' TERM; mkdir -p dist; echo partial > dist/out.txt; while :; do sleep 0.05; done",
        timeout: '300ms',
      },
      inputs: { files: ['package.json'] }, outputs: { files: ['dist/**'] }, cache: true,
    } } }`,
  )
  const once = async () => {
    const r = await run({
      cwd: root,
      tasks: ['slow'],
      projects: ['app'],
      log: silent,
      handleSignals: false,
    })
    return r.outcomes.map((o) => [o.node.id, o.status, o.exitCode, o.timedOut === true])
  }
  expect(await once()).toEqual([['app#slow', 'failed', 143, true]])
  // Nothing was saved: the second run executes again rather than hit.
  expect(await once()).toEqual([['app#slow', 'failed', 143, true]])
}, 30_000)

// An executor may keep its own clock: a task with no `exec.timeout` it
// reports timed out read "timed out after undefinedms — its executor was
// aborted", though core aborted nothing.
it('a timeout the executor reports on a task with none says so, and fails', async () => {
  await Bun.write(
    path.join(root, '.vx/workspace.mjs'),
    localWorkspaceSource([
      pluginSource(
        'org/own-clock',
        `{ executor() { return { name: 'own-clock', async execute() {
            return { exitCode: 0, timedOut: true, durationMs: 1, stdout: '', stderr: '', violations: [] }
          } } } }`,
      ),
    ]),
  )
  await addProject(root, 'app', `export default { tasks: { t: { exec: { command: 'true' } } } }`)
  const stderr: string[] = []
  const r = await run({
    cwd: root,
    tasks: ['t'],
    projects: ['app'],
    log: { ...silent, taskStderr: (_n, chunk) => stderr.push(chunk) },
    handleSignals: false,
  })
  expect(r.outcomes.map((o) => [o.node.id, o.status, o.exitCode, o.timedOut === true])).toEqual([
    ['app#t', 'failed', 143, true],
  ])
  expect(stderr.join('')).toBe('[vx] timed out — as its executor reported\n')
}, 30_000)

// `--continue=never` starts nothing after a failure. A task a plugin
// executor still held for a machine (`running` answered `null`) is not
// started, and vx-dte sent one to a worker after the failure (2026-11-06).
// One the executor had begun finishes its attempt.
it('fail-fast withdraws a task its executor holds unstarted; one begun finishes', async () => {
  await Bun.write(
    path.join(root, '.vx/workspace.mjs'),
    localWorkspaceSource([
      pluginSource(
        'org/holder',
        `{ executor() {
          const held = new Set(), begun = new Set()
          let failed = false
          const until = (ok) => new Promise((resolve) => {
            const t = setInterval(() => { if (ok()) { clearInterval(t); resolve() } }, 5)
          })
          const done = (exitCode, extra = {}) =>
            ({ exitCode, durationMs: 0, stdout: '', stderr: '', violations: [], ...extra })
          return { name: 'holder', capacity: 4,
            running: (id) => (held.has(id) ? null : begun.has(id) ? 'm1' : undefined),
            async execute(req) {
              if (req.taskId === 'app#fail') {
                await until(() => held.size + begun.size === 2)
                failed = true
                return done(1)
              }
              const own = req.taskId === 'app#held' ? held : begun
              own.add(req.taskId)
              // Ends the held one when nothing withdraws it; the begun one
              // finishes a little after the failure.
              const aborted = await new Promise((resolve) => {
                req.signal?.addEventListener('abort', () => resolve(true), { once: true })
                void until(() => failed).then(() =>
                  setTimeout(() => resolve(false), own === held ? 5000 : 200))
              })
              own.delete(req.taskId)
              return aborted ? done(130, { signal: 'SIGTERM' }) : done(0, { where: 'm1' })
            } } } }`,
      ),
    ]),
  )
  await addProject(
    root,
    'app',
    `export default { tasks: {
      fail: { exec: { command: 'exit 1' } },
      held: { exec: { command: 'echo held' } },
      begun: { exec: { command: 'echo begun' } },
    } }`,
  )
  const r = await run({
    cwd: root,
    tasks: ['fail', 'held', 'begun'],
    projects: ['app'],
    log: silent,
    handleSignals: false,
    continueMode: 'never',
  })
  expect(
    r.outcomes
      .map((o) => [o.node.id, o.status])
      .toSorted((a, b) => String(a[0]).localeCompare(String(b[0]))),
  ).toEqual([
    ['app#begun', 'success'],
    ['app#fail', 'failed'],
    ['app#held', 'skipped'],
  ])
}, 30_000)

// An executor that never looks at `signal` held the task, and the run, past
// both the timeout and the stop (H-14). Core now waits the kill grace after
// the abort and settles the attempt without it.
describe('an executor that ignores the signal', () => {
  const deaf = pluginSource(
    'org/deaf',
    `{ executor() { return { name: 'deaf', execute(req) {
        req.onStderr('working')
        return new Promise(() => {})
      } } } }`,
  )
  let grace: string | undefined
  beforeEach(() => {
    grace = process.env['VX_TEST_KILL_GRACE']
    process.env['VX_TEST_KILL_GRACE'] = '200ms'
  })
  afterEach(() => {
    if (grace === undefined) delete process.env['VX_TEST_KILL_GRACE']
    else process.env['VX_TEST_KILL_GRACE'] = grace
  })

  it('is abandoned after the grace once exec.timeout fires, and the task times out', async () => {
    await Bun.write(path.join(root, '.vx/workspace.mjs'), localWorkspaceSource([deaf]))
    await addProject(
      root,
      'app',
      `export default { tasks: { slow: { exec: { command: 'true', timeout: '300ms' } } } }`,
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
    // Its row names the executor it was placed on, not this machine.
    expect(
      r.outcomes.map((o) => [o.node.id, o.status, o.timedOut === true, o.placement?.where]),
    ).toEqual([['app#slow', 'failed', true, 'deaf']])
    expect(Date.now() - started).toBeLessThan(10_000)
    // On its own line: the executor's last output ended mid-line.
    expect(stderr.join('')).toStartWith(
      "working\nvx: plugin 'org/deaf' (executor 'deaf') did not return within 200ms of the timeout (300ms); abandoned\n",
    )
    // Core killed nothing: the executor's child is its own.
    expect(stderr.join('')).toContain('[vx] timed out after 300ms — its executor was aborted\n')
  }, 30_000)

  // An abandoned attempt may still write: core cannot reach what it started,
  // so the retry's pass stands but is not saved (schema.md, retries).
  it("a retry's pass after an abandoned attempt is not saved", async () => {
    const once = pluginSource(
      'org/deaf-once',
      `{ executor() { let calls = 0; return { name: 'deaf-once', execute() {
          calls++
          if (calls === 1) return new Promise(() => {})
          return Promise.resolve({ exitCode: 0, durationMs: 1, stdout: '', stderr: '', violations: [] })
        } } } }`,
    )
    await Bun.write(path.join(root, '.vx/workspace.mjs'), localWorkspaceSource([once]))
    await addProject(root, 'app', {
      files: { 'src/a.txt': 'a' },
      config: `export default { tasks: { slow: {
        exec: { command: 'true', timeout: '300ms', retries: 1 },
        inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] }, cache: true,
      } } }`,
    })
    const said: string[] = []
    const r = await run({
      cwd: root,
      tasks: ['slow'],
      projects: ['app'],
      log: { ...silent, status: (line) => said.push(line), warn: (line) => said.push(line) },
      handleSignals: false,
    })
    expect(r.outcomes.map((o) => [o.node.id, o.status])).toEqual([['app#slow', 'success']])
    expect(said.join('\n')).toContain(
      'app#slow: a process it left running may still write its outputs',
    )
  }, 30_000)

  it('is abandoned after the grace once the run stops, and the task is aborted', async () => {
    await Bun.write(path.join(root, '.vx/workspace.mjs'), localWorkspaceSource([deaf]))
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
  }, 30_000)
})

// The scheduler prints a thrown executor's line into the task's stream: after
// a partial line it read `partial[vx] internal error in app#t: …`.
it('the line naming a thrown executor starts its own line', async () => {
  await Bun.write(
    path.join(root, '.vx/workspace.mjs'),
    localWorkspaceSource([
      pluginSource(
        'org/thrower',
        `{ executor() { return { name: 'thrower', async execute(req) {
            req.onStdout('partial')
            throw new Error('boom')
          } } } }`,
      ),
    ]),
  )
  await addProject(root, 'app', `export default { tasks: { t: { exec: { command: 'true' } } } }`)
  const seq: string[] = []
  await run({
    cwd: root,
    tasks: ['t'],
    projects: ['app'],
    log: { ...silent, taskStdout: (_n, c) => seq.push(c), taskStderr: (_n, c) => seq.push(c) },
    handleSignals: false,
  })
  expect(seq.join('')).toStartWith('partial\n[vx] ')
}, 30_000)

// A throw gives core no `where`: the row read `local` for a task placed on
// the plugin's executor.
it('a thrown executor names itself as where the task was placed', async () => {
  await Bun.write(
    path.join(root, '.vx/workspace.mjs'),
    localWorkspaceSource([
      pluginSource(
        'org/thrower',
        `{ executor() { return { name: 'thrower', async execute() { throw new Error('boom') } } } }`,
      ),
    ]),
  )
  await addProject(root, 'app', `export default { tasks: { t: { exec: { command: 'true' } } } }`)
  const r = await run({
    cwd: root,
    tasks: ['t'],
    projects: ['app'],
    log: silent,
    handleSignals: false,
  })
  expect(r.outcomes.map((o) => [o.node.id, o.status, o.placement?.where])).toEqual([
    ['app#t', 'failed', 'thrower'],
  ])
}, 30_000)
