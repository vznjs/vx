import { describe, expect, it } from 'bun:test'
import {
  analyticBaseline,
  assertTraceConformance,
  cliCacheHits,
  counterexampleEnv,
  counterexampleFixtureFiles,
  counterexampleShape,
  createCounterexampleAttempt,
  nativeExecutableFormat,
  parseCounterexampleOptions,
  renderCounterexampleReport,
  runCounterexampleAttempt,
  summarizeCounterexample,
  turboNativeExecutableSpec,
  type TraceEvent,
} from '../counterexample.js'
import { priorities, simulate, type SimTask } from '../schedule-policy.js'

const expectedTasks: SimTask[] = [
  { id: 'a-long', dur: 60_000, deps: [] },
  { id: 'b-left', dur: 29_750, deps: ['f-left-gate'] },
  { id: 'c-right', dur: 29_750, deps: ['g-right-gate'] },
  { id: 'd-left-child', dur: 250, deps: ['b-left'] },
  { id: 'e-right-child', dur: 250, deps: ['c-right'] },
  { id: 'f-left-gate', dur: 0, deps: [] },
  { id: 'g-right-gate', dur: 0, deps: [] },
]

// Explicit observed events, not generated from the baseline/witness being tested.
function conformingRun() {
  const event = (
    id: string,
    phase: 'start' | 'end',
    ms: number,
    durationMs: number,
    pid: number,
  ): TraceEvent => ({ id, phase, monotonicNs: String(BigInt(ms) * 1_000_000n), durationMs, pid })
  return {
    exitCode: 0,
    cacheHits: 0,
    events: [
      event('a-long', 'start', 0, 60_000, 1),
      event('b-left', 'start', 0, 29_750, 2),
      event('b-left', 'end', 29_750, 29_750, 2),
      event('d-left-child', 'start', 29_750, 250, 3),
      event('d-left-child', 'end', 30_000, 250, 3),
      event('c-right', 'start', 30_000, 29_750, 4),
      event('c-right', 'end', 59_750, 29_750, 4),
      event('e-right-child', 'start', 59_750, 250, 5),
      event('e-right-child', 'end', 60_000, 250, 5),
      event('a-long', 'end', 60_000, 60_000, 1),
    ],
    outputs: {
      'a-long.json': '{"id":"a-long","durationMs":60000}\n',
      'b-left.json': '{"id":"b-left","durationMs":29750}\n',
      'c-right.json': '{"id":"c-right","durationMs":29750}\n',
      'd-left-child.json': '{"id":"d-left-child","durationMs":250}\n',
      'e-right-child.json': '{"id":"e-right-child","durationMs":250}\n',
    } as Record<string, string>,
  }
}

