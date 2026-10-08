// Unit-test figures are deliberate fixtures, never measurements or repository publication output.
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import {
  analyticBaseline,
  assertTraceConformance,
  counterexampleFixtureFiles,
  counterexampleShape,
  summarizeCounterexample,
  type TraceEvent,
} from '../counterexample.js'
import { publishSite, renderPublication, validateCounterexample } from '../update-site.js'

const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const commit = 'a'.repeat(40)
const fixture = '/fixture'
const tools = {
  vx: {
    path: '/bin/vx',
    version: 'vx 0.0.0',
    sourceCommit: commit,
    origin: 'compiled from clean core source at recorded commit',
    sha256: hash('vx'),
  },
  turbo: {
    path: '/bin/turbo',
    version: '2.11.7',
    executionMode: 'native-direct',
    headerFormat: 'ELF',
    nativePackage: { name: 'turbo-linux-64', version: '2.11.7', sha256: hash('native package') },
    origin:
      'native direct run of pinned installed platform optional dependency; Node launcher bypassed',
    sha256: hash('turbo'),
  },
}

function experiment(
  vxTimes = [3000, 3000, 3000, 3000, 3000],
  turboTimes = [2002, 2002, 2002, 2002, 2002],
  noiseMs = 1,
) {
  const tasks = counterexampleShape(2, 0.1)
  const event = (
    id: string,
    phase: 'start' | 'end',
    ms: number,
    durationMs: number,
    pid: number,
  ): TraceEvent => ({ id, phase, monotonicNs: String(BigInt(ms) * 1_000_000n), durationMs, pid })
  // Hand-written executable trace; the two commandless roots deliberately have no events.
  const events = [
    event('a-long', 'start', 0, 2000, 1),
    event('b-left', 'start', 0, 900, 2),
    event('b-left', 'end', 900, 900, 2),
    event('d-left-child', 'start', 900, 100, 3),
    event('d-left-child', 'end', 1000, 100, 3),
    event('c-right', 'start', 1000, 900, 4),
    event('c-right', 'end', 1900, 900, 4),
    event('e-right-child', 'start', 1900, 100, 5),
    event('e-right-child', 'end', 2000, 100, 5),
    event('a-long', 'end', 2000, 2000, 1),
  ]
  const outputs = {
    'a-long.json': '{"id":"a-long","durationMs":2000}\n',
    'b-left.json': '{"id":"b-left","durationMs":900}\n',
    'c-right.json': '{"id":"c-right","durationMs":900}\n',
    'd-left-child.json': '{"id":"d-left-child","durationMs":100}\n',
    'e-right-child.json': '{"id":"e-right-child","durationMs":100}\n',
  }
  const files = {
    ...counterexampleFixtureFiles(tasks, true),
    'bun.lock': '{"test":"lock"}\n',
    'vx-lock.json': '{"test":"snapshot"}\n',
  }
  const coreFiles = {
    'packages/vx/src/bin.ts': hash('core'),
    'packages/vx/package.json': hash('manifest'),
    'bun.lock': hash('lock'),
  }
  const samples = Array.from({ length: 10 }, (_, index) => {
    const round = Math.floor(index / 2) + 1
    const position = (index % 2) + 1
    const runner = ((round % 2 === 1) === (position === 1) ? 'vx' : 'turbo') as 'vx' | 'turbo'
    const cacheDir = `${fixture}/.bench/cache/${round}-${runner}`
    return {
      attemptId: `${round}-${runner}`,
      state: 'complete',
      runner,
      round,
      position,
      argv:
        runner === 'vx'
          ? [
              tools.vx.path,
              'run',
              ...tasks.map((task) => task.id),
              '--all',
              '--frozen',
              '--concurrency=2',
              `--cache-dir=${cacheDir}`,
              '--cache=local:rw,remote:',
            ]
          : [
              tools.turbo.path,
              'run',
              ...tasks.map((task) => task.id),
              '--filter=@bench/counterexample',
              '--concurrency=2',
              `--cache-dir=${cacheDir}`,
              '--cache=local:rw',
              '--no-daemon',
              '--env-mode=strict',
              '--output-logs=full',
              '--log-order=stream',
            ],
      cwd: fixture,
      cacheDir,
      startedAt: '2026-10-08T00:00:00.000Z',
      pid: 123 + index,
      exitCode: 0,
      signal: null,
      elapsedMs: runner === 'vx' ? vxTimes[round - 1]! : turboTimes[round - 1]!,
      cpu: { userMs: 10.111, systemMs: 20.222, totalMs: 30.333 },
      stdout: runner === 'vx' ? '5 success · 5 total · 5 miss' : 'Cached: 0 cached, 5 total',
      stderr: '',
      traceJSONL: events.map((entry) => JSON.stringify(entry)).join('\n') + '\n',
      events: structuredClone(events),
      outputs: { ...outputs },
      conformance: assertTraceConformance(tasks, { exitCode: 0, cacheHits: 0, events, outputs }),
      failure: null,
    }
  })
  return {
    schemaVersion: 1,
    kind: 'synthetic-scheduling-counterexample',
    measurement: 'real-cli-subprocess',
    status: 'complete',
    failure: null as string | null,
    createdAt: '2026-10-08T00:00:00.000Z',
    options: { longSeconds: 2, leafSeconds: 0.1, reps: 5, noiseMs },
    model: analyticBaseline(2, 0.1),
    tasks,
    fixture,
    fixtureSources: Object.fromEntries(
      Object.entries(files).map(([file, content]) => [file, { content, sha256: hash(content) }]),
    ),
    provenance: {
      git: { commit },
      harness: { sha256: hash('test harness') },
      coreSource: { files: coreFiles, sha256: hash(JSON.stringify(coreFiles)) },
      bun: { version: '1.4.2', revision: '1.4.2+abcdef123', sha256: hash('bun') },
      host: {
        platform: 'linux',
        arch: 'x64',
        release: 'test-release',
        cores: 4,
        cpuModels: ['Test CPU'],
      },
      tools: structuredClone(tools),
      preparationTimedAsSamples: false,
      traceClock: {
        method: 'native clock_gettime(CLOCK_MONOTONIC) via bun:ffi',
        probes: [
          { monotonicNs: '2000000001', processRelativeNs: '1' },
          { monotonicNs: '2000000002', processRelativeNs: '1' },
        ],
      },
    },
    preparation: [
      { argv: [tools.vx.path, '--version'], stdout: tools.vx.version, exitCode: 0, signal: null },
      {
        argv: [tools.turbo.path, '--version'],
        stdout: tools.turbo.version,
        exitCode: 0,
        signal: null,
      },
      {
        argv: ['bun', 'build', '--compile', '--outfile', tools.vx.path],
        stdout: '',
        exitCode: 0,
        signal: null,
      },
    ],
    samples,
    summary: summarizeCounterexample({ vx: vxTimes, turbo: turboTimes }, 2000, noiseMs),
  }
}

