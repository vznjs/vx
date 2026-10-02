// `RunOptions.signal`: an embedder aborts a run from outside. The running
// child is SIGTERMed (SIGKILLed after the grace when it traps TERM), the
// never-started dependents complete `aborted`, and run() returns to its
// caller — the watch loop's Ctrl-C path, and the seam for any host that
// owns its process's signals instead of `handleSignals`.

import { rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { isAlive, waitForDead } from './helpers/alive.js'
import { addProject, makeWorkspace } from './helpers/workspace.js'
import { run, type Logger, type RunSummaryRecord } from '../src/orchestrator/index.js'
import { localWorkspaceSource } from './helpers/local-workspace.js'
import { pluginSource } from './helpers/plugin.js'

process.env['VX_KILL_GRACE_MS'] = '200'

const silent: Logger = { status() {}, taskStdout() {}, taskStderr() {}, taskComplete() {} }

async function waitForPid(file: string, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const f = Bun.file(file)
    if (await f.exists()) {
      const pid = Number((await f.text()).trim())
      if (Number.isInteger(pid) && pid > 0) return pid
    }
    await Bun.sleep(20)
  }
  throw new Error(`timed out waiting for a pid in ${file}`)
}

describe('RunOptions.signal aborts a run in flight', () => {
  let root: string
  beforeEach(async () => {
    root = await makeWorkspace({ prefix: 'vx-abort-' })
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('kills the running child, marks it and its dependents aborted, and returns', async () => {
    const dir = await addProject(
      root,
      'app',
      `
        export default {
          tasks: {
            slow: { exec: { command: 'echo $$ > pid.txt; exec sleep 30' } },
            after: { dependsOn: ['slow'], exec: { command: 'echo never' } },
          },
        }
      `,
    )
    const ac = new AbortController()
    const started = Date.now()
    const running = run({
      cwd: root,
      tasks: ['after'],
      projects: ['app'],
      log: silent,
      handleSignals: false,
      signal: ac.signal,
    })
    const pid = await waitForPid(path.join(dir, 'pid.txt'), 10_000)
    expect(isAlive(pid)).toBe(true)
    ac.abort()
    const r = await running
    expect(r.ok).toBe(false)
    expect(
      r.outcomes.map((o) => [o.node.id, o.status]).sort((a, b) => (a[0]! < b[0]! ? -1 : 1)),
    ).toEqual([
      ['app#after', 'aborted'],
      ['app#slow', 'aborted'],
    ])
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(await waitForDead(pid, 1_000)).toBe(true)
  }, 20_000)

  it('the summary a sink hears counts the aborted tasks, which its task list leaves out', async () => {
    // Aborted tasks are not real runs and stay out of `tasks`; without the
    // count a stopped run reads as a failure with nothing failed (item 851).
    await Bun.write(
      path.join(root, 'vx.workspace.mjs'),
      localWorkspaceSource([
        pluginSource(
          'org/summary-probe',
          `{ telemetry() { return { onRecord() {}, onRunSummary(s) { globalThis.__vxAbortSummary = s } } } }`,
        ),
      ]),
    )
    const dir = await addProject(
      root,
      'app',
      `
        export default {
          tasks: {
            slow: { exec: { command: 'echo $$ > pid.txt; exec sleep 30' } },
            after: { dependsOn: ['slow'], exec: { command: 'echo never' } },
          },
        }
      `,
    )
    const ac = new AbortController()
    const running = run({
      cwd: root,
      tasks: ['after'],
      projects: ['app'],
      log: silent,
      handleSignals: false,
      signal: ac.signal,
    })
    await waitForPid(path.join(dir, 'pid.txt'), 10_000)
    ac.abort()
    await running
    const s = (globalThis as { __vxAbortSummary?: RunSummaryRecord }).__vxAbortSummary!
    expect({
      exitOk: s.exitOk,
      failedCount: s.failedCount,
      abortedCount: s.abortedCount,
      tasks: s.tasks.length,
    }).toEqual({ exitOk: false, failedCount: 0, abortedCount: 2, tasks: 0 })
  }, 20_000)

  it('a child that ignores SIGTERM is SIGKILLed after the grace', async () => {
    const dir = await addProject(
      root,
      'app',
      `
        export default {
          tasks: {
            stubborn: { exec: { command: "trap '' TERM; echo $$ > pid.txt; exec sleep 30" } },
          },
        }
      `,
    )
    const ac = new AbortController()
    const running = run({
      cwd: root,
      tasks: ['stubborn'],
      projects: ['app'],
      log: silent,
      handleSignals: false,
      signal: ac.signal,
    })
    const pid = await waitForPid(path.join(dir, 'pid.txt'), 10_000)
    ac.abort()
    const r = await running
    expect(r.ok).toBe(false)
    expect(await waitForDead(pid, 1_000)).toBe(true)
  }, 20_000)

  // C-19: an abort names no signal, so the task hears SIGTERM; one that
  // forwarded SIGINT for it survived the suite.
  it('an embedder abort reaches the task as SIGTERM', async () => {
    const dir = await addProject(
      root,
      'app',
      `export default { tasks: { t: { exec: {
        command: "trap 'echo SIGINT > got.txt; exit 0' INT; trap 'echo SIGTERM > got.txt; exit 0' TERM; echo $$ > pid.txt; while :; do sleep 0.05; done",
      } } } }`,
    )
    const ac = new AbortController()
    // The trap is the subject: a long grace keeps the SIGKILL off it.
    process.env['VX_KILL_GRACE_MS'] = '5000'
    try {
      const running = run({
        cwd: root,
        tasks: ['t'],
        projects: ['app'],
        log: silent,
        handleSignals: false,
        signal: ac.signal,
      })
      await waitForPid(path.join(dir, 'pid.txt'), 10_000)
      ac.abort()
      expect((await running).ok).toBe(false)
    } finally {
      process.env['VX_KILL_GRACE_MS'] = '200'
    }
    expect(await Bun.file(path.join(dir, 'got.txt')).text()).toBe('SIGTERM\n')
  }, 20_000)

  it('an already-aborted signal runs nothing: every task completes aborted', async () => {
    await addProject(
      root,
      'app',
      `
        export default {
          tasks: { hello: { exec: { command: 'echo hello > ran.txt' } } },
        }
      `,
    )
    const ac = new AbortController()
    ac.abort()
    const r = await run({
      cwd: root,
      tasks: ['hello'],
      projects: ['app'],
      log: silent,
      handleSignals: false,
      signal: ac.signal,
    })
    expect(r.ok).toBe(false)
    expect(r.outcomes.map((o) => o.status)).toEqual(['aborted'])
    expect(await Bun.file(path.join(root, 'packages', 'app', 'ran.txt')).exists()).toBe(false)
  }, 20_000)

  // C-65: a runtime probe still running when the run stopped held it until
  // the probe ended (a Ctrl-C waited out the signal bound, ~7 s), and the
  // task read failed for the probe the stop cut short.
  it('the stop kills a running cache.inputs.runtime probe; the task is aborted', async () => {
    const dir = await addProject(
      root,
      'app',
      `export default { tasks: { t: {
        exec: { command: 'true' },
        cache: { inputs: { files: ['package.json'], runtime: ['echo $$ > probe.pid; exec sleep 30'] }, outputs: { files: [] } },
      } } }`,
    )
    const ac = new AbortController()
    const running = run({
      cwd: root,
      tasks: ['t'],
      projects: ['app'],
      log: silent,
      handleSignals: false,
      signal: ac.signal,
    })
    const pid = await waitForPid(path.join(dir, 'probe.pid'), 10_000)
    ac.abort()
    const r = await running
    expect(r.outcomes.map((o) => o.status)).toEqual(['aborted'])
    expect(await waitForDead(pid, 1_000)).toBe(true)
  }, 20_000)

  // C-62: a server the stop killed while it started read `failed (never
  // ready: exited)` with a recap, where every other task the stop kills
  // is aborted.
  it('a server still starting when the run stops is aborted, not failed', async () => {
    const dir = await addProject(
      root,
      'app',
      `export default { tasks: { srv: { exec: {
        command: 'echo $$ > pid.txt; sleep 3; echo READY; exec sleep 30',
        persistent: { readyWhen: 'READY' },
      } } } }`,
    )
    const ac = new AbortController()
    const running = run({
      cwd: root,
      tasks: ['srv'],
      projects: ['app'],
      log: silent,
      handleSignals: false,
      signal: ac.signal,
    })
    const pid = await waitForPid(path.join(dir, 'pid.txt'), 10_000)
    ac.abort()
    const r = await running
    expect(r.outcomes.map((o) => [o.status, o.notReady])).toEqual([['aborted', undefined]])
    expect(await waitForDead(pid, 1_000)).toBe(true)
  }, 20_000)

  // C-65: probes are the run's own. Two runs in one process (an embedder's
  // daemon, the `inflight` case): stopping one kills its probe, not the
  // other's, whose task still answers.
  it("one run's stop leaves another run's runtime probe alone", async () => {
    const config = (pidFile: string, rest: string) => `export default { tasks: { t: {
      exec: { command: 'true' },
      cache: { inputs: { files: ['package.json'], runtime: ['echo $$ > ${pidFile}; ${rest}'] }, outputs: { files: [] } },
    } } }`
    const a = await addProject(root, 'app', config('probe.pid', 'exec sleep 30'))
    const otherRoot = await makeWorkspace({ prefix: 'vx-abort-other-' })
    try {
      const b = await addProject(otherRoot, 'app', config('probe.pid', 'sleep 1; echo v1'))
      const ac = new AbortController()
      const runA = run({
        cwd: root,
        tasks: ['t'],
        projects: ['app'],
        log: silent,
        handleSignals: false,
        signal: ac.signal,
      })
      const runB = run({
        cwd: otherRoot,
        tasks: ['t'],
        projects: ['app'],
        log: silent,
        handleSignals: false,
      })
      await waitForPid(path.join(a, 'probe.pid'), 10_000)
      await waitForPid(path.join(b, 'probe.pid'), 10_000)
      ac.abort()
      expect((await runA).outcomes.map((o) => o.status)).toEqual(['aborted'])
      expect((await runB).outcomes.map((o) => o.status)).toEqual(['success'])
    } finally {
      await rm(otherRoot, { recursive: true, force: true })
    }
  }, 20_000)

  // C-46: a stopped run's servers are already being torn down, so a
  // `holdPersistent` caller (the watch loop) is handed none: it would own
  // a stop() for a server that is going anyway.
  it('a stopped holdPersistent run hands back no server', async () => {
    const dir = await addProject(
      root,
      'app',
      `
        export default {
          tasks: {
            srv: { exec: { command: 'echo $$ > pid.txt; echo READY; exec sleep 30', persistent: { readyWhen: 'READY' } } },
            e2e: { dependsOn: ['srv'], exec: { command: 'echo up > e2e.up; exec sleep 30' } },
          },
        }
      `,
    )
    const ac = new AbortController()
    const running = run({
      cwd: root,
      tasks: ['srv', 'e2e'],
      projects: ['app'],
      log: silent,
      handleSignals: false,
      holdPersistent: true,
      signal: ac.signal,
    })
    const pid = await waitForPid(path.join(dir, 'pid.txt'), 10_000)
    const up = Bun.file(path.join(dir, 'e2e.up'))
    const deadline = Date.now() + 10_000
    while (!((await up.exists()) && (await up.text()) === 'up\n') && Date.now() < deadline)
      await Bun.sleep(20)
    ac.abort()
    const r = await running
    expect([r.ok, r.persistent]).toEqual([false, undefined])
    expect(await waitForDead(pid, 1_000)).toBe(true)
  }, 20_000)
})