describe('counterexample shape and exact ideal', () => {
  it('has five heterogeneous costs, two zero root gates and exactly four declared edges', () => {
    expect(counterexampleShape()).toEqual(expectedTasks)
    expect(counterexampleShape(2, 0.1)).toEqual([
      { id: 'a-long', dur: 2000, deps: [] },
      { id: 'b-left', dur: 900, deps: ['f-left-gate'] },
      { id: 'c-right', dur: 900, deps: ['g-right-gate'] },
      { id: 'd-left-child', dur: 100, deps: ['b-left'] },
      { id: 'e-right-child', dur: 100, deps: ['c-right'] },
      { id: 'f-left-gate', dur: 0, deps: [] },
      { id: 'g-right-gate', dur: 0, deps: [] },
    ])
  })

  it('attains the work and critical-path lower bounds with an explicit feasible witness', () => {
    const baseline = analyticBaseline()
    expect(baseline.concurrency).toBe(2)
    expect(baseline.caseLabel).toBe('two commandless readiness gates')
    expect(baseline.dagNodes).toBe(7)
    expect(baseline.executableTasks).toBe(5)
    expect(baseline.commandlessGates).toEqual(['f-left-gate', 'g-right-gate'])
    expect(expectedTasks.reduce((sum, task) => sum + task.dur, 0)).toBe(120_000)
    expect(baseline.workMs).toBe(120_000)
    expect(baseline.workBoundMs).toBe(60_000)
    expect(baseline.criticalPathMs).toBe(60_000)
    expect(baseline.idealMs).toBe(60_000)
    expect(baseline.witness).toEqual([
      { id: 'f-left-gate', worker: 0, startMs: 0, endMs: 0 },
      { id: 'g-right-gate', worker: 0, startMs: 0, endMs: 0 },
      { id: 'a-long', worker: 0, startMs: 0, endMs: 60_000 },
      { id: 'b-left', worker: 1, startMs: 0, endMs: 29_750 },
      { id: 'd-left-child', worker: 1, startMs: 29_750, endMs: 30_000 },
      { id: 'c-right', worker: 1, startMs: 30_000, endMs: 59_750 },
      { id: 'e-right-child', worker: 1, startMs: 59_750, endMs: 60_000 },
    ])
    const spans = baseline.witness
    for (const task of expectedTasks) {
      const span = spans.find((entry) => entry.id === task.id)!
      expect(span.endMs - span.startMs).toBe(task.dur)
      for (const dep of task.deps)
        expect(span.startMs).toBeGreaterThanOrEqual(spans.find((entry) => entry.id === dep)!.endMs)
    }
    for (const worker of [0, 1]) {
      const assigned = spans
        .filter((span) => span.worker === worker)
        .sort((a, b) => a.startMs - b.startMs)
      for (let i = 1; i < assigned.length; i++)
        expect(assigned[i]!.startMs).toBeGreaterThanOrEqual(assigned[i - 1]!.endMs)
    }
    expect(analyticBaseline(2, 0.1).idealMs).toBe(2000)
    expect(analyticBaseline(2, 0.1).workMs).toBe(4000)
  })

  it('FIFO beats the real count ranking when downstream counts hide heterogeneous costs', () => {
    const tasks = counterexampleShape()
    const count = priorities('count', tasks, new Set())
    expect(Object.fromEntries(count)).toEqual({
      'a-long': 0,
      'b-left': 1,
      'c-right': 1,
      'd-left-child': 0,
      'e-right-child': 0,
      'f-left-gate': 2,
      'g-right-gate': 2,
    })
    const fifo = simulate(tasks, new Map(), 2)
    const ranked = simulate(tasks, count, 2)
    expect(fifo.order).toEqual([
      'a-long',
      'f-left-gate',
      'g-right-gate',
      'b-left',
      'c-right',
      'd-left-child',
      'e-right-child',
    ])
    expect(fifo.makespan).toBe(60_000)
    expect(ranked.order).toEqual([
      'f-left-gate',
      'g-right-gate',
      'b-left',
      'c-right',
      'a-long',
      'd-left-child',
      'e-right-child',
    ])
    expect(ranked.makespan).toBe(89_750)
    expect(ranked.makespan - analyticBaseline().idealMs).toBe(29_750)
    expect(ranked.makespan / fifo.makespan).toBeLessThan(1.5)
  })

  it('keeps the original minimal five-node graph as a separate analytic control, not a filtered dataset', () => {
    const minimal: SimTask[] = [
      { id: 'a-long', dur: 60_000, deps: [] },
      { id: 'b-left', dur: 29_750, deps: [] },
      { id: 'c-right', dur: 29_750, deps: [] },
      { id: 'd-left-child', dur: 250, deps: ['b-left'] },
      { id: 'e-right-child', dur: 250, deps: ['c-right'] },
    ]
    expect(simulate(minimal, new Map(), 2).makespan).toBe(60_000)
    expect(simulate(minimal, priorities('count', minimal, new Set()), 2).makespan).toBe(89_750)
    expect(analyticBaseline().predecessor).toEqual({
      caseLabel: 'minimal five-task DAG without readiness gates',
      sourceCommit: 'd2095b889ef5915a5ba73c964599d3ad7b1ad478',
      artifacts: [
        'counterexample-preliminary-results.json',
        'COUNTEREXAMPLE-PRELIMINARY.md',
        'counterexample-preliminary-samples.jsonl',
      ],
      comparisonPolicy:
        'The earlier case, including adverse Turborepo runs, stays separate and unchanged. Do not replace, pool, or filter its samples when measuring this different shared DAG.',
    })
  })

  it('keeps the control: count beats FIFO on an equal-cost chain beside independent tasks', () => {
    const tasks: SimTask[] = [
      { id: 'single1', dur: 1000, deps: [] },
      { id: 'single2', dur: 1000, deps: [] },
      { id: 'single3', dur: 1000, deps: [] },
      { id: 'chain1', dur: 1000, deps: [] },
      { id: 'chain2', dur: 1000, deps: ['chain1'] },
      { id: 'chain3', dur: 1000, deps: ['chain2'] },
    ]
    expect(simulate(tasks, new Map(), 2).makespan).toBe(4000)
    expect(simulate(tasks, priorities('count', tasks, new Set()), 2).makespan).toBe(3000)
  })

  it('rejects invalid or unrepresentable durations, rather than quietly changing the model', () => {
    for (const [long, leaf] of [
      [0, 0.25],
      [1, 0.5],
      [1, -1],
      [NaN, 0.25],
      [Infinity, 0.25],
      [1, 0.0001],
      [3_000_000, 1],
    ]) {
      expect(() => counterexampleShape(long, leaf)).toThrow('durations require')
    }
  })
})

