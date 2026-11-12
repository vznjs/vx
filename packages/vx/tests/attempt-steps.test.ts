// The parts one attempt of a miss is built from, each on its own: its
// stream (attempt-stream.ts), its signal (attempt-signal.ts), the task's
// secrets (task-secrets.ts) and the outcome a miss adds up to
// (miss-outcome.ts).
import { describe, expect, it } from 'bun:test'
import type { TaskConfig } from '../src/config.js'
import type { CacheLayer } from '../src/cache/index.js'
import type { TaskNode } from '../src/graph/index.js'
import type { ExecuteArgs } from '../src/orchestrator/execute-task.js'
import type { Attempts } from '../src/orchestrator/attempts.js'
import { AttemptSignal } from '../src/orchestrator/attempt-signal.js'
import { AttemptStream } from '../src/orchestrator/attempt-stream.js'
import type { MissRun } from '../src/orchestrator/miss-run.js'
import { missOutcome } from '../src/orchestrator/miss-outcome.js'
import { taskPolicy } from '../src/orchestrator/task-policy.js'
import { TaskSecrets } from '../src/orchestrator/task-secrets.js'
import { localExecutor } from '../src/orchestrator/local-executor.js'

const cached: TaskConfig = {
  exec: { command: 'build' },
  cache: true,
  inputs: { files: ['src/**'] },
  outputs: { files: ['dist/**'] },
}

const node = {
  id: 'p#build',
  projectName: 'p',
  projectDir: '/ws/p',
  taskName: 'build',
  config: cached,
  deps: [],
  requested: true,
} as TaskNode

function logged(): { log: ExecuteArgs['log']; out: string[]; err: string[]; warned: string[] } {
  const out: string[] = []
  const err: string[] = []
  const warned: string[] = []
  const log = {
    taskStdout: (_: TaskNode, t: string) => out.push(t),
    taskStderr: (_: TaskNode, t: string) => err.push(t),
    warn: (l: string) => warned.push(l),
  } as unknown as ExecuteArgs['log']
  return { log, out, err, warned }
}

function args(over: Partial<ExecuteArgs> = {}): ExecuteArgs {
  return {
    node,
    upstream: [],
    workspaceRoot: '/ws',
    cache: { hasRemote: false } as unknown as CacheLayer,
    log: logged().log,
    executor: { name: 'remote', remote: true, execute: async () => ({}) } as never,
    nestedProjectDirs: [],
    runStartHrTimeNs: 0n,
    keyedProjects: () => new Set(),
    ...over,
  }
}

describe('AttemptStream: one attempt’s output', () => {
  it('streams both outputs in order and keeps them', () => {
    const { log, out, err } = logged()
    const s = new AttemptStream(node, log)
    const cb = s.open(true, null)
    cb.onStdout('a\n')
    cb.onStderr('b')
    expect([out, err]).toEqual([['a\n'], ['b']])
    expect(s.midLine).toBe(true)
    expect(s.nl()).toBe('\n')
    expect(s.errTail).toBe('b')
    expect(s.stored(null)).toContain('a\n')
  })

  it('a new attempt starts a new capture; a withdrawn one puts the last back', () => {
    const s = new AttemptStream(node, logged().log)
    s.open(true, null).onStdout('first\n')
    const before = s.snapshot()
    s.open(true, null).onStdout('second\n')
    expect(s.stored(null)).not.toContain('first')
    s.restore(before)
    expect(s.stored(null)).toContain('first')
  })

  it('a failure-only capture keeps the head and the tail', () => {
    const s = new AttemptStream(node, logged().log)
    const cb = s.open(false, null)
    cb.onStdout('x'.repeat(1_000_000))
    expect(s.stored(null).length).toBeLessThan(1_000_000)
  })
})