const stress = {
  layers: 100,
  perLayer: 11,
  packages: 1090,
  depsPerPkg: 30,
  concurrency: 10,
  reps: 1,
  buildSleep: '1',
  date: '2026-10-04T00:00:00Z',
  machine: 'test fixture, not a measurement',
  rows: [
    {
      runner: 'vx',
      version: 'vx 0.0.0',
      fresh: 220000,
      warmNoRestore: 390,
      warmRestore: 650,
      freshCpu: 17000,
      warmNoRestoreCpu: 740,
    },
    {
      runner: 'vx (no lock)',
      version: 'vx 0.0.0',
      fresh: 221000,
      warmNoRestore: 470,
      warmRestore: 780,
      freshCpu: 18000,
      warmNoRestoreCpu: 890,
    },
    {
      runner: 'turbo',
      version: '2.11.7',
      fresh: 298000,
      warmNoRestore: 460,
      warmRestore: 990,
      freshCpu: 21000,
      warmNoRestoreCpu: 890,
    },
    {
      runner: 'nx',
      version: '23.2.1',
      fresh: 229000,
      warmNoRestore: 6450,
      warmRestore: 6250,
      freshCpu: 52000,
      warmNoRestoreCpu: 7520,
    },
    {
      runner: 'vite-task',
      version: '1.0.0',
      fresh: 289000,
      warmNoRestore: 2490,
      warmRestore: 2640,
      freshCpu: 12000,
      warmNoRestoreCpu: 2480,
    },
  ],
  baseline: {
    fresh: 218000,
    warmNoRestore: 24,
    warmRestore: 93,
    freshCpu: 9090,
    warmNoRestoreCpu: 32,
    criticalPathMs: 100000,
    workBoundMs: 218000,
  },
}
const sources = {
  readme:
    '# Before\n<!-- bench:start -->\nold stress\n<!-- bench:end -->\n<!-- counterexample:start -->\npending\n<!-- counterexample:end -->\n# After\n',
  landing:
    "const benchTable = [\n]\nconst benchFormula = 'old'\nconst benchScope = 'old'\n// 3,270 tasks · 1,090 packages · 100 layers ·\n// counterexample:data:start\npending\n// counterexample:data:end\n// unrelated authored content\n",
  benchmarks:
    '# Before\n<!-- stress:start -->\nold stress\n<!-- stress:end -->\n<!-- counterexample:start -->\npending\n<!-- counterexample:end -->\n## Reproducible head-to-head\nHistorical numbers remain verbatim.\n',
}