describe('CLI and native fixture equivalence', () => {
  it('defaults to five rounds and parses smoke options without executing main', () => {
    expect(parseCounterexampleOptions([], '/bench')).toEqual({
      longSeconds: 60,
      leafSeconds: 0.25,
      reps: 5,
      noiseMs: 1,
      output: '/bench',
    })
    const options = parseCounterexampleOptions(
      ['--long=2', '--leaf', '0.1', '--reps=2', '--noise-ms', '3', '--output', '/smoke'],
      '/bench',
    )
    expect(options).toEqual({
      longSeconds: 2,
      leafSeconds: 0.1,
      reps: 2,
      noiseMs: 3,
      output: '/smoke',
    })
    for (const argv of [
      ['--reps', '0'],
      ['--reps', '1.5'],
      ['--noise-ms=-1'],
      ['--long=NaN'],
      ['--leaf'],
      ['--long', '--reps'],
      ['--reps=1', '--reps=2'],
      ['--bogus=1'],
    ]) {
      expect(() => parseCounterexampleOptions(argv, '/bench')).toThrow()
    }
  })

  it('uses identical package commands, edges, explicit inputs and distinct outputs', () => {
    const files = counterexampleFixtureFiles(expectedTasks, true)
    const root = JSON.parse(files['package.json'])
    const pkg = JSON.parse(files['packages/job/package.json'])
    const turbo = JSON.parse(files['turbo.json'])
    const vx = JSON.parse(files['packages/job/vx.config.mjs'].replace('export default ', ''))
    expect(root.packageManager).toBe('bun@1.4.2')
    expect(root.devDependencies).toEqual({ turbo: '2.11.7' })
    expect(root.scripts).toBeUndefined()
    expect(pkg.name).toBe('@bench/counterexample')
    expect(Object.keys(pkg.scripts)).toEqual([
      'a-long',
      'b-left',
      'c-right',
      'd-left-child',
      'e-right-child',
    ])
    expect(Object.keys(vx.tasks)).toEqual([
      'a-long',
      'b-left',
      'c-right',
      'd-left-child',
      'e-right-child',
      'f-left-gate',
      'g-right-gate',
    ])
    expect(Object.keys(turbo.tasks)).toEqual(Object.keys(vx.tasks))
    for (const task of expectedTasks) {
      expect(vx.tasks[task.id].dependsOn).toEqual(task.deps)
      expect(turbo.tasks[task.id].dependsOn).toEqual(task.deps)
      if (task.dur === 0) {
        expect(pkg.scripts[task.id]).toBeUndefined()
        expect(vx.tasks[task.id]).toEqual({ dependsOn: [] })
        expect(turbo.tasks[task.id]).toEqual({ dependsOn: [] })
        continue
      }
      expect(pkg.scripts[task.id]).toBe(
        `bun --no-env-file --no-install src/task.mjs ${task.id} ${task.dur}`,
      )
      expect(vx.tasks[task.id].exec.command).toBe(pkg.scripts[task.id])
      expect(vx.tasks[task.id].cache.inputs.files).toEqual(['src/**'])
      expect(turbo.tasks[task.id].inputs).toEqual(['src/**'])
      expect(vx.tasks[task.id].cache.outputs.files).toEqual([`dist/${task.id}.json`])
      expect(turbo.tasks[task.id].outputs).toEqual([`dist/${task.id}.json`])
    }
    expect(files['vx.workspace.mjs']).toBe('export default { plugins: [] }\n')
    expect(files['.gitignore'].split('\n')).toContain('.bench')
    const taskSource = files['packages/job/src/task.mjs']
    expect(taskSource).toContain('clock_gettime')
    expect(taskSource).toContain('monotonicNs: nowNs().toString()')
    expect(taskSource).not.toContain('monotonicNs: process.hrtime')
    expect(taskSource).toContain("event('start')")
    expect(taskSource).toContain("event('end')")
    expect(new Bun.Transpiler({ loader: 'js' }).transformSync(taskSource)).toContain(
      'clock_gettime',
    )
    expect(
      JSON.parse(counterexampleFixtureFiles(expectedTasks, false)['package.json']).devDependencies,
    ).toBeUndefined()
  })

  it('does not inherit secrets, remote caches, runtime options or scheduler plugins', () => {
    const env = counterexampleEnv(
      {
        PATH: '/bin',
        TURBO_TOKEN: 'secret',
        TURBO_API: 'secret',
        TURBO_TEAM: 'secret',
        TURBO_REMOTE_ONLY: '1',
        BUN_OPTIONS: '--smol',
        BUN_PRELOAD: 'secret',
        NODE_OPTIONS: '--require secret',
        NODE_PATH: 'secret',
        VX_CACHE_DIR: 'secret',
        VX_CONCURRENCY: '99',
        AWS_SECRET_ACCESS_KEY: 'secret',
      },
      '/isolated-home',
      '/exact-bun',
    )
    expect(env['HOME']).toBe('/isolated-home')
    expect(env['PATH']).toStartWith('/exact-bun')
    expect(env['TURBO_TELEMETRY_DISABLED']).toBe('1')
    expect(env['CI']).toBe('1')
    expect(Object.values(env)).not.toContain('secret')
    for (const name of [
      'TURBO_TOKEN',
      'TURBO_API',
      'TURBO_TEAM',
      'TURBO_REMOTE_ONLY',
      'BUN_OPTIONS',
      'BUN_PRELOAD',
      'NODE_OPTIONS',
      'NODE_PATH',
      'VX_CACHE_DIR',
      'VX_CONCURRENCY',
      'AWS_SECRET_ACCESS_KEY',
    ])
      expect(env[name]).toBeUndefined()
  })

  it('counts five executable tasks in CLI summaries, not the two commandless groups', () => {
    expect(cliCacheHits('vx', '5 success · 5 total\n5 miss', '')).toBe(0)
    expect(cliCacheHits('vx', '7 success · 7 total\n5 miss', '')).toBeNull()
    expect(cliCacheHits('turbo', 'Cached: 0 cached, 7 total', '')).toBeNull()
    expect(cliCacheHits('vx', '5 success · 5 total\n5 miss · 1 up-to-date', '')).toBe(1)
    expect(cliCacheHits('vx', 'no summary', '')).toBeNull()
    expect(cliCacheHits('turbo', 'Cached: 0 cached, 5 total', '')).toBe(0)
    expect(cliCacheHits('turbo', '', 'Cached: 1 cached, 5 total')).toBe(1)
    expect(cliCacheHits('turbo', 'Cached: 0 cached, 4 total', '')).toBeNull()
    const esc = String.fromCharCode(27)
    expect(cliCacheHits('turbo', `${esc}[32mCached: 0 cached, 5 total${esc}[0m`, '')).toBe(0)
  })
})