describe('AttemptSignal: what aborts an attempt’s request', () => {
  it('the run’s stop aborts it, with the stop’s reason', () => {
    const stop = new AbortController()
    const sig = new AttemptSignal(args({ stopSignal: stop.signal }), undefined)
    const s = sig.request(false)
    stop.abort('SIGINT')
    expect([s.aborted, s.reason]).toEqual([true, 'SIGINT'])
  })

  it('a plugin executor’s timeout aborts it; the local floor keeps its own clock', async () => {
    const sig = new AttemptSignal(args(), 5)
    const s = sig.request(false)
    await Bun.sleep(30)
    expect([s.aborted, sig.timeoutFired]).toEqual([true, true])
    const local = new AttemptSignal(args(), 5)
    const l = local.request(true)
    await Bun.sleep(30)
    expect([l.aborted, local.timeoutFired]).toEqual([false, false])
  })

  it('settle drops the timer: a settled attempt is never timed out', async () => {
    const sig = new AttemptSignal(args(), 5)
    const s = sig.request(false)
    sig.settle()
    await Bun.sleep(30)
    expect(s.aborted).toBe(false)
  })

  it('fail-fast withdraws an attempt its executor has not begun, and only then', () => {
    const failFast = new AbortController()
    let begun: string | null = null
    const executor = { name: 'remote', remote: true, running: () => begun } as never
    const sig = new AttemptSignal(args({ failFast: failFast.signal, executor }), undefined)
    const s = sig.request(false)
    failFast.abort()
    expect([s.aborted, sig.unbegun]).toEqual([true, true])
    const failFast2 = new AbortController()
    begun = 'machine-1'
    const sig2 = new AttemptSignal(args({ failFast: failFast2.signal, executor }), undefined)
    const s2 = sig2.request(false)
    failFast2.abort()
    expect([s2.aborted, sig2.unbegun]).toEqual([false, false])
  })

  it('an executor that ignores the abort is abandoned after the grace', async () => {
    process.env['VX_TEST_KILL_GRACE'] = '10ms'
    try {
      const stop = new AbortController()
      const said: string[] = []
      const sig = new AttemptSignal(args({ stopSignal: stop.signal }), undefined)
      const s = sig.request(false)
      const never = new Promise<unknown>(() => {})
      const bounded = sig.bound(never, s, (l) => said.push(l))
      stop.abort('SIGTERM')
      const r = (await bounded) as { leftRunning?: boolean; exitCode: number }
      expect(r.leftRunning).toBe(true)
      expect(r.exitCode).toBe(143)
      expect(said.join('')).toContain('abandoned')
    } finally {
      delete process.env['VX_TEST_KILL_GRACE']
    }
  })

  it('the local floor is never bounded: it kills its own process group', () => {
    const running = Promise.resolve(1)
    const sig = new AttemptSignal(args({ executor: localExecutor() }), undefined)
    expect(sig.bound(running, new AbortController().signal, () => {})).toBe(running)
  })
})

describe('TaskSecrets: what a task’s output masks', () => {
  it('masks a secret-named variable’s value in text', () => {
    const s = new TaskSecrets({ API_TOKEN: 'hunter2-hunter2' }, { command: 'x' })
    expect(s.text('token hunter2-hunter2 here')).not.toContain('hunter2-hunter2')
    expect(new TaskSecrets({}, { command: 'x' }).text('plain')).toBe('plain')
  })
})

describe('missOutcome: what a miss adds up to', () => {
  function outcomeOf(over: {
    exitCode?: number
    check?: Parameters<typeof missOutcome>[2]
    args?: Partial<ExecuteArgs>
  }) {
    const { log, warned } = logged()
    const a = args({ log, ...over.args })
    const m = {
      args: a,
      policy: taskPolicy(a),
      hash: 'k',
      inputs: { captured: [], described: undefined, inputChanges: undefined },
      stream: new AttemptStream(node, log),
      secrets: new TaskSecrets({}, { command: 'x' }),
      sandbox: { violations: [], upstreamOutputs: [] },
      load: {},
    } as unknown as MissRun
    const ran: Attempts = {
      result: { exitCode: 0, durationMs: 1, stdout: '', stderr: '', violations: [] },
      exitCode: over.exitCode ?? 0,
      attempts: 1,
      spentMs: 7,
      failedAttempts: [],
      attemptOutputs: [],
      leftRunning: false,
    }
    const o = missOutcome(
      m,
      ran,
      over.check ?? { unkeyed: false },
      { saved: true },
      {
        startNs: 1n,
        endNs: 2n,
      },
    )
    return { o, warned }
  }

  it('a pass: success, saved, timed by every attempt', () => {
    const { o } = outcomeOf({})
    expect(o).toMatchObject({
      status: 'success',
      exitCode: 0,
      saved: true,
      durationMs: 7,
      hash: 'k',
    })
  })

  it("inputs.stability.severity 'error' fails a pass whose input moved", () => {
    const { o } = outcomeOf({ check: { unkeyed: true, drifted: '/ws/p/a', movedFails: 'p/a' } })
    expect(o).toMatchObject({
      status: 'failed',
      exitCode: 1,
      unkeyed: true,
      driftedInput: '/ws/p/a',
      inputMoved: 'p/a',
    })
  })

  it('a pass over a keyless upstream says why it is not saved', () => {
    const { o, warned } = outcomeOf({
      args: { node: { ...node, config: { exec: { command: 'build' }, cache: true } } },
    })
    expect(o.keylessBy).toBe('p#build')
    expect(warned.join('\n')).toContain('declares no `inputs`')
  })
})