function scratch(fn: (root: string) => void) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'vx-update-site-test-'))
  const write = (rel: string, content: string) => {
    const file = path.join(root, rel)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, content)
  }
  write('packages/vx-bench/results.json', JSON.stringify(stress))
  write('packages/vx-bench/counterexample-results.json', JSON.stringify(experiment()))
  // These archive placeholders exercise retention only; no archive figures are rendered from them.
  for (const file of [
    'counterexample-preliminary-results.json',
    'COUNTEREXAMPLE-PRELIMINARY.md',
    'counterexample-preliminary-samples.jsonl',
  ]) {
    write(`packages/vx-bench/${file}`, `Retained test archive: ${file}\n`)
  }
  write('README.md', sources.readme)
  write('packages/vx-docs/src/pages/index.astro', sources.landing)
  write('packages/vx/docs/benchmarks.md', sources.benchmarks)
  try {
    fn(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}
const identity = (_rel: string, text: string) => text
const targets = [
  'README.md',
  'packages/vx-docs/src/pages/index.astro',
  'packages/vx/docs/benchmarks.md',
]

describe('counterexample publication boundary', () => {
  it('rejects missing, unsupported and simulated schemas at the read boundary', () => {
    const c = experiment()
    for (const input of [
      null,
      [],
      {},
      { ...c, schemaVersion: 2 },
      { ...c, measurement: 'simulation' },
      { ...c, kind: 'another-workload' },
    ]) {
      expect(() => validateCounterexample(input)).toThrow()
    }
  })

  it('accepts exactly five alternating native rounds and recomputes every summary metric', () => {
    const c = validateCounterexample(experiment())
    // Hand-computed expected values, not read from the summary they guard.
    expect(c.model.idealMs).toBe(2000)
    expect(c.model.workMs).toBe(4000)
    expect(c.model.dagNodes).toBe(7)
    expect(c.model.executableTasks).toBe(5)
    expect(c.model.commandlessGates).toEqual(['f-left-gate', 'g-right-gate'])
    expect(c.tasks).toEqual([
      { id: 'a-long', dur: 2000, deps: [] },
      { id: 'b-left', dur: 900, deps: ['f-left-gate'] },
      { id: 'c-right', dur: 900, deps: ['g-right-gate'] },
      { id: 'd-left-child', dur: 100, deps: ['b-left'] },
      { id: 'e-right-child', dur: 100, deps: ['c-right'] },
      { id: 'f-left-gate', dur: 0, deps: [] },
      { id: 'g-right-gate', dur: 0, deps: [] },
    ])
    expect(c.model.witness.slice(0, 2)).toEqual([
      { id: 'f-left-gate', worker: 0, startMs: 0, endMs: 0 },
      { id: 'g-right-gate', worker: 0, startMs: 0, endMs: 0 },
    ])
    expect(c.summary.totals.vx).toEqual({
      n: 5,
      min: 3000,
      median: 3000,
      max: 3000,
      range: 0,
      stddev: 0,
    })
    expect(c.summary.excess.turbo).toEqual({ n: 5, min: 2, median: 2, max: 2, range: 0, stddev: 0 })
    expect(c.summary.totalRatio.value).toBe(1500 / 1001)
    expect(c.summary.excessRatio.value).toBe(500)
    expect(c.summary.excessRatioEnvelope).toEqual({ lower: 500, upper: 500 })
    expect(c.summary.pairs.map((pair) => pair.excess?.value)).toEqual([500, 500, 500, 500, 500])
  })

  it('does not mistake the earlier five-node case for the primary gated case even at schema version 1', () => {
    const c = experiment()
    c.tasks = c.tasks
      .filter((task) => task.dur > 0)
      .map((task) => ({ ...task, deps: task.deps.filter((dep) => !dep.endsWith('-gate')) }))
    expect(c.schemaVersion).toBe(1)
    expect(() => validateCounterexample(c)).toThrow('tasks')
  })

  it('rejects gate processes, outputs and inflated execution counts while retaining untraced gates', () => {
    const original = experiment()
    expect(original.samples[0]!.conformance.dagNodes).toBe(7)
    expect(original.samples[0]!.conformance.executions).toBe(5)
    expect(original.samples[0]!.conformance.untracedCommandlessNodes).toEqual([
      'f-left-gate',
      'g-right-gate',
    ])
    expect(original.samples[0]!.events).toHaveLength(10)
    expect(Object.keys(original.samples[0]!.outputs)).toHaveLength(5)
    const mutations: Array<(c: ReturnType<typeof experiment>) => void> = [
      (c) => {
        c.samples[0]!.stdout = '7 success · 7 total · 7 miss'
      },
      (c) => {
        c.samples[1]!.stdout = 'Cached: 0 cached, 7 total'
      },
      (c) => {
        c.samples[0]!.conformance.dagNodes = 5
      },
      (c) => {
        c.samples[0]!.conformance.executions = 7
      },
      (c) => {
        c.samples[0]!.conformance.untracedCommandlessNodes = []
      },
      (c) => {
        Object.assign(c.samples[0]!.outputs, { 'f-left-gate.json': 'invented gate output' })
      },
      (c) => {
        const sample = c.samples[0]!
        sample.events.push({
          id: 'f-left-gate',
          phase: 'start',
          monotonicNs: '0',
          durationMs: 0,
          pid: 9,
        })
        sample.traceJSONL = sample.events.map((event) => JSON.stringify(event)).join('\n') + '\n'
      },
    ]
    for (const mutate of mutations) {
      const c = experiment()
      mutate(c)
      expect(() => validateCounterexample(c)).toThrow()
    }
  })

  it('rejects running, failed, short, duplicate, reordered and failed/hit samples without filtering', () => {
    const mutations: Array<(c: ReturnType<typeof experiment>) => void> = [
      (c) => {
        c.status = 'running'
      },
      (c) => {
        c.status = 'failed'
      },
      (c) => {
        c.failure = 'failed sample'
      },
      (c) => {
        c.options.reps = 4
      },
      (c) => {
        c.samples.pop()
      },
      (c) => {
        c.samples[1] = structuredClone(c.samples[0]!)
      },
      (c) => {
        c.samples.reverse()
      },
      (c) => {
        c.samples[0]!.exitCode = 1
      },
      (c) => {
        c.samples[0]!.state = 'failed'
      },
      (c) => {
        c.samples[0]!.stdout += ' · 1 local'
      },
      (c) => {
        c.samples[1]!.stdout = 'Cached: 1 cached, 5 total'
      },
      (c) => {
        c.samples[0]!.stdout = 'unknown summary'
      },
      (c) => {
        c.samples[0]!.elapsedMs = NaN
      },
    ]
    for (const mutate of mutations) {
      const c = experiment()
      mutate(c)
      expect(() => validateCounterexample(c)).toThrow()
    }
  })

  it('rejects forged native provenance, baseline, commands, traces, outputs and CPU accounting', () => {
    const mutations: Array<(c: ReturnType<typeof experiment>) => void> = [
      (c) => {
        c.provenance.tools.turbo.executionMode = 'node-launcher'
      },
      (c) => {
        c.provenance.tools.turbo.version = '2.11.8'
      },
      (c) => {
        c.provenance.tools.turbo.headerFormat = 'Mach-O'
      },
      (c) => {
        c.provenance.tools.turbo.nativePackage.name = 'wrong-platform'
      },
      (c) => {
        c.provenance.tools.vx.sourceCommit = 'b'.repeat(40)
      },
      (c) => {
        c.provenance.bun.version = '1.4.0'
      },
      (c) => {
        c.preparation[1]!.stdout = '2.11.8'
      },
      (c) => {
        c.provenance.coreSource.sha256 = hash('wrong core')
      },
      (c) => {
        c.model.idealMs = 1999
      },
      (c) => {
        c.model.witness[0]!.endMs = 1999
      },
      (c) => {
        c.tasks[0] = { ...c.tasks[0]!, dur: 1999 }
      },
      (c) => {
        c.fixtureSources['turbo.json']!.content += ' '
      },
      (c) => {
        c.samples[0]!.argv[0] = 'node'
      },
      (c) => {
        c.samples[0]!.argv.push('--concurrency=3')
      },
      (c) => {
        c.samples[0]!.events[0]!.durationMs = 1
      },
      (c) => {
        c.samples[0]!.traceJSONL = c.samples[0]!.traceJSONL.trim().split('\n').slice(1).join('\n')
      },
      (c) => {
        c.samples[0]!.outputs['a-long.json'] = 'wrong bytes'
      },
      (c) => {
        c.samples[0]!.conformance.executions = 4
      },
      (c) => {
        c.samples[0]!.elapsedMs = 1999
      },
      (c) => {
        c.samples[0]!.cpu.totalMs = 99
      },
    ]
    for (const mutate of mutations) {
      const c = experiment()
      mutate(c)
      expect(() => validateCounterexample(c)).toThrow()
    }
  })

  it('does not trust a stored ratio, spread, paired result or envelope', () => {
    const mutations: Array<(c: ReturnType<typeof experiment>) => void> = [
      (c) => {
        c.summary.totalRatio.value = 100
      },
      (c) => {
        c.summary.excessRatio.value = 100
      },
      (c) => {
        c.summary.totals.vx!.median = 1
      },
      (c) => {
        c.summary.excess.turbo!.stddev = 1
      },
      (c) => {
        c.summary.pairs[0]!.total.value = 100
      },
      (c) => {
        c.summary.excessRatioEnvelope!.lower = 100
      },
    ]
    for (const mutate of mutations) {
      const c = experiment()
      mutate(c)
      expect(() => validateCounterexample(c)).toThrow('summary metrics')
    }
  })
})

describe('independent publication renderings', () => {
  it('puts end-to-end first, keeps excess separate, and preserves dated history', () => {
    const out = renderPublication(stress, experiment(), sources)
    for (const markdown of [out.readme, out.benchmarks]) {
      expect(markdown.indexOf('End-to-end wall time:')).toBeLessThan(
        markdown.indexOf('Baseline-subtracted excess:'),
      )
      expect(markdown).toContain(
        'End-to-end ratio of all-five-round medians (vx / Turborepo): 1.499×',
      )
      expect(markdown).toContain(
        'Excess ratio of all-five-round medians ((vx − ideal) / (Turborepo − ideal)): 500.000×',
      )
      expect(markdown).toContain('not an every-round threshold or a universal guarantee')
      expect(markdown).toContain('Median excess denominator 2.000 ms')
      expect([...markdown.matchAll(/Paired round \d:/g)]).toHaveLength(5)
      expect(markdown).toContain('not that multiple slower whole builds')
      expect(markdown).toContain('not confidence intervals')
      expect(markdown).toContain('single repetition')
      expect(markdown).toContain('2,180 executable')
      expect(markdown).toContain('1,090 ordering/group nodes')
      expect(markdown).toContain('11 dependencies per non-bottom package')
      expect(markdown).toContain(
        '7 DAG nodes, 5 executable waiting tasks and 2 commandless root gates',
      )
      expect(markdown).toContain('f-left-gate')
      expect(markdown).toContain('g-right-gate')
      expect(markdown).toContain('readiness timing is not trace-verified')
      expect(markdown).toContain('positive-duration commands are unchanged')
      expect(markdown).toContain('adverse Turborepo root-order run and an unresolved excess ratio')
      expect(markdown).toContain('never pooled into the primary medians or filtered away')
      for (const file of [
        'counterexample-preliminary-results.json',
        'COUNTEREXAMPLE-PRELIMINARY.md',
        'counterexample-preliminary-samples.jsonl',
      ]) {
        expect(markdown).toContain(
          `https://github.com/vznjs/vx/blob/main/packages/vx-bench/${file}`,
        )
      }
    }
    expect(out.benchmarks).toContain('Historical numbers remain verbatim.')
    expect(out.landing).toContain('// unrelated authored content')
    expect(out.landing).toContain("label: 'Cold build: whole wall time'")
    expect(out.landing).toContain('five alternating rounds, ten conforming actual CLI samples')
    expect(out.landing).toContain('"ms":3000')
    expect(out.landing).toContain('"ms":2002')
    expect(renderPublication(stress, experiment(), out)).toEqual(out)
  })

  it('never invents a 100× excess claim when only a smaller ratio is resolved', () => {
    const c = experiment([3000, 3000, 3000, 3000, 3000], [2020, 2020, 2020, 2020, 2020])
    const out = renderPublication(stress, c, sources)
    expect(out.readme).toContain(
      'Excess ratio of all-five-round medians ((vx − ideal) / (Turborepo − ideal)): 50.000×',
    )
    expect(out.readme).not.toContain('medians ((vx − ideal) / (Turborepo − ideal)): 100.000×')
  })

  it('suppresses excess ratios for zero/noise/spread-dominated denominators but retains all times', () => {
    for (const times of [
      [2000, 2000, 2000, 2000, 2000],
      [2001, 2001, 2001, 2001, 2001],
      [2002, 2003, 2004, 2005, 2008],
    ]) {
      const c = experiment([3000, 3000, 3000, 3000, 3000], times)
      const out = renderPublication(stress, c, sources)
      expect(out.readme).toContain(
        'Excess ratio of all-five-round medians ((vx − ideal) / (Turborepo − ideal)): unresolved',
      )
      expect(out.readme).toContain('all-sample envelope unresolved')
      expect(out.readme).toContain(
        'End-to-end ratio of all-five-round medians (vx / Turborepo): 1.',
      )
      expect(out.readme).toContain('median; min–max')
      expect(out.readme).not.toContain('Infinity')
      expect(out.readme).not.toContain('NaN')
    }
  })

  it('keeps a below-100 paired round visible when the all-round median excess ratio exceeds 100', () => {
    // Fixture-only measurements: median excess 1000/9 > 100, first paired excess 1000/11 < 100.
    const c = experiment([3000, 3000, 3000, 3000, 3000], [2011, 2009, 2009, 2009, 2009])
    const out = renderPublication(stress, c, sources)
    for (const text of [out.readme, out.benchmarks, out.landing]) {
      expect(text).toContain(
        'Paired round 1: end-to-end vx/Turborepo ratio 1.49180×; baseline-subtracted excess ratio 90.90909×',
      )
      expect(text).toContain('1 paired excess ratio is below 100×')
      expect(text).toContain('not an every-round threshold or a universal guarantee')
      expect([...text.matchAll(/Paired round \d:/g)]).toHaveLength(5)
    }
    expect(out.readme).toContain('medians ((vx − ideal) / (Turborepo − ideal)): 111.111×')
  })

  it('prints the observed full spread, not a confidence interval or favorable subset', () => {
    const c = experiment([3000, 3010, 3020, 3030, 3040], [2020, 2021, 2022, 2023, 2024])
    const out = renderPublication(stress, c, sources)
    expect(out.readme).toContain('3.020 s; 3.000 s–3.040 s')
    expect(out.readme).toContain('2.022 s; 2.020 s–2.024 s')
    expect(out.readme).toContain('41.66667–52.00000×')
    expect(out.readme).toContain('No outliers are omitted')
  })

  it('accepts formatter-wrapped scope and formula assignments on regeneration', () => {
    const out = renderPublication(stress, experiment(), sources)
    const wrapped = {
      ...out,
      landing: out.landing
        .replace('const benchScope = ', 'const benchScope =\n  ')
        .replace('const benchFormula = ', 'const benchFormula =\n  '),
    }
    expect(renderPublication(stress, experiment(), wrapped)).toEqual(out)
  })

  it('requires one and only one region per case rather than silently dropping data', () => {
    for (const changed of [
      { ...sources, readme: sources.readme.replace('<!-- counterexample:end -->', '') },
      {
        ...sources,
        benchmarks: sources.benchmarks + '\n<!-- stress:start -->duplicate<!-- stress:end -->',
      },
      { ...sources, landing: sources.landing.replace('// counterexample:data:end', '') },
    ])
      expect(() => renderPublication(stress, experiment(), changed)).toThrow(
        'exactly one generated region',
      )
  })
})

describe('publisher file reads and drift checks in scratch only', () => {
  it('reads the independent JSON, checks every target, regenerates idempotently, and leaves raw data unchanged', () =>
    scratch((root) => {
      const rawPaths = [
        'packages/vx-bench/results.json',
        'packages/vx-bench/counterexample-results.json',
        'packages/vx-bench/counterexample-preliminary-results.json',
        'packages/vx-bench/COUNTEREXAMPLE-PRELIMINARY.md',
        'packages/vx-bench/counterexample-preliminary-samples.jsonl',
      ]
      const beforeRaw = rawPaths.map((file) => readFileSync(path.join(root, file), 'utf8'))
      expect(() => publishSite(root, true, identity)).toThrow('do not match')
      expect(publishSite(root, false, identity)).toBe(true)
      expect(publishSite(root, true, identity)).toBe(false)
      expect(publishSite(root, false, identity)).toBe(false)
      for (const file of targets) {
        const original = readFileSync(path.join(root, file), 'utf8')
        writeFileSync(
          path.join(root, file),
          original.replace(
            file === targets[1] ? 'const counterexampleScope' : 'End-to-end ratio',
            'WRONG',
          ),
        )
        expect(() => publishSite(root, true, identity)).toThrow()
        writeFileSync(path.join(root, file), original)
      }
      expect(rawPaths.map((file) => readFileSync(path.join(root, file), 'utf8'))).toEqual(beforeRaw)
    }))

  it('refuses to publish if any retained preliminary artifact is missing or empty', () => {
    for (const file of [
      'counterexample-preliminary-results.json',
      'COUNTEREXAMPLE-PRELIMINARY.md',
      'counterexample-preliminary-samples.jsonl',
    ]) {
      scratch((root) => {
        const artifact = path.join(root, 'packages/vx-bench', file)
        const before = targets.map((target) => readFileSync(path.join(root, target), 'utf8'))
        rmSync(artifact)
        expect(() => publishSite(root, false, identity)).toThrow()
        writeFileSync(artifact, '')
        expect(() => publishSite(root, false, identity)).toThrow(
          'retained preliminary artifact is empty',
        )
        expect(targets.map((target) => readFileSync(path.join(root, target), 'utf8'))).toEqual(
          before,
        )
      })
    }
  })

  it('refuses a missing or undecodable independent dataset without touching targets', () =>
    scratch((root) => {
      const raw = path.join(root, 'packages/vx-bench/counterexample-results.json')
      const before = targets.map((file) => readFileSync(path.join(root, file), 'utf8'))
      rmSync(raw)
      expect(() => publishSite(root, false, identity)).toThrow()
      writeFileSync(raw, '{ incomplete JSON')
      expect(() => publishSite(root, false, identity)).toThrow()
      expect(targets.map((file) => readFileSync(path.join(root, file), 'utf8'))).toEqual(before)
    }))

  it('reads the latest dataset and catches data drift even with unchanged publication files', () =>
    scratch((root) => {
      publishSite(root, false, identity)
      writeFileSync(
        path.join(root, 'packages/vx-bench/counterexample-results.json'),
        JSON.stringify(experiment([3010, 3010, 3010, 3010, 3010])),
      )
      expect(() => publishSite(root, true, identity)).toThrow('do not match')
    }))

  it('refuses partial or forged artifacts before any publication write', () =>
    scratch((root) => {
      const before = targets.map((file) => readFileSync(path.join(root, file), 'utf8'))
      const c = experiment()
      c.status = 'running'
      writeFileSync(
        path.join(root, 'packages/vx-bench/counterexample-results.json'),
        JSON.stringify(c),
      )
      expect(() => publishSite(root, false, identity)).toThrow('must be complete')
      expect(targets.map((file) => readFileSync(path.join(root, file), 'utf8'))).toEqual(before)
      c.status = 'complete'
      c.summary.totalRatio.value = 100
      writeFileSync(
        path.join(root, 'packages/vx-bench/counterexample-results.json'),
        JSON.stringify(c),
      )
      expect(() => publishSite(root, false, identity)).toThrow('summary metrics')
      expect(targets.map((file) => readFileSync(path.join(root, file), 'utf8'))).toEqual(before)
    }))

  it('finishes validation and normalization of all targets before writing any', () =>
    scratch((root) => {
      const before = targets.map((file) => readFileSync(path.join(root, file), 'utf8'))
      expect(() =>
        publishSite(root, false, (file, text) => {
          if (file === targets[2]) throw new Error('formatter refused')
          return text
        }),
      ).toThrow('formatter refused')
      expect(targets.map((file) => readFileSync(path.join(root, file), 'utf8'))).toEqual(before)
    }))
})