describe('native Turborepo resolution', () => {
  const pkg = {
    name: 'turbo',
    version: '2.11.7',
    optionalDependencies: {
      '@turbo/darwin-64': '2.11.7',
      '@turbo/darwin-arm64': '2.11.7',
      '@turbo/linux-64': '2.11.7',
      '@turbo/linux-arm64': '2.11.7',
      '@turbo/windows-64': '2.11.7',
      '@turbo/windows-arm64': '2.11.7',
    },
  }

  it('selects declared pinned native optional dependencies for each supported host, never .bin/turbo', () => {
    for (const [platform, arch, packageName] of [
      ['darwin', 'x64', '@turbo/darwin-64'],
      ['darwin', 'arm64', '@turbo/darwin-arm64'],
      ['linux', 'x64', '@turbo/linux-64'],
      ['linux', 'arm64', '@turbo/linux-arm64'],
    ] as const) {
      expect(turboNativeExecutableSpec(pkg, platform, arch)).toEqual({
        packageName,
        version: '2.11.7',
        executable: `${packageName}/bin/turbo`,
      })
    }
  })

  it('fails closed for absent/unpinned dependencies, package mismatches and unsupported hosts', () => {
    for (const modified of [
      { ...pkg, version: '2.11.6' },
      { ...pkg, name: 'not-turbo' },
      { ...pkg, optionalDependencies: {} },
      { ...pkg, optionalDependencies: { '@turbo/darwin-arm64': '^2.11.7' } },
      { ...pkg, optionalDependencies: { '@turbo/darwin-64': '2.11.7' } },
    ])
      expect(() => turboNativeExecutableSpec(modified, 'darwin', 'arm64')).toThrow()
    expect(() => turboNativeExecutableSpec(pkg, 'win32', 'x64')).toThrow('unsupported native')
    expect(() => turboNativeExecutableSpec(pkg, 'linux', 'ia32')).toThrow('unsupported native')
  })

  it('uses legacy naming only if actually declared, preferring the scoped package when both exist', () => {
    const legacy = { ...pkg, optionalDependencies: { 'turbo-linux-64': '2.11.7' } }
    expect(turboNativeExecutableSpec(legacy, 'linux', 'x64').executable).toBe(
      'turbo-linux-64/bin/turbo',
    )
    expect(
      turboNativeExecutableSpec(
        {
          ...pkg,
          optionalDependencies: { ...pkg.optionalDependencies, 'turbo-linux-64': '2.11.7' },
        },
        'linux',
        'x64',
      ).packageName,
    ).toBe('@turbo/linux-64')
  })

  it('recognizes ELF and thin/universal Mach-O headers without platform installation', () => {
    expect(nativeExecutableFormat(Uint8Array.from([0x7f, 0x45, 0x4c, 0x46, 2]))).toBe('ELF')
    for (const magic of [
      'feedface',
      'cefaedfe',
      'feedfacf',
      'cffaedfe',
      'cafebabe',
      'bebafeca',
      'cafebabf',
      'bfbafeca',
    ])
      expect(nativeExecutableFormat(Buffer.from(magic, 'hex'))).toBe('Mach-O')
  })

  it('rejects Node/shell launchers, empty/truncated headers, PE and arbitrary bytes', () => {
    for (const bytes of [
      Buffer.from('#!/usr/bin/env node\n'),
      Buffer.from('#!/bin/sh\n'),
      Buffer.from('console.log("2.11.7")'),
      new Uint8Array(),
      Uint8Array.from([0x7f, 0x45, 0x4c]),
      Buffer.from('MZ..'),
      Buffer.from('00000000', 'hex'),
    ])
      expect(() => nativeExecutableFormat(bytes)).toThrow('native ELF/Mach-O')
  })
})

