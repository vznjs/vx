// What core hands a plugin to observe is read-only: a hook or sink that
// writes to it changes nothing core decides or another plugin reads, and
// its write throws (plugin code is ESM, so strict) where it is reported
// naming the plugin. Each row once changed a run: a setup handler turned a
// failed task into a pass, a project hook moved a project into another's
// directory and its output clean emptied that one, a sink that cleared a
// record's array crashed a green run (the plugin-seam hunt, 2026-11-07).

import { existsSync, readFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { localWorkspaceSource } from './helpers/local-workspace.js'
import { pluginSource } from './helpers/plugin.js'
import { addProject, makeWorkspace } from './helpers/workspace.js'
import { type Logger } from '../src/report/index.js'
import { run } from './helpers/orchestrator.js'

let root: string
let lines: string[]
let log: Logger
beforeEach(async () => {
  root = await makeWorkspace({ prefix: 'vx-plugin-read-only-' })
  lines = []
  log = {
    status: (l) => void lines.push(l),
    warn: (l) => void lines.push(l),
    taskStdout() {},
    taskStderr() {},
    taskComplete() {},
  }
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const plugins = (...sources: string[]): Promise<number> =>
  Bun.write(
    path.join(root, '.vx/workspace.mjs'),
    localWorkspaceSource(sources, 'globalThis.__ro = {}\n'),
  )
const seen = (): Record<string, unknown> =>
  (globalThis as unknown as { __ro: Record<string, unknown> }).__ro

/** `a#build` fails (exit 3) unless `ok`; `b#build` builds after it. */
async function twoProjects(ok = false): Promise<string> {
  const a = await addProject(root, 'a', {
    config: `export default { tasks: { build: { exec: { command: 'mkdir -p dist && echo a > dist/a && exit ${ok ? 0 : 3}' }, cache: true, inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] } } } }`,
    files: { 'src/x': 'x' },
  })
  await addProject(root, 'b', {
    config: `export default { tasks: { build: { dependsOn: ['a#build'], exec: { command: 'mkdir -p dist && echo b > dist/b' }, cache: true, inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] } } } }`,
    files: { 'src/y': 'y' },
  })
  return a
}

it('an onTaskComplete handler cannot turn a failed task into a pass', async () => {
  await twoProjects()
  await plugins(
    pluginSource(
      'org/flip',
      `{ setup(ctx) { ctx.on('onTaskComplete', (node, o) => {
          if (o.status === 'failed') { o.status = 'success'; o.exitCode = 0 }
        }) } }`,
    ),
  )
  const r = await run({ cwd: root, tasks: ['build'], log, handleSignals: false })
  expect(Object.fromEntries(r.outcomes.map((o) => [o.node.id, o.status]))).toEqual({
    'a#build': 'failed',
    'b#build': 'skipped',
  })
  expect(r.ok).toBe(false)
  expect(lines.filter((l) => l.includes("plugin 'org/flip'"))).toEqual([
    expect.stringMatching(
      /^\[vx\] plugin 'org\/flip' threw in onTaskComplete; disabled for this run: .*read-?only/i,
    ),
  ])
})

it('a raw bus subscriber cannot change an outcome either', async () => {
  await twoProjects()
  await plugins(
    pluginSource(
      'org/flip',
      `{ setup(ctx) { ctx.bus.subscribe((e) => {
          if (e.kind === 'task:complete' && e.outcome.status === 'failed') e.outcome.status = 'success'
        }) } }`,
    ),
  )
  const r = await run({ cwd: root, tasks: ['build'], log, handleSignals: false })
  expect(r.outcomes.find((o) => o.node.id === 'a#build')?.status).toBe('failed')
  expect(r.ok).toBe(false)
})

// The command ran under the key of the one the config declares: its
// outputs were saved as that task's.
it('an onTaskStart handler cannot rewrite the command a task runs', async () => {
  const a = await twoProjects(true)
  await plugins(
    pluginSource(
      'org/hijack',
      `{ setup(ctx) { ctx.on('onTaskStart', (node) => {
          node.config.exec.command = 'echo hijacked > dist/a'
        }) } }`,
    ),
  )
  const r = await run({ cwd: root, tasks: ['build'], projects: ['a'], log, handleSignals: false })
  expect(r.outcomes.map((o) => [o.node.id, o.status])).toEqual([['a#build', 'success']])
  expect(readFileSync(path.join(a, 'dist/a'), 'utf8')).toBe('a\n')
  expect(lines.some((l) => l.startsWith("[vx] plugin 'org/hijack' threw in onTaskStart"))).toBe(
    true,
  )
})

it("a project hook cannot move a project into another's directory", async () => {
  const a = await twoProjects(true)
  await run({ cwd: root, tasks: ['build'], projects: ['a'], log, handleSignals: false })
  expect(readFileSync(path.join(a, 'dist/a'), 'utf8')).toBe('a\n')
  // `vx lock`, the one pass that runs the stage (2026-11-11), meets it.
  await plugins(
    pluginSource(
      'org/mover',
      `{ project(config, ctx) {
          const a = ctx.projects.find((p) => p.name === 'a')
          const b = ctx.projects.find((p) => p.name === 'b')
          b.dir = a.dir
        } }`,
    ),
  )
  const r = run({ cwd: root, tasks: ['build'], log, handleSignals: false })
  await expect(r).rejects.toThrow(/plugin 'org\/mover' failed in project: .*read-?only/i)
  expect(readFileSync(path.join(a, 'dist/a'), 'utf8')).toBe('a\n')
})

it('a project hook cannot empty the project list', async () => {
  await twoProjects(true)
  await plugins(pluginSource('org/emptier', `{ project(config, ctx) { ctx.projects.length = 0 } }`))
  const r = run({ cwd: root, tasks: ['build'], log, handleSignals: false })
  await expect(r).rejects.toThrow(/plugin 'org\/emptier' failed in project: /)
})

it("a telemetry sink's edit reaches neither core nor the next sink", async () => {
  await addProject(root, 'c', {
    // Fails its first attempt and passes its retry: one failed attempt.
    config: `export default { tasks: { flaky: { exec: { command: 'if [ -f .once ]; then rm .once; else touch .once; exit 3; fi', retries: 1 } } } }`,
  })
  await plugins(
    pluginSource(
      'org/sinks',
      `{ telemetry() { return [
          { name: 'eraser', onRecord(r) { if (r.kind === 'task.end') r.failedAttempts.length = 0 } },
          { name: 'flipper', onRunSummary(s) { s.exitOk = false } },
          { name: 'reader',
            onRecord(r) { if (r.kind === 'task.end') globalThis.__ro.attempts = r.failedAttempts.length },
            onRunSummary(s) { globalThis.__ro.exitOk = s.exitOk } },
        ] } }`,
    ),
  )
  const r = await run({ cwd: root, tasks: ['flaky'], log, handleSignals: false })
  expect(r.outcomes.map((o) => [o.node.id, o.status, o.failedAttempts?.length])).toEqual([
    ['c#flaky', 'success', 1],
  ])
  expect(r.ok).toBe(true)
  expect(seen()).toEqual({ attempts: 1, exitOk: true })
  expect(lines.filter((l) => /telemetry sink '(eraser|flipper)'/.test(l)).length).toBe(2)
})

it("a teardown's edit to the run report reaches no later plugin", async () => {
  await twoProjects(true)
  await plugins(
    pluginSource(
      'org/first',
      `{ teardown(report) { try { report.ok = false } catch {} ; try { report.tasks.length = 0 } catch {} } }`,
    ),
    pluginSource(
      'org/second',
      `{ teardown(report) { globalThis.__ro.report = [report.ok, report.tasks.length] } }`,
    ),
  )
  const r = await run({ cwd: root, tasks: ['build'], log, handleSignals: false })
  expect(r.ok).toBe(true)
  expect(seen()).toEqual({ report: [true, 2] })
})

// plugin.ts: "A run that ran to its end passes its `RunReport`; every
// other exit (a refused setup, a stop) passes none."
it('a stopped run passes teardown no report', async () => {
  await addProject(root, 'slow', {
    config: `export default { tasks: { wait: { exec: { command: 'touch up; exec sleep 30' } } } }`,
  })
  await plugins(
    pluginSource(
      'org/probe',
      `{ teardown(report) { globalThis.__ro.report = report === undefined ? 'none' : report.ok } }`,
    ),
  )
  const ac = new AbortController()
  const running = run({
    cwd: root,
    tasks: ['wait'],
    log,
    handleSignals: false,
    signal: ac.signal,
  })
  const up = Bun.file(path.join(root, 'packages/slow/up'))
  while (!(await up.exists())) await Bun.sleep(10)
  ac.abort('SIGINT')
  const r = await running
  expect(r.outcomes.map((o) => o.status)).toEqual(['aborted'])
  expect(seen()).toEqual({ report: 'none' })
}, 30_000)

// The key is derived before `schedule` and `admit` are asked: a command
// either hook rewrote ran under the declared one's key, its output saved
// as that task's.
const HIJACK = `'mkdir -p dist && echo hijacked > dist/a'`
const builtA = (a: string): string | null =>
  existsSync(path.join(a, 'dist/a')) ? readFileSync(path.join(a, 'dist/a'), 'utf8') : null

it('a schedule hook cannot rewrite the command a keyed task runs', async () => {
  const a = await twoProjects(true)
  await plugins(
    pluginSource(
      'org/hijack',
      `{ schedule(nodes) { nodes.get('a#build').config.exec.command = ${HIJACK} } }`,
    ),
  )
  const r = await run({
    cwd: root,
    tasks: ['build'],
    projects: ['a'],
    log,
    handleSignals: false,
  }).catch((err: unknown) => err)
  expect(builtA(a)).toBe(null)
  expect(String(r)).toMatch(/plugin 'org\/hijack' failed in schedule: .*read-?only/i)
})

it('an admit hook cannot rewrite the command a keyed task runs', async () => {
  const a = await twoProjects(true)
  await plugins(
    pluginSource(
      'org/hijack',
      `{ admit(task) { task.config.exec.command = ${HIJACK}; return true } }`,
    ),
  )
  await run({ cwd: root, tasks: ['build'], projects: ['a'], log, handleSignals: false })
  expect(builtA(a)).toBe('a\n')
})

it("an admit hook cannot move a task into another project's directory", async () => {
  const a = await twoProjects(true)
  await run({ cwd: root, tasks: ['build'], projects: ['a'], log, handleSignals: false })
  await plugins(
    pluginSource(
      'org/mover',
      `{ admit(task) { task.projectDir = ${JSON.stringify(a)}; return true } }`,
    ),
  )
  await run({ cwd: root, tasks: ['build'], projects: ['b'], log, handleSignals: false })
  expect(readFileSync(path.join(a, 'dist/a'), 'utf8')).toBe('a\n')
  expect(lines.filter((l) => l.includes("plugin 'org/mover'"))).toEqual([
    expect.stringMatching(/^\[vx\] plugin 'org\/mover' failed in admit: .*read-?only/i),
  ])
})

// The graph stage's directory guard has run by the key stage: a node a
// key hook moved ran, keyed and cleaned its outputs in another project.
it("a key hook cannot move a task into another project's directory", async () => {
  const a = await twoProjects(true)
  await run({ cwd: root, tasks: ['build'], projects: ['a'], log, handleSignals: false })
  await plugins(
    pluginSource(
      'org/mover',
      `{ key(task) { if (task.id === 'b#build') task.projectDir = ${JSON.stringify(a)} } }`,
    ),
  )
  const r = await run({ cwd: root, tasks: ['build'], log, handleSignals: false }).catch(
    (err: unknown) => err,
  )
  expect(readFileSync(path.join(a, 'dist/a'), 'utf8')).toBe('a\n')
  expect(String(r)).toMatch(/plugin 'org\/mover' failed in key: .*read-?only/i)
})

// The request's outputs are what core saves after the command: an executor
// that emptied them saved an empty artifact, which a later hit restored
// as the task's output.
it('an executor cannot change the outputs core saves', async () => {
  const a = await twoProjects(true)
  await plugins(
    pluginSource(
      'org/exec',
      `{ executor() { return { name: 'ex', async execute(req) {
          req.outputs.files.length = 0
          const p = Bun.spawnSync({ cmd: ['sh', '-c', req.command], cwd: req.cwd })
          return { exitCode: p.exitCode, durationMs: 1, stdout: '', stderr: '', violations: [] }
        } } } }`,
    ),
  )
  await run({ cwd: root, tasks: ['build'], projects: ['a'], log, handleSignals: false })
  await plugins()
  await rm(path.join(a, 'dist'), { recursive: true, force: true })
  await run({ cwd: root, tasks: ['build'], projects: ['a'], log, handleSignals: false })
  expect(readFileSync(path.join(a, 'dist/a'), 'utf8')).toBe('a\n')
})

// Two tasks declared alike share one config object, and the run shares
// its args after `--`: an executor's edit to its request's reached the
// next task, which ran with it under the key of what it declares.
it("an executor's edit to its request reaches no other task", async () => {
  const task = `export default { tasks: { t: { exec: { command: 'echo "$X" > out', env: { define: { X: 'good' } } } } } }`
  const a = await addProject(root, 'a', { config: task })
  const b = await addProject(root, 'b', { config: task })
  await plugins(
    pluginSource(
      'org/exec',
      `{ executor() { return { name: 'ex', accepts: (t) => t.taskId === 'a#t', async execute(req) {
          try { req.envDefine.X = 'evil' } catch {}
          try { req.forwardArgs.push('evil') } catch {}
          return { exitCode: 0, durationMs: 1, stdout: '', stderr: '', violations: [] }
        } } } }`,
    ),
  )
  await run({
    cwd: root,
    tasks: ['t'],
    forwardArgs: ['ok'],
    concurrency: 1,
    log,
    handleSignals: false,
  })
  expect(existsSync(path.join(a, 'out'))).toBe(false)
  expect(readFileSync(path.join(b, 'out'), 'utf8')).toBe('good ok\n')
})

/** The tasks of other projects a run (or its refusal: none) ran in project `name`'s `dir`. */
const strangersIn = (r: unknown, name: string, dir: string): string[] =>
  (
    (r as { outcomes?: { node: { id: string; projectName: string; projectDir: string } }[] })
      .outcomes ?? []
  )
    .filter((o) => o.node.projectDir === dir && o.node.projectName !== name)
    .map((o) => o.node.id)

// Core names, edges and checks what a discover hook returns: one that
// edited the list it was handed ran b's tasks in a's directory, past each
// check.
it("a discover hook cannot move a project into another's directory", async () => {
  const a = await twoProjects(true)
  await plugins(
    pluginSource(
      'org/mover',
      `{ discover(ctx) {
          const a = ctx.projects.find((p) => p.name === 'a')
          const b = ctx.projects.find((p) => p.name === 'b')
          b.dir = a.dir
          return []
        } }`,
    ),
  )
  const r = await run({ cwd: root, tasks: ['build'], log, handleSignals: false }).catch(
    (err: unknown) => err,
  )
  expect(strangersIn(r, 'a', a)).toEqual([])
  expect(String(r)).toMatch(/plugin 'org\/mover' failed in discover: .*read-?only/i)
})

it('a discover hook cannot add a project past the checks', async () => {
  const a = await twoProjects(true)
  await plugins(
    pluginSource(
      'org/adder',
      `{ discover(ctx) {
          ctx.projects.push({ ...ctx.projects.find((p) => p.name === 'b'), name: 'evil', dir: ${JSON.stringify(a)} })
          return []
        } }`,
    ),
  )
  const r = await run({ cwd: root, tasks: ['build'], log, handleSignals: false }).catch(
    (err: unknown) => err,
  )
  expect(strangersIn(r, 'a', a)).toEqual([])
  expect(String(r)).toMatch(/plugin 'org\/adder' failed in discover: .*read-?only/i)
})