describe('attempt journaling without subprocesses', () => {
  const create = () =>
    createCounterexampleAttempt({
      argv: ['/native/vx', 'run', 'a-long'],
      cwd: '/fixture',
      runner: 'vx',
      round: 1,
      position: 1,
      cacheDir: '/fixture/.bench/cache/1-vx',
    })
  const snapshot = (attempt: ReturnType<typeof create>) =>
    JSON.parse(JSON.stringify(attempt)) as ReturnType<typeof create>

  it('writes a planned attempt before execution and then its full terminal record', async () => {
    const sample = create()
    const journal: ReturnType<typeof create>[] = []
    const order: string[] = []
    await runCounterexampleAttempt(sample, {
      journal: async (attempt) => {
        order.push(`journal:${attempt.state}`)
        journal.push(snapshot(attempt))
      },
      execute: async (attempt) => {
        expect(journal).toHaveLength(1)
        expect(journal[0]).toMatchObject({
          attemptId: '1-vx',
          state: 'planned',
          pid: null,
          exitCode: null,
          elapsedMs: null,
        })
        order.push('execute')
        Object.assign(attempt, {
          pid: 42,
          exitCode: 0,
          elapsedMs: 123,
          stdout: 'captured stdout',
          cpu: { userMs: 1, systemMs: 2, totalMs: 3 },
        })
      },
      capture: async (attempt) => {
        order.push('capture')
        attempt.conformance = assertTraceConformance(expectedTasks, conformingRun())
      },
    })
    expect(order).toEqual(['journal:planned', 'execute', 'capture', 'journal:complete'])
    expect(journal[1]).toMatchObject({
      attemptId: '1-vx',
      state: 'complete',
      exitCode: 0,
      elapsedMs: 123,
      stdout: 'captured stdout',
      failure: null,
    })
    expect(journal[0]!.pid).toBeNull()
  })

  it('retains spawn exceptions as failed attempts with unknown, never fabricated, process measurements', async () => {
    const sample = create()
    const journal: ReturnType<typeof create>[] = []
    let captures = 0
    const failure = await runCounterexampleAttempt(sample, {
      journal: async (attempt) => {
        journal.push(snapshot(attempt))
      },
      execute: async () => {
        expect(journal[0]!.state).toBe('planned')
        throw new Error('spawn failed: ENOENT')
      },
      capture: async () => {
        captures++
      },
    }).then(
      () => null,
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    )
    expect(failure).toBe('vx round 1: spawn failed: ENOENT; all attempted samples retained')
    expect(captures).toBe(1)
    expect(journal).toHaveLength(2)
    expect(journal[1]).toMatchObject({
      state: 'failed',
      pid: null,
      exitCode: null,
      elapsedMs: null,
      cpu: null,
      failure: 'spawn failed: ENOENT',
    })
  })

  it('retains stream exceptions, process observations and available traces despite exit zero', async () => {
    const sample = create()
    const journal: ReturnType<typeof create>[] = []
    const failure = await runCounterexampleAttempt(sample, {
      journal: async (attempt) => {
        journal.push(snapshot(attempt))
      },
      execute: async (attempt) => {
        Object.assign(attempt, { pid: 42, exitCode: 0, elapsedMs: 123, stdout: 'available stdout' })
        throw new Error('stderr stream failed: EIO')
      },
      capture: async (attempt) => {
        attempt.traceJSONL = '{"partial":"trace retained"}\n'
        attempt.outputs['partial.json'] = 'retained output'
      },
    }).then(
      () => null,
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    )
    expect(failure).toBe('vx round 1: stderr stream failed: EIO; all attempted samples retained')
    expect(journal[1]).toMatchObject({
      state: 'failed',
      pid: 42,
      exitCode: 0,
      elapsedMs: 123,
      stdout: 'available stdout',
      traceJSONL: '{"partial":"trace retained"}\n',
      outputs: { 'partial.json': 'retained output' },
      conformance: null,
    })
  })

  it('preserves primary execution and secondary capture exceptions rather than replacing or skipping them', async () => {
    const sample = create()
    const journal: ReturnType<typeof create>[] = []
    const failure = await runCounterexampleAttempt(sample, {
      journal: async (attempt) => {
        journal.push(snapshot(attempt))
      },
      execute: async () => {
        throw new Error('spawn failed')
      },
      capture: async () => {
        throw new Error('trace read failed')
      },
    }).then(
      () => null,
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    )
    expect(failure).toBe(
      'vx round 1: spawn failed; capture: trace read failed; all attempted samples retained',
    )
    expect(journal[1]!.state).toBe('failed')
    expect(journal[1]!.failure).toBe('spawn failed; capture: trace read failed')
  })

  it('does not spawn when pre-execution journaling fails', async () => {
    let executed = false
    const failure = await runCounterexampleAttempt(create(), {
      journal: async () => {
        throw new Error('journal write failed')
      },
      execute: async () => {
        executed = true
      },
      capture: async () => {},
    }).then(
      () => null,
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    )
    expect(failure).toBe('journal write failed')
    expect(executed).toBe(false)
  })
})

describe('trace conformance', () => {
  it('checks the complete expected execution set, outputs, durations, edges and concurrency', () => {
    expect(assertTraceConformance(expectedTasks, conformingRun())).toEqual({
      dagNodes: 7,
      executions: 5,
      untracedCommandlessNodes: ['f-left-gate', 'g-right-gate'],
      untracedMeaning:
        'Commandless root gates have no task processes, outputs or trace timestamps; their readiness timing is not trace-verified.',
      cacheHits: 0,
      peakConcurrency: 2,
      observedDispatchOrder: ['a-long', 'b-left', 'd-left-child', 'c-right', 'e-right-child'],
      orderMeaning:
        'host-monotonic task-process start order; not internal scheduler dispatch order',
    })
  })

  it('never pretends commandless gates executed, wrote outputs or had observed timing', () => {
    const fabricatedGate = conformingRun()
    fabricatedGate.events[0]!.id = 'f-left-gate'
    fabricatedGate.events[0]!.durationMs = 0
    expect(() => assertTraceConformance(expectedTasks, fabricatedGate)).toThrow(
      'invalid trace event',
    )
    const gateOutput = conformingRun()
    gateOutput.outputs['f-left-gate.json'] = '{}\n'
    expect(() => assertTraceConformance(expectedTasks, gateOutput)).toThrow('exactly five output')
    const nonRootGate = expectedTasks.map((task) =>
      task.id === 'f-left-gate' ? { ...task, deps: ['a-long'] } : task,
    )
    expect(() => assertTraceConformance(nonRootGate, conformingRun())).toThrow(
      'untraced commandless root gates only',
    )
    const undeclared = expectedTasks.map((task) =>
      task.id === 'b-left' ? { ...task, deps: ['missing-gate'] } : task,
    )
    expect(() => assertTraceConformance(undeclared, conformingRun())).toThrow(
      'undeclared dependency',
    )
  })

  it('preserves the append-order trace and stable observed order for tied starts', () => {
    const run = conformingRun()
    ;[run.events[0], run.events[1]] = [run.events[1]!, run.events[0]!]
    const before = JSON.stringify(run.events)
    expect(assertTraceConformance(expectedTasks, run).observedDispatchOrder).toEqual([
      'b-left',
      'a-long',
      'd-left-child',
      'c-right',
      'e-right-child',
    ])
    expect(JSON.stringify(run.events)).toBe(before)
  })

  it('fails for any child failure, missing cache evidence, or cache hit (never skips)', () => {
    for (const change of [{ exitCode: 7 }, { cacheHits: 1 }, { cacheHits: null }]) {
      expect(() =>
        assertTraceConformance(expectedTasks, { ...conformingRun(), ...change }),
      ).toThrow()
    }
  })

  it('rejects missing/duplicate/foreign tasks and corrupt event identity', () => {
    const missing = conformingRun()
    missing.events.pop()
    expect(() => assertTraceConformance(expectedTasks, missing)).toThrow('exactly five starts')
    const duplicate = conformingRun()
    duplicate.events[5] = { ...duplicate.events[0]! }
    expect(() => assertTraceConformance(expectedTasks, duplicate)).toThrow('duplicate start')
    const foreign = conformingRun()
    foreign.events[0]!.id = 'foreign'
    expect(() => assertTraceConformance(expectedTasks, foreign)).toThrow('invalid trace event')
    for (const change of [
      { monotonicNs: 'NaN' },
      { pid: 0 },
      { phase: 'wat' as TraceEvent['phase'] },
    ]) {
      const invalid = conformingRun()
      invalid.events[0] = { ...invalid.events[0]!, ...change }
      expect(() => assertTraceConformance(expectedTasks, invalid)).toThrow('invalid trace event')
    }
    const wrongPid = conformingRun()
    wrongPid.events[9]!.pid = 42
    expect(() => assertTraceConformance(expectedTasks, wrongPid)).toThrow(
      'identity/duration mismatch',
    )
    const wrongDuration = conformingRun()
    wrongDuration.events[0]!.durationMs = 100
    expect(() => assertTraceConformance(expectedTasks, wrongDuration)).toThrow(
      'identity/duration mismatch',
    )
  })

  it('rejects shortened waits, reversed execution and dependency violations', () => {
    const tooShort = conformingRun()
    tooShort.events[9]!.monotonicNs = '59999000000'
    expect(() => assertTraceConformance(expectedTasks, tooShort)).toThrow('ran shorter')
    const reversed = conformingRun()
    ;[reversed.events[0], reversed.events[9]] = [reversed.events[9]!, reversed.events[0]!]
    expect(() => assertTraceConformance(expectedTasks, reversed)).toThrow('end precedes start')
    const dependency = conformingRun()
    dependency.events[3]!.monotonicNs = '29749000000'
    expect(() => assertTraceConformance(expectedTasks, dependency)).toThrow(
      'dependency timing violated',
    )
  })

  it('rejects over-concurrency even when outputs, waits and dependencies all match', () => {
    const run = conformingRun()
    run.events[5]!.monotonicNs = '0'
    run.events[6]!.monotonicNs = '29750000000'
    expect(() => assertTraceConformance(expectedTasks, run)).toThrow('concurrency 2')
  })

  it('rejects missing, wrong and extra outputs rather than measuring less work', () => {
    const missing = conformingRun()
    delete missing.outputs['a-long.json']
    expect(() => assertTraceConformance(expectedTasks, missing)).toThrow('exactly five output')
    const wrong = conformingRun()
    wrong.outputs['a-long.json'] = '{}\n'
    expect(() => assertTraceConformance(expectedTasks, wrong)).toThrow('wrong output')
    const extra = conformingRun()
    extra.outputs['unrequested.json'] = '{}\n'
    expect(() => assertTraceConformance(expectedTasks, extra)).toThrow('exactly five output')
  })
})

describe('honest measured total and excess reporting', () => {
  it('computes amplification above ideal, not a fabricated total speedup', () => {
    // Hand-authored helper inputs, NOT benchmark results or observations.
    const summary = summarizeCounterexample(
      { vx: [89_700, 89_800, 89_900], turbo: [60_150, 60_200, 60_250] },
      60_000,
    )
    expect(summary.totals.vx).toMatchObject({
      n: 3,
      min: 89_700,
      median: 89_800,
      max: 89_900,
      range: 200,
    })
    expect(summary.excess.vx).toMatchObject({ min: 29_700, median: 29_800, max: 29_900 })
    expect(summary.excess.turbo).toMatchObject({ min: 150, median: 200, max: 250 })
    expect(summary.totalRatio.value).toBeCloseTo(89_800 / 60_200)
    expect(summary.excessRatio).toEqual({
      value: 149,
      reason: null,
      numeratorMs: 29_800,
      denominatorMs: 200,
    })
    expect(summary.excessRatioEnvelope).toEqual({ lower: 118.8, upper: 29_900 / 150 })
    expect(summary.pairs).toHaveLength(3)
  })

  it('retains adverse observations and uses every sample, including even-number medians', () => {
    const summary = summarizeCounterexample(
      { vx: [90_000, 91_000], turbo: [60_100, 90_000] },
      60_000,
    )
    expect(summary.totals.turbo).toMatchObject({ n: 2, median: 75_050, max: 90_000 })
    expect(summary.pairs[1]!.total.value).toBeCloseTo(91_000 / 90_000)
    expect(summary.excessRatio.value).toBeNull()
    expect(summary.excessRatio.reason).toBe('excess is unresolved against baseline/noise/spread')
  })

  it('has no NaN/Infinity or misleading ratio for invalid baselines and nonpositive/noisy excess', () => {
    for (const ideal of [0, -1, NaN, Infinity]) {
      const summary = summarizeCounterexample({ vx: [90_000], turbo: [60_200] }, ideal)
      expect(summary.excessRatio.value).toBeNull()
      expect(summary.excessRatio.reason).toBe('invalid analytic baseline')
      expect(summary.totalRatio.value).toBeCloseTo(90_000 / 60_200)
      expect(JSON.stringify(summary)).not.toMatch(/NaN|Infinity/)
    }
    for (const [turbo, reason] of [
      [60_000, 'nonpositive denominator'],
      [59_900, 'nonpositive denominator'],
      [60_000.5, 'denominator at/below noise floor'],
    ] as const) {
      const summary = summarizeCounterexample({ vx: [90_000], turbo: [turbo] }, 60_000)
      expect(summary.excessRatio.value).toBeNull()
      expect(summary.excessRatio.reason).toBe(reason)
    }
    expect(
      summarizeCounterexample({ vx: [59_999], turbo: [60_200] }, 60_000).excessRatio.reason,
    ).toBe('numerator below analytic baseline')
    for (const samples of [
      { vx: [], turbo: [] },
      { vx: [90_000], turbo: [] },
      { vx: [NaN], turbo: [60_200] },
      { vx: [-1], turbo: [60_200] },
    ]) {
      expect(summarizeCounterexample(samples, 60_000).totalRatio.value).toBeNull()
    }
    expect(() => summarizeCounterexample({ vx: [90_000], turbo: [60_200] }, 60_000, -1)).toThrow(
      'invalid noise floor',
    )
  })

  it('reports denominators, spread, provenance and the synthetic limitation conspicuously', () => {
    const report = renderCounterexampleReport({
      status: 'complete',
      model: analyticBaseline(),
      samples: [],
      summary: summarizeCounterexample({ vx: [89_800], turbo: [60_200] }, 60_000),
      provenance: { commit: 'immutable-test-commit', sha256: 'source-test-hash' },
      failure: null,
    })
    expect(report).toContain('SYNTHETIC COUNTEREXAMPLE')
    expect(report).toContain('NOT a general performance guarantee')
    expect(report).toContain(
      'Analytical case: two commandless readiness gates; 7 DAG nodes, 5 executable tasks.',
    )
    expect(report).toContain('not guaranteed runner behavior')
    expect(report).toContain('their readiness timing is not trace-verified')
    expect(report).toContain('including adverse Turborepo runs')
    expect(report).toContain('counterexample-preliminary-results.json')
    expect(report).toContain('COUNTEREXAMPLE-PRELIMINARY.md')
    expect(report).toContain('counterexample-preliminary-samples.jsonl')
    expect(report).toContain('Do not replace, pool, or filter its samples')
    expect(report).toContain('TOTAL ratio (vx / Turborepo): 1.492×')
    expect(report).toContain('EXCESS ratio ((vx − ideal) / (Turborepo − ideal)): 149.000×')
    expect(report).toContain('Excess denominator: 200.000 ms')
    expect(report).toContain('Total min–max ms')
    expect(report).toContain('not a confidence interval')
    expect(report).toContain('immutable-test-commit')
    expect(report).toContain('source-test-hash')
    expect(report).not.toContain('100×')
  })

  it('renders an invalid baseline as unresolved, never NaN or Infinity', () => {
    const report = renderCounterexampleReport({
      status: 'complete',
      model: { ...analyticBaseline(), idealMs: NaN },
      samples: [],
      summary: summarizeCounterexample({ vx: [90_000], turbo: [60_200] }, NaN),
      provenance: {},
      failure: null,
    })
    expect(report).toContain('Analytic ideal: unresolved')
    expect(report).toContain('invalid analytic baseline')
    expect(report).not.toMatch(/NaN|Infinity/)
  })

  it('never makes a performance claim from a failed experiment', () => {
    const report = renderCounterexampleReport({
      status: 'failed',
      model: analyticBaseline(),
      samples: [],
      summary: summarizeCounterexample({ vx: [89_800], turbo: [60_200] }, 60_000),
      provenance: {},
      failure: 'child failed: exit 7',
    })
    expect(report).toContain('No performance claim')
    expect(report).toContain('child failed: exit 7')
    expect(report).not.toContain('Measured TOTAL ratio')
  })
})
