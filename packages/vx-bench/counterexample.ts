#!/usr/bin/env bun
/**
 * REAL CLI measurements of a synthetic scheduling counterexample, not a general speed guarantee.
 *
 * bun packages/vx-bench/counterexample.ts --long 60 --leaf 0.25 --reps 5
 * bun packages/vx-bench/counterexample.ts --long 1 --leaf 0.05 --reps 2 --output <new-directory>
 * VX_BIN and TURBO_BIN accept standalone executables; otherwise preparation compiles vx and
 * installs turbo@2.11.7 ONLY in the generated fixture. Preparation is outside all sample timers.
 * --output is a directory; existing reports are refused so earlier measurements survive.
 */
import { createHash } from 'node:crypto'
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import type { SimTask } from './schedule-policy.js'

const TURBO_VERSION = '2.11.7'
const BUN_VERSION = '1.4.2'
const PACKAGE = '@bench/counterexample'
const PACKAGE_DIR = 'packages/job'
const TRACE = '.bench/trace.jsonl'
const RESULTS = 'counterexample-results.json'
const REPORT = 'COUNTEREXAMPLE.md'
const SYNTHETIC_WARNING =
  'SYNTHETIC COUNTEREXAMPLE: real subprocess measurements of waiting tasks, NOT a general performance guarantee.'

type Runner = 'vx' | 'turbo'

interface TurboPackage {
  name: string
  version: string
  optionalDependencies?: Record<string, string>
}

export function turboNativeExecutableSpec(pkg: TurboPackage, platform: string, arch: string) {
  if (pkg.name !== 'turbo' || pkg.version !== TURBO_VERSION)
    throw new Error(`requires installed turbo@${TURBO_VERSION}`)
  if (!['darwin', 'linux'].includes(platform) || !['x64', 'arm64'].includes(arch))
    throw new Error(`unsupported native Turborepo platform: ${platform}/${arch}`)
  const suffix = `${platform}-${arch === 'x64' ? '64' : arch}`
  const dependencies = Object.entries(pkg.optionalDependencies ?? {})
  const dependency =
    dependencies.find(([name]) => name === `@turbo/${suffix}`) ??
    dependencies.find(([name]) => name === `turbo-${suffix}`)
  if (!dependency || dependency[1] !== TURBO_VERSION)
    throw new Error(`missing exact pinned native optional dependency for ${platform}/${arch}`)
  return {
    packageName: dependency[0],
    version: dependency[1],
    executable: `${dependency[0]}/bin/turbo`,
  }
}

export function nativeExecutableFormat(header: Uint8Array): 'ELF' | 'Mach-O' {
  const magic = Buffer.from(header.subarray(0, 4)).toString('hex')
  if (magic === '7f454c46') return 'ELF'
  if (
    [
      'feedface',
      'cefaedfe',
      'feedfacf',
      'cffaedfe',
      'cafebabe',
      'bebafeca',
      'cafebabf',
      'bfbafeca',
    ].includes(magic)
  )
    return 'Mach-O'
  throw new Error('TURBO_BIN must be a native ELF/Mach-O executable, not a Node or shell launcher')
}

export interface Options {
  longSeconds: number
  leafSeconds: number
  reps: number
  noiseMs: number
  output: string
}

export function counterexampleShape(longSeconds = 60, leafSeconds = 0.25): SimTask[] {
  if (
    !Number.isFinite(longSeconds) ||
    !Number.isFinite(leafSeconds) ||
    longSeconds <= 0 ||
    leafSeconds <= 0 ||
    leafSeconds >= longSeconds / 2 ||
    longSeconds * 1000 > 2 ** 31 - 1 ||
    leafSeconds * 1000 < 1
  ) {
    throw new Error('durations require long > 2 * leaf, leaf >= 0.001 s, and long <= 2147483.647 s')
  }
  const parentMs = (longSeconds * 1000) / 2 - leafSeconds * 1000
  return [
    { id: 'a-long', dur: longSeconds * 1000, deps: [] },
    { id: 'b-left', dur: parentMs, deps: ['f-left-gate'] },
    { id: 'c-right', dur: parentMs, deps: ['g-right-gate'] },
    { id: 'd-left-child', dur: leafSeconds * 1000, deps: ['b-left'] },
    { id: 'e-right-child', dur: leafSeconds * 1000, deps: ['c-right'] },
    { id: 'f-left-gate', dur: 0, deps: [] },
    { id: 'g-right-gate', dur: 0, deps: [] },
  ]
}

export function analyticBaseline(longSeconds = 60, leafSeconds = 0.25) {
  const tasks = counterexampleShape(longSeconds, leafSeconds)
  const [long, left, right, leftChild, rightChild, leftGate, rightGate] = tasks
  const half = long!.dur / 2
  return {
    caseId: 'two-commandless-readiness-gates',
    caseLabel: 'two commandless readiness gates',
    dagNodes: tasks.length,
    executableTasks: tasks.filter((task) => task.dur > 0).length,
    commandlessGates: [leftGate!.id, rightGate!.id],
    gatePurpose:
      'Both runners receive the same zero-cost readiness gates. This controls when parents become ready: count priority may admit newly ready parents ahead of the independent long task, while a FIFO semaphore may retain the already waiting long task. These are hypotheses about ordering, not guaranteed runner behavior; keep every observed task-start order.',
    predecessor: {
      caseLabel: 'minimal five-task DAG without readiness gates',
      sourceCommit: 'd2095b889ef5915a5ba73c964599d3ad7b1ad478',
      artifacts: [
        'counterexample-preliminary-results.json',
        'COUNTEREXAMPLE-PRELIMINARY.md',
        'counterexample-preliminary-samples.jsonl',
      ],
      comparisonPolicy:
        'The earlier case, including adverse Turborepo runs, stays separate and unchanged. Do not replace, pool, or filter its samples when measuring this different shared DAG.',
    },
    concurrency: 2,
    workMs: 2 * long!.dur,
    workBoundMs: long!.dur,
    criticalPathMs: long!.dur,
    idealMs: long!.dur,
    proof: 'max(work / 2, critical path) = long; the feasible witness attains that lower bound',
    assumptions: [
      'Two identical workers; non-preemptive tasks; exact declared waiting durations.',
      'Four declared edges: two zero-cost root gates precede their parents, and each parent precedes its child.',
      'The two commandless gates have no process, script, outputs or trace timestamps. Only executable dependency timing is trace-verified.',
      'Zero process startup, hashing, cache, I/O and runner overhead in the analytic ideal.',
      'Measured CLI excess includes all such overhead, timer overshoot and scheduling delay.',
      'Waiting tasks occupy a worker but are not a CPU-heavy workload.',
      'Task start timestamps observe process starts, not the internal ready-queue dispatch instant.',
      'Trace clock: native CLOCK_MONOTONIC via bun:ffi (macOS/libSystem or Linux/glibc), never a per-process or wall-clock origin.',
      'Turborepo ready order is not assumed to be FIFO; every observed order is retained.',
    ],
    witness: [
      { id: leftGate!.id, worker: 0, startMs: 0, endMs: 0 },
      { id: rightGate!.id, worker: 0, startMs: 0, endMs: 0 },
      { id: long!.id, worker: 0, startMs: 0, endMs: long!.dur },
      { id: left!.id, worker: 1, startMs: 0, endMs: left!.dur },
      { id: leftChild!.id, worker: 1, startMs: left!.dur, endMs: half },
      { id: right!.id, worker: 1, startMs: half, endMs: half + right!.dur },
      { id: rightChild!.id, worker: 1, startMs: half + right!.dur, endMs: long!.dur },
    ],
  }
}

export function parseCounterexampleOptions(
  argv: readonly string[],
  defaultOutput: string,
): Options {
  const options: Options = {
    longSeconds: 60,
    leafSeconds: 0.25,
    reps: 5,
    noiseMs: 1,
    output: defaultOutput,
  }
  const seen = new Set<string>()
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    const eq = arg.indexOf('=')
    const flag = eq < 0 ? arg : arg.slice(0, eq)
    if (!['--long', '--leaf', '--reps', '--noise-ms', '--output'].includes(flag)) {
      throw new Error(`unknown option: ${flag}`)
    }
    if (seen.has(flag)) throw new Error(`duplicate option: ${flag}`)
    seen.add(flag)
    const value = eq < 0 ? argv[++i] : arg.slice(eq + 1)
    if (value === undefined || value.trim() === '' || value.startsWith('--')) {
      throw new Error(`${flag} requires a value`)
    }
    if (flag === '--output') options.output = path.resolve(value)
    else {
      const number = Number(value)
      if (!Number.isFinite(number)) throw new Error(`${flag} requires a finite number`)
      if (flag === '--long') options.longSeconds = number
      if (flag === '--leaf') options.leafSeconds = number
      if (flag === '--reps') options.reps = number
      if (flag === '--noise-ms') options.noiseMs = number
    }
  }
  counterexampleShape(options.longSeconds, options.leafSeconds)
  if (!Number.isSafeInteger(options.reps) || options.reps < 1) {
    throw new Error('--reps requires a positive safe integer')
  }
  if (options.noiseMs < 0) throw new Error('--noise-ms must be nonnegative')
  return options
}

const taskSource = `import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { dlopen, ptr } from 'bun:ffi'
// Bun 1.4.2's hrtime and nanoseconds clocks have process-local origins.
// Native CLOCK_MONOTONIC is comparable across processes on this host.
const native = dlopen(process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6', {
  clock_gettime: { args: ['i32', 'ptr'], returns: 'i32' },
})
const timespec = new BigInt64Array(2)
const address = ptr(timespec)
const clock = process.platform === 'darwin' ? 6 : 1
const nowNs = () => {
  if (native.symbols.clock_gettime(clock, address) !== 0) throw new Error('CLOCK_MONOTONIC failed')
  return timespec[0] * 1000000000n + timespec[1]
}
if (process.argv[2] === '--clock-probe') {
  console.log(JSON.stringify({ monotonicNs: nowNs().toString(), processRelativeNs: process.hrtime.bigint().toString(), pid: process.pid }))
} else {
  const [id, rawMs] = process.argv.slice(2)
  const durationMs = Number(rawMs)
  if (!id || !/^[a-e]-[a-z-]+$/.test(id) || !Number.isFinite(durationMs) || durationMs <= 0) {
    throw new Error('invalid task arguments')
  }
  const trace = resolve('../../.bench/trace.jsonl')
  const event = (phase) => appendFileSync(trace, JSON.stringify({
    id, phase, monotonicNs: nowNs().toString(), pid: process.pid, durationMs,
  }) + '\\n')
  event('start')
  const deadline = nowNs() + BigInt(Math.ceil(durationMs * 1e6))
  while (nowNs() < deadline) {
    await Bun.sleep(Math.max(1, Number(deadline - nowNs()) / 1e6))
  }
  mkdirSync('dist', { recursive: true })
  writeFileSync('dist/' + id + '.json', JSON.stringify({ id, durationMs }) + '\\n')
  event('end')
}
native.close()
`

export function counterexampleFixtureFiles(tasks: readonly SimTask[], installTurbo: boolean) {
  const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n'
  const scripts = Object.fromEntries(
    tasks
      .filter((task) => task.dur > 0)
      .map((task) => [
        task.id,
        `bun --no-env-file --no-install src/task.mjs ${task.id} ${task.dur}`,
      ]),
  )
  const inputs = ['src/**']
  return {
    '.gitignore': 'node_modules\ndist\n.vx\n.turbo\n.bench\n',
    'package.json': json({
      name: 'counterexample-root',
      private: true,
      version: '0.0.0',
      packageManager: `bun@${BUN_VERSION}`,
      workspaces: ['packages/*'],
      ...(installTurbo ? { devDependencies: { turbo: TURBO_VERSION } } : {}),
    }),
    'vx.workspace.mjs': 'export default { plugins: [] }\n',
    'turbo.json': json({
      tasks: Object.fromEntries(
        tasks.map((task) => [
          task.id,
          task.dur > 0
            ? { dependsOn: task.deps, inputs, outputs: [`dist/${task.id}.json`] }
            : { dependsOn: task.deps },
        ]),
      ),
    }),
    [`${PACKAGE_DIR}/package.json`]: json({
      name: PACKAGE,
      private: true,
      version: '0.0.0',
      scripts,
    }),
    [`${PACKAGE_DIR}/vx.config.mjs`]: `export default ${json({
      tasks: Object.fromEntries(
        tasks.map((task) => [
          task.id,
          task.dur > 0
            ? {
                dependsOn: task.deps,
                exec: { command: scripts[task.id] },
                cache: { inputs: { files: inputs }, outputs: { files: [`dist/${task.id}.json`] } },
              }
            : { dependsOn: task.deps },
        ]),
      ),
    })}`,
    [`${PACKAGE_DIR}/src/task.mjs`]: taskSource,
  }
}

/** An allowlist avoids passing credentials, remote cache settings, Bun preloads or vx plugins. */
export function counterexampleEnv(
  inherited: Record<string, string | undefined>,
  home: string,
  bin: string,
): Record<string, string> {
  return {
    PATH: `${bin}${path.delimiter}${inherited['PATH'] ?? ''}`,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    LANG: 'C',
    LC_ALL: 'C',
    CI: '1',
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    DO_NOT_TRACK: '1',
    TURBO_TELEMETRY_DISABLED: '1',
    ...(inherited['SystemRoot'] ? { SystemRoot: inherited['SystemRoot'] } : {}),
  }
}

export interface TraceEvent {
  id: string
  phase: 'start' | 'end'
  monotonicNs: string
  pid: number
  durationMs: number
}

interface TraceRun {
  exitCode: number
  cacheHits: number | null
  events: readonly TraceEvent[]
  outputs: Readonly<Record<string, string>>
}

export function assertTraceConformance(tasks: readonly SimTask[], run: TraceRun) {
  if (run.exitCode !== 0) throw new Error(`child failed: exit ${run.exitCode}`)
  if (run.cacheHits !== 0) throw new Error(`expected zero cache hits, observed ${run.cacheHits}`)
  const executable = tasks.filter((task) => task.dur > 0)
  const commandless = tasks.filter((task) => task.dur === 0)
  const nodes = new Map(tasks.map((task) => [task.id, task]))
  if (
    nodes.size !== tasks.length ||
    tasks.some((task) => !Number.isFinite(task.dur) || task.dur < 0)
  )
    throw new Error('invalid DAG nodes or durations')
  if (executable.length !== 5) throw new Error('expected exactly five executable DAG nodes')
  if (commandless.some((task) => task.deps.length !== 0))
    throw new Error('trace conformance supports untraced commandless root gates only')
  if (run.events.length !== executable.length * 2)
    throw new Error('expected exactly five starts and five ends')
  const ids = new Set(executable.map((task) => task.id))
  if (Object.keys(run.outputs).length !== executable.length)
    throw new Error('expected exactly five output files')
  const starts = new Map<string, TraceEvent>()
  const ends = new Map<string, TraceEvent>()
  for (const event of run.events) {
    if (
      !ids.has(event.id) ||
      !['start', 'end'].includes(event.phase) ||
      typeof event.monotonicNs !== 'string' ||
      !/^\d+$/.test(event.monotonicNs) ||
      !Number.isSafeInteger(event.pid) ||
      event.pid <= 0
    ) {
      throw new Error('invalid trace event')
    }
    const table = event.phase === 'start' ? starts : ends
    if (table.has(event.id)) throw new Error(`duplicate ${event.phase}: ${event.id}`)
    table.set(event.id, event)
    if (event.phase === 'end' && !starts.has(event.id))
      throw new Error(`end precedes start: ${event.id}`)
  }
  for (const task of executable) {
    const start = starts.get(task.id)
    const end = ends.get(task.id)
    if (!start || !end) throw new Error(`missing execution: ${task.id}`)
    if (start.durationMs !== task.dur || end.durationMs !== task.dur || start.pid !== end.pid) {
      throw new Error(`execution identity/duration mismatch: ${task.id}`)
    }
    if (BigInt(end.monotonicNs) - BigInt(start.monotonicNs) < BigInt(Math.ceil(task.dur * 1e6))) {
      throw new Error(`task ran shorter than declared: ${task.id}`)
    }
    const expected = JSON.stringify({ id: task.id, durationMs: task.dur }) + '\n'
    if (run.outputs[`${task.id}.json`] !== expected) throw new Error(`wrong output: ${task.id}`)
    for (const dep of task.deps) {
      const parent = nodes.get(dep)
      if (!parent) throw new Error(`undeclared dependency: ${dep} -> ${task.id}`)
      // A commandless root is a structural prerequisite, not an observed process span.
      if (parent.dur === 0) continue
      if (!ends.has(dep) || BigInt(start.monotonicNs) < BigInt(ends.get(dep)!.monotonicNs)) {
        throw new Error(`dependency timing violated: ${dep} -> ${task.id}`)
      }
    }
  }
  const sorted = [...run.events].sort((a, b) => {
    const delta = BigInt(a.monotonicNs) - BigInt(b.monotonicNs)
    return delta < 0n ? -1 : delta > 0n ? 1 : a.phase === b.phase ? 0 : a.phase === 'end' ? -1 : 1
  })
  let active = 0
  let peakConcurrency = 0
  for (const event of sorted) {
    active += event.phase === 'start' ? 1 : -1
    peakConcurrency = Math.max(peakConcurrency, active)
    if (active < 0 || active > 2) throw new Error('trace exceeds concurrency 2')
  }
  if (active !== 0) throw new Error('unfinished trace')
  return {
    dagNodes: tasks.length,
    executions: starts.size,
    untracedCommandlessNodes: commandless.map((task) => task.id),
    untracedMeaning:
      'Commandless root gates have no task processes, outputs or trace timestamps; their readiness timing is not trace-verified.',
    cacheHits: 0,
    peakConcurrency,
    observedDispatchOrder: sorted
      .filter((event) => event.phase === 'start')
      .map((event) => event.id),
    orderMeaning: 'host-monotonic task-process start order; not internal scheduler dispatch order',
  }
}

export function cliCacheHits(runner: Runner, stdout: string, stderr: string): number | null {
  const log = stripVTControlCharacters(`${stdout}\n${stderr}`)
  if (runner === 'turbo') {
    const cached = /Cached:\s+(\d+) cached,\s+5 total/.exec(log)
    return cached ? Number(cached[1]) : null
  }
  // vx's terminal tally excludes commandless groups: seven DAG nodes still mean five total/miss.
  // An absent/changed executable-task summary fails closed.
  if (!/\b5 success\b/.test(log) || !/\b5 total\b/.test(log) || !/\b5 miss\b/.test(log)) return null
  const hits = [...log.matchAll(/\b(\d+) (up-to-date|local|remote)\b/g)]
  return hits.reduce((sum, match) => sum + Number(match[1]), 0)
}

function spread(values: readonly number[]) {
  if (values.length === 0 || values.some((value) => !Number.isFinite(value))) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  const median = sorted.length % 2 === 0 ? sorted[mid - 1]! / 2 + sorted[mid]! / 2 : sorted[mid]!
  const mean = values.reduce((sum, value) => sum + value / values.length, 0)
  const stddev = Math.sqrt(
    values.reduce((sum, value) => sum + (value - mean) ** 2 / values.length, 0),
  )
  if (!Number.isFinite(stddev)) return null
  return {
    n: values.length,
    min: sorted[0]!,
    median,
    max: sorted.at(-1)!,
    range: sorted.at(-1)! - sorted[0]!,
    stddev,
  }
}

function ratio(numerator: number, denominator: number, noiseMs: number) {
  let reason: string | null = null
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) reason = 'invalid samples'
  else if (denominator <= 0) reason = 'nonpositive denominator'
  else if (numerator < 0) reason = 'numerator below analytic baseline'
  else if (denominator <= noiseMs) reason = 'denominator at/below noise floor'
  else if (!Number.isFinite(numerator / denominator)) reason = 'ratio outside finite range'
  return {
    value: reason === null ? numerator / denominator : null,
    reason,
    numeratorMs: Number.isFinite(numerator) ? numerator : null,
    denominatorMs: Number.isFinite(denominator) ? denominator : null,
  }
}

export function summarizeCounterexample(
  samples: Readonly<Record<Runner, readonly number[]>>,
  idealMs: number,
  noiseMs = 1,
) {
  if (!Number.isFinite(noiseMs) || noiseMs < 0) throw new Error('invalid noise floor')
  const validSamples =
    samples.vx.length === samples.turbo.length &&
    samples.vx.length > 0 &&
    [...samples.vx, ...samples.turbo].every((value) => Number.isFinite(value) && value >= 0)
  const baselineValid = Number.isFinite(idealMs) && idealMs > 0
  const totals = {
    vx: validSamples ? spread(samples.vx) : null,
    turbo: validSamples ? spread(samples.turbo) : null,
  }
  const excess = {
    vx: validSamples && baselineValid ? spread(samples.vx.map((value) => value - idealMs)) : null,
    turbo:
      validSamples && baselineValid ? spread(samples.turbo.map((value) => value - idealMs)) : null,
  }
  const totalRatio =
    totals.vx && totals.turbo
      ? ratio(totals.vx.median, totals.turbo.median, noiseMs)
      : {
          value: null,
          reason: 'invalid or incomplete samples',
          numeratorMs: null,
          denominatorMs: null,
        }
  const excessRatio =
    excess.vx && excess.turbo
      ? ratio(excess.vx.median, excess.turbo.median, noiseMs)
      : {
          value: null,
          reason: baselineValid ? 'invalid or incomplete samples' : 'invalid analytic baseline',
          numeratorMs: null,
          denominatorMs: null,
        }
  // A denominator smaller than its observed full spread is not a stable amplification claim.
  if (
    excessRatio.reason === null &&
    excess.turbo &&
    excess.vx &&
    (excess.turbo.min <= noiseMs || excess.turbo.range >= excess.turbo.median || excess.vx.min < 0)
  ) {
    excessRatio.value = null
    excessRatio.reason = 'excess is unresolved against baseline/noise/spread'
  }
  return {
    idealMs: baselineValid ? idealMs : null,
    noiseMs,
    aggregation:
      'ratio of all-sample medians; no sample filtering; spread envelope is NOT a confidence interval',
    totals,
    excess,
    totalRatio,
    excessRatio,
    excessRatioEnvelope:
      excess.vx && excess.turbo && excessRatio.reason === null
        ? {
            lower: ratio(excess.vx.min, excess.turbo.max, noiseMs).value,
            upper: ratio(excess.vx.max, excess.turbo.min, noiseMs).value,
          }
        : null,
    pairs: validSamples
      ? samples.vx.map((value, i) => ({
          round: i + 1,
          total: ratio(value, samples.turbo[i]!, noiseMs),
          excess: baselineValid
            ? ratio(value - idealMs, samples.turbo[i]! - idealMs, noiseMs)
            : null,
        }))
      : [],
  }
}

interface ProcessMeasurement {
  argv: string[]
  cwd: string
  startedAt: string
  pid: number
  exitCode: number
  signal: string | null
  elapsedMs: number
  cpu: { userMs: number; systemMs: number; totalMs: number } | null
  stdout: string
  stderr: string
}

interface Sample extends Omit<ProcessMeasurement, 'pid' | 'exitCode' | 'elapsedMs' | 'startedAt'> {
  attemptId: string
  state: 'planned' | 'complete' | 'failed'
  queuedAt: string
  startedAt: string | null
  pid: number | null
  exitCode: number | null
  elapsedMs: number | null
  runner: Runner
  round: number
  position: number
  cacheDir: string
  traceJSONL: string
  events: TraceEvent[]
  outputs: Record<string, string>
  conformance: ReturnType<typeof assertTraceConformance> | null
  failure: string | null
}

export function createCounterexampleAttempt(
  input: Pick<Sample, 'argv' | 'cwd' | 'runner' | 'round' | 'position' | 'cacheDir'>,
): Sample {
  return {
    ...input,
    attemptId: `${input.round}-${input.runner}`,
    state: 'planned',
    queuedAt: new Date().toISOString(),
    startedAt: null,
    pid: null,
    exitCode: null,
    signal: null,
    elapsedMs: null,
    cpu: null,
    stdout: '',
    stderr: '',
    traceJSONL: '',
    events: [],
    outputs: {},
    conformance: null,
    failure: null,
  }
}

export async function runCounterexampleAttempt(
  sample: Sample,
  hooks: {
    journal: (sample: Readonly<Sample>) => Promise<void>
    execute: (sample: Sample) => Promise<void>
    capture: (sample: Sample) => Promise<void>
  },
): Promise<void> {
  await hooks.journal(sample)
  try {
    await hooks.execute(sample)
  } catch (error) {
    sample.failure = message(error)
  }
  // Capture whatever exists even when spawn or stream handling failed.
  try {
    await hooks.capture(sample)
  } catch (error) {
    sample.failure = sample.failure
      ? `${sample.failure}; capture: ${message(error)}`
      : message(error)
  }
  sample.state = sample.failure === null ? 'complete' : 'failed'
  await hooks.journal(sample)
  if (sample.failure !== null)
    throw new Error(
      `${sample.runner} round ${sample.round}: ${sample.failure}; all attempted samples retained`,
    )
}

interface Results {
  schemaVersion: 1
  kind: 'synthetic-scheduling-counterexample'
  measurement: 'real-cli-subprocess'
  warning: string
  status: 'preparing' | 'running' | 'complete' | 'failed'
  createdAt: string
  options: Options
  model: ReturnType<typeof analyticBaseline>
  tasks: SimTask[]
  provenance: Record<string, unknown>
  fixture: string | null
  fixtureSources: Record<string, { sha256: string; content: string }>
  preparation: ProcessMeasurement[]
  samples: Sample[]
  summary: ReturnType<typeof summarizeCounterexample> | null
  failure: string | null
}

export function renderCounterexampleReport(
  result: Pick<Results, 'status' | 'model' | 'samples' | 'summary' | 'provenance' | 'failure'>,
): string {
  const fmt = (value: number | null | undefined) =>
    value == null || !Number.isFinite(value) ? 'unresolved' : value.toFixed(3)
  const lines = [
    '# Scheduling counterexample',
    '',
    `> ${SYNTHETIC_WARNING}`,
    '',
    `Status: ${result.status}. No favorable-sample filtering; failed runs are fatal.`,
    '',
    `Analytical case: ${result.model.caseLabel}; ${result.model.dagNodes} DAG nodes, ${result.model.executableTasks} executable tasks.`,
    result.model.gatePurpose,
    `Untraced commandless root gates: ${result.model.commandlessGates.join(', ')}. They have no scripts, output files or task-process traces; their readiness timing is not trace-verified.`,
    `Earlier comparator: ${result.model.predecessor.caseLabel}, source commit ${result.model.predecessor.sourceCommit}; retained separately in packages/vx-bench/${result.model.predecessor.artifacts.join(', packages/vx-bench/')}.`,
    result.model.predecessor.comparisonPolicy,
    '',
    `Analytic ideal: ${fmt(result.model.idealMs)} ms; work ${fmt(result.model.workMs)} ms; critical path ${fmt(result.model.criticalPathMs)} ms; concurrency 2.`,
    result.model.proof,
    '',
    'Witness: both root gates complete at zero duration on worker 0, then worker 0 runs a-long; worker 1 runs b-left → d-left-child → c-right → e-right-child.',
    '',
    ...result.model.assumptions.map((assumption) => `- ${assumption}`),
    '',
  ]
  if (result.status === 'complete' && result.summary) {
    const summary = result.summary
    lines.push(
      '| Runner | Total median ms | Total min–max ms | Excess median ms | Excess min–max ms |',
      '| --- | ---: | --- | ---: | --- |',
    )
    for (const runner of ['vx', 'turbo'] as const) {
      const total = summary.totals[runner]
      const extra = summary.excess[runner]
      lines.push(
        `| ${runner === 'turbo' ? 'Turborepo' : runner} | ${fmt(total?.median)} | ${fmt(total?.min)}–${fmt(total?.max)} | ${fmt(extra?.median)} | ${fmt(extra?.min)}–${fmt(extra?.max)} |`,
      )
    }
    lines.push(
      '',
      `Measured TOTAL ratio (vx / Turborepo): ${fmt(summary.totalRatio.value)}×.`,
      `Measured EXCESS ratio ((vx − ideal) / (Turborepo − ideal)): ${fmt(summary.excessRatio.value)}×.`,
      `Excess denominator: ${fmt(summary.excessRatio.denominatorMs)} ms; configured noise floor: ${fmt(summary.noiseMs)} ms.`,
      `Excess ratio envelope over ALL samples: ${fmt(summary.excessRatioEnvelope?.lower)}–${fmt(summary.excessRatioEnvelope?.upper)}× (not a confidence interval).`,
      `Ratio status: ${summary.excessRatio.reason ?? 'resolved at configured noise floor and observed spread'}.`,
      summary.aggregation,
      '',
      'A large excess ratio is amplification of avoidable overhead/delay, NOT that much faster total execution.',
      '',
    )
  } else lines.push('No performance claim: incomplete or failed measurement.', '')
  lines.push(
    '| Round | Position | Runner | Elapsed ms | CPU ms | Exit | Observed task-start order |',
    '| ---: | ---: | --- | ---: | ---: | ---: | --- |',
  )
  for (const sample of result.samples) {
    lines.push(
      `| ${sample.round} | ${sample.position} | ${sample.runner} | ${fmt(sample.elapsedMs)} | ${fmt(sample.cpu?.totalMs)} | ${sample.exitCode ?? 'unknown'} | ${sample.conformance?.observedDispatchOrder.join(' → ') ?? 'nonconforming; see raw trace'} |`,
    )
  }
  lines.push(
    '',
    'All raw JSONL traces, outputs, argv, stdout/stderr, CPU samples, source hashes and preparation logs are in counterexample-results.json.',
    'Elapsed time uses a host monotonic clock around the real CLI subprocess, including startup and exit. CPU uses Bun resourceUsage (microseconds converted to ms): process plus waited-for descendants, not any detached daemon. Daemons and remote caching are disabled.',
    'Each sample has an empty isolated local cache and deleted outputs/trace. No warmup, cache-hit samples, retries or omitted outliers.',
    '',
    '## Provenance',
    '',
    '```json',
    JSON.stringify(result.provenance, null, 2),
    '```',
    '',
  )
  if (result.failure) lines.push(`Failure: ${result.failure}`, '')
  return lines.join('\n')
}

const sha256 = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

async function measure(
  argv: string[],
  cwd: string,
  env: Record<string, string>,
  progress: (fields: Partial<ProcessMeasurement>) => void = () => {},
): Promise<ProcessMeasurement> {
  const startedAt = new Date().toISOString()
  progress({ startedAt })
  const start = process.hrtime.bigint()
  const child = Bun.spawn({ cmd: argv, cwd, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  progress({ pid: child.pid })
  const exited = child.exited.then((exitCode) => {
    const finished = { exitCode, elapsedMs: Number(process.hrtime.bigint() - start) / 1e6 }
    progress({ ...finished, signal: child.signalCode ?? null })
    return finished
  })
  let out: Promise<string> | undefined
  let err: Promise<string> | undefined
  try {
    out = new Response(child.stdout).text().then((stdout) => {
      progress({ stdout })
      return stdout
    })
    err = new Response(child.stderr).text().then((stderr) => {
      progress({ stderr })
      return stderr
    })
    const [finished, stdout, stderr] = await Promise.all([exited, out, err])
    const usage = child.resourceUsage()
    const cpu = usage
      ? {
          userMs: Number(usage.cpuTime.user) / 1000,
          systemMs: Number(usage.cpuTime.system) / 1000,
          totalMs: Number(usage.cpuTime.user + usage.cpuTime.system) / 1000,
        }
      : null
    return {
      argv,
      cwd,
      startedAt,
      pid: child.pid,
      ...finished,
      signal: child.signalCode ?? null,
      cpu,
      stdout,
      stderr,
    }
  } catch (error) {
    // A rejected stream must not leave a benchmark child running outside the attempt record.
    try {
      if (child.exitCode === null) child.kill()
    } catch (cleanupError) {
      throw new Error(`${message(error)}; child cleanup failed: ${message(cleanupError)}`)
    }
    await Promise.allSettled([exited, out, err])
    throw error
  }
}

async function main(): Promise<void> {
  if (process.argv.includes('--help')) {
    console.log(
      'counterexample.ts [--long 60] [--leaf 0.25] [--reps 5] [--noise-ms 1] [--output NEW_DIRECTORY]\nVX_BIN / TURBO_BIN: optional standalone binaries; otherwise compile vx / install turbo@2.11.7 in temporary fixture.',
    )
    return
  }
  const repo = path.resolve(import.meta.dir, '../..')
  const options = parseCounterexampleOptions(process.argv.slice(2), import.meta.dir)
  if (Bun.version !== BUN_VERSION)
    throw new Error(`requires Bun ${BUN_VERSION}; got ${Bun.version}`)
  if (!['darwin', 'linux'].includes(process.platform))
    throw new Error('requires macOS or Linux/glibc for the native shared monotonic trace clock')
  const tasks = counterexampleShape(options.longSeconds, options.leafSeconds)
  const result: Results = {
    schemaVersion: 1,
    kind: 'synthetic-scheduling-counterexample',
    measurement: 'real-cli-subprocess',
    warning: SYNTHETIC_WARNING,
    status: 'preparing',
    createdAt: new Date().toISOString(),
    options,
    model: analyticBaseline(options.longSeconds, options.leafSeconds),
    tasks,
    provenance: {},
    fixture: null,
    fixtureSources: {},
    preparation: [],
    samples: [],
    summary: null,
    failure: null,
  }
  await mkdir(options.output, { recursive: true })
  const resultPath = path.join(options.output, RESULTS)
  const reportPath = path.join(options.output, REPORT)
  // Reserve both paths before any expensive work; never overwrite an earlier experiment.
  await writeFile(reportPath, renderCounterexampleReport(result), { flag: 'wx' })
  await writeFile(resultPath, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' })
  const save = async () => {
    await writeFile(resultPath, JSON.stringify(result, null, 2) + '\n')
    await writeFile(reportPath, renderCounterexampleReport(result))
  }
  try {
    const scratch = await realpath(await mkdtemp(path.join(os.tmpdir(), 'vx-counterexample-')))
    const fixture = path.join(scratch, 'fixture')
    const home = path.join(scratch, 'home')
    const bin = path.join(scratch, 'bin')
    await Promise.all([fixture, home, bin].map((dir) => mkdir(dir, { recursive: true })))
    await symlink(process.execPath, path.join(bin, 'bun'))
    const env = counterexampleEnv(process.env, home, bin)
    result.fixture = fixture
    const prepare = async (argv: string[], cwd = fixture) => {
      const measured = await measure(argv, cwd, env)
      result.preparation.push(measured)
      await save()
      if (measured.exitCode !== 0)
        throw new Error(
          `preparation failed: ${path.basename(argv[0]!)} (exit ${measured.exitCode}); see preparation logs`,
        )
      return measured.stdout.trim()
    }
    const commit = await prepare(['git', 'rev-parse', 'HEAD'], repo)
    if (!/^[0-9a-f]{40,64}$/.test(commit)) throw new Error('missing immutable git commit')
    const branch = await prepare(['git', 'branch', '--show-current'], repo)
    const dirtyStatus = await prepare(['git', 'status', '--porcelain'], repo)
    // A compiled checkout binary is associated with HEAD only if its source matches HEAD.
    await prepare(
      [
        'git',
        'diff',
        '--exit-code',
        'HEAD',
        '--',
        'packages/vx/src',
        'packages/vx/package.json',
        'bun.lock',
      ],
      repo,
    )
    const untrackedCore = await prepare(
      ['git', 'ls-files', '--others', '--exclude-standard', 'packages/vx/src'],
      repo,
    )
    if (untrackedCore)
      throw new Error('untracked core source prevents immutable-commit attribution')
    const coreFiles = (
      await prepare(
        ['git', 'ls-files', 'packages/vx/src', 'packages/vx/package.json', 'bun.lock'],
        repo,
      )
    )
      .split('\n')
      .filter(Boolean)
    const coreIntegrity = async () => {
      const hashes = Object.fromEntries(
        await Promise.all(
          coreFiles.map(
            async (file) => [file, sha256(await readFile(path.join(repo, file)))] as const,
          ),
        ),
      )
      return { files: hashes, sha256: sha256(JSON.stringify(hashes)) }
    }
    const core = await coreIntegrity()
    const harnessHash = sha256(await readFile(import.meta.path))
    result.provenance = {
      git: { commit, branch, dirtyStatus },
      harness: { path: import.meta.path, sha256: harnessHash },
      coreSource: core,
      bun: {
        version: Bun.version,
        revision: await prepare([process.execPath, '--revision']),
        executable: process.execPath,
        sha256: sha256(await readFile(process.execPath)),
      },
      gitVersion: await prepare(['git', '--version']),
      host: {
        platform: process.platform,
        arch: process.arch,
        release: os.release(),
        cores: os.cpus().length,
        availableParallelism: os.availableParallelism(),
        cpuModels: [...new Set(os.cpus().map((cpu) => cpu.model))],
        totalMemoryBytes: os.totalmem(),
      },
      harnessArgv: [...process.argv],
      environmentPolicy:
        'allowlist: isolated HOME/XDG; PATH prefixed with exact Bun; no inherited TURBO_*, VX_*, BUN_*, NODE_OPTIONS, NODE_PATH or credentials; no dotenv; local caches only',
      preparationTimedAsSamples: false,
      orderPolicy:
        'odd rounds vx then turbo; even rounds turbo then vx; keep every attempted sample, abort on failure',
      cpuUnits:
        'Bun cpuTime user/system are microseconds, divided by 1000; process plus waited-for descendants',
    }
    const externalTurbo = process.env['TURBO_BIN']
    const files = counterexampleFixtureFiles(tasks, !externalTurbo)
    for (const [file, content] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(fixture, file)), { recursive: true })
      await writeFile(path.join(fixture, file), content)
    }
    await mkdir(path.join(fixture, '.bench'), { recursive: true })
    await prepare([
      process.execPath,
      '--no-env-file',
      'install',
      '--ignore-scripts',
      '--no-progress',
      ...(externalTurbo ? ['--lockfile-only'] : []),
    ])
    let turboBin: string
    let turboNativePackage: {
      name: string
      version: string
      packageJson: string
      sha256: string
    } | null = null
    if (externalTurbo) turboBin = await realpath(path.resolve(externalTurbo))
    else {
      // Bun's isolated layout keeps optional dependencies next to the REAL package, not its symlink.
      const packageJson = await realpath(path.join(fixture, 'node_modules/turbo/package.json'))
      const pkg = JSON.parse(await readFile(packageJson, 'utf8')) as TurboPackage
      const spec = turboNativeExecutableSpec(pkg, process.platform, process.arch)
      const requireTurbo = createRequire(packageJson)
      const nativePackageJson = requireTurbo.resolve(`${spec.packageName}/package.json`)
      const nativeBytes = await readFile(nativePackageJson)
      const nativePkg = JSON.parse(nativeBytes.toString()) as { name: string; version: string }
      if (nativePkg.name !== spec.packageName || nativePkg.version !== spec.version)
        throw new Error(
          'installed native Turborepo package does not match its pinned optional dependency',
        )
      turboNativePackage = {
        ...nativePkg,
        packageJson: nativePackageJson,
        sha256: sha256(nativeBytes),
      }
      turboBin = await realpath(requireTurbo.resolve(spec.executable))
    }
    const turboHeaderFormat = nativeExecutableFormat(await readFile(turboBin))
    const externalVx = process.env['VX_BIN']
    const vxBin = externalVx ? await realpath(path.resolve(externalVx)) : path.join(bin, 'vx')
    if (!externalVx) {
      await prepare(
        [
          process.execPath,
          '--no-env-file',
          'build',
          '--compile',
          '--no-compile-autoload-dotenv',
          '--compile-autoload-package-json',
          '--minify',
          '--bytecode',
          `--target=bun-${process.platform}-${process.arch}`,
          path.join(repo, 'packages/vx/src/bin.ts'),
          '--outfile',
          vxBin,
        ],
        repo,
      )
      if (process.platform === 'darwin') await prepare(['codesign', '--force', '-s', '-', vxBin])
    }
    const vxVersion = await prepare([vxBin, '--version'])
    const expectedVxVersion = (
      JSON.parse(await readFile(path.join(repo, 'packages/vx/package.json'), 'utf8')) as {
        version: string
      }
    ).version
    if (vxVersion !== `vx ${expectedVxVersion}`)
      throw new Error(`vx version mismatch: ${vxVersion}`)
    const turboVersion = await prepare([turboBin, '--version'])
    if (turboVersion !== TURBO_VERSION)
      throw new Error(`requires turbo ${TURBO_VERSION}; got ${turboVersion}`)
    const binaryHashes = {
      vx: sha256(await readFile(vxBin)),
      turbo: sha256(await readFile(turboBin)),
    }
    result.provenance['tools'] = {
      vx: {
        path: vxBin,
        version: vxVersion,
        sha256: binaryHashes.vx,
        sourceCommit: externalVx ? null : commit,
        origin: externalVx
          ? 'external binary; source origin unverified'
          : 'compiled from clean core source at recorded commit; minify + bytecode; ad-hoc signed on macOS',
      },
      turbo: {
        path: turboBin,
        version: turboVersion,
        sha256: binaryHashes.turbo,
        headerFormat: turboHeaderFormat,
        executionMode: 'native-direct',
        nativePackage: turboNativePackage,
        origin: externalTurbo
          ? 'native direct run of external pinned-version ELF/Mach-O executable; no Node launcher'
          : 'native direct run of pinned installed platform optional dependency; Node launcher bypassed',
      },
    }
    const clockProbes: { monotonicNs: string; processRelativeNs: string; pid: number }[] = []
    for (let probe = 0; probe < 2; probe++) {
      const clockProbe = JSON.parse(
        await prepare([
          process.execPath,
          '--no-env-file',
          '--no-install',
          path.join(fixture, PACKAGE_DIR, 'src/task.mjs'),
          '--clock-probe',
        ]),
      ) as { monotonicNs: string; processRelativeNs: string; pid: number }
      if (
        !/^\d+$/.test(clockProbe.monotonicNs) ||
        !/^\d+$/.test(clockProbe.processRelativeNs) ||
        BigInt(clockProbe.monotonicNs) <= BigInt(clockProbe.processRelativeNs) + 1_000_000_000n ||
        (probe > 0 && BigInt(clockProbe.monotonicNs) <= BigInt(clockProbes[probe - 1]!.monotonicNs))
      ) {
        throw new Error('native monotonic clock preflight failed; no cross-process trace claim')
      }
      clockProbes.push(clockProbe)
    }
    result.provenance['traceClock'] = {
      method: 'native clock_gettime(CLOCK_MONOTONIC) via bun:ffi',
      units: 'nanoseconds as decimal strings; timespec int64 seconds + int64 nanoseconds',
      probes: clockProbes,
    }
    // Nothing is installed or compiled after git starts tracking fixture inputs; no fixture commit needed.
    await prepare(['git', 'init', '-q'])
    await prepare(['git', 'add', '-A'])
    await prepare([vxBin, 'lock'])
    const sourceNames = [...Object.keys(files), 'bun.lock', 'vx-lock.json']
    for (const file of sourceNames) {
      const content = await readFile(path.join(fixture, file), 'utf8')
      result.fixtureSources[file] = { sha256: sha256(content), content }
    }
    result.status = 'running'
    await save()
    for (let round = 1; round <= options.reps; round++) {
      const order: Runner[] = round % 2 === 1 ? ['vx', 'turbo'] : ['turbo', 'vx']
      for (const [index, runner] of order.entries()) {
        await rm(path.join(fixture, '.vx'), { recursive: true, force: true })
        await rm(path.join(fixture, '.turbo'), { recursive: true, force: true })
        await rm(path.join(fixture, PACKAGE_DIR, 'dist'), { recursive: true, force: true })
        await rm(path.join(fixture, TRACE), { force: true })
        const cacheDir = path.join(fixture, '.bench/cache', `${round}-${runner}`)
        await rm(cacheDir, { recursive: true, force: true })
        await mkdir(cacheDir, { recursive: true })
        if ((await readdir(cacheDir)).length !== 0) throw new Error('cache is not cold')
        const argv =
          runner === 'vx'
            ? [
                vxBin,
                'run',
                ...tasks.map((task) => task.id),
                '--all',
                '--frozen',
                '--concurrency=2',
                `--cache-dir=${cacheDir}`,
                '--cache=local:rw,remote:',
              ]
            : [
                turboBin,
                'run',
                ...tasks.map((task) => task.id),
                `--filter=${PACKAGE}`,
                '--concurrency=2',
                `--cache-dir=${cacheDir}`,
                '--cache=local:rw',
                '--no-daemon',
                '--env-mode=strict',
                '--output-logs=full',
                '--log-order=stream',
              ]
        const sample = createCounterexampleAttempt({
          argv,
          cwd: fixture,
          runner,
          round,
          position: index + 1,
          cacheDir,
        })
        result.samples.push(sample)
        await runCounterexampleAttempt(sample, {
          journal: async (attempt) => {
            await appendFile(
              path.join(options.output, 'counterexample-samples.jsonl'),
              JSON.stringify(attempt) + '\n',
            )
            await save()
          },
          execute: async (attempt) => {
            const measured = await measure(
              argv,
              fixture,
              { ...env, VX_CACHE_DIR: cacheDir },
              (fields) => {
                Object.assign(attempt, fields)
              },
            )
            Object.assign(attempt, measured)
          },
          capture: async (attempt) => {
            // Retain raw data BEFORE decoding or checking it, even for a failed subprocess.
            try {
              attempt.traceJSONL = await readFile(path.join(fixture, TRACE), 'utf8')
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
            }
            const outputDir = path.join(fixture, PACKAGE_DIR, 'dist')
            let outputFiles: string[] = []
            try {
              outputFiles = await readdir(outputDir)
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
            }
            for (const file of outputFiles)
              attempt.outputs[file] = await readFile(path.join(outputDir, file), 'utf8')
            attempt.events = attempt.traceJSONL
              .trim()
              .split('\n')
              .filter(Boolean)
              .map((line) => JSON.parse(line) as TraceEvent)
            if (attempt.failure !== null) return
            if (attempt.exitCode === null || attempt.elapsedMs === null || attempt.pid === null)
              throw new Error('incomplete subprocess measurement')
            attempt.conformance = assertTraceConformance(tasks, {
              exitCode: attempt.exitCode,
              cacheHits: cliCacheHits(runner, attempt.stdout, attempt.stderr),
              events: attempt.events,
              outputs: attempt.outputs,
            })
            if (attempt.cpu === null) throw new Error('subprocess CPU accounting is unavailable')
            for (const [file, source] of Object.entries(result.fixtureSources)) {
              if (sha256(await readFile(path.join(fixture, file))) !== source.sha256)
                throw new Error(`fixture input changed: ${file}`)
            }
          },
        })
        console.log(
          `round ${round}/${options.reps} ${runner}: ${(sample.elapsedMs! / 1000).toFixed(3)} s; ${sample.conformance!.observedDispatchOrder.join(', ')}`,
        )
      }
    }
    if (
      (await coreIntegrity()).sha256 !== core.sha256 ||
      sha256(await readFile(import.meta.path)) !== harnessHash ||
      sha256(await readFile(vxBin)) !== binaryHashes.vx ||
      sha256(await readFile(turboBin)) !== binaryHashes.turbo
    ) {
      throw new Error('source or binary integrity changed during the experiment')
    }
    if (
      result.samples.some(
        (sample) =>
          sample.state !== 'complete' || sample.conformance === null || sample.elapsedMs === null,
      )
    )
      throw new Error('incomplete attempt prevents benchmark summary')
    result.summary = summarizeCounterexample(
      {
        vx: result.samples
          .filter((sample) => sample.runner === 'vx')
          .map((sample) => sample.elapsedMs!),
        turbo: result.samples
          .filter((sample) => sample.runner === 'turbo')
          .map((sample) => sample.elapsedMs!),
      },
      result.model.idealMs,
      options.noiseMs,
    )
    result.status = 'complete'
    await save()
    console.log(`${SYNTHETIC_WARNING}\nResults: ${resultPath}\nReport: ${reportPath}`)
  } catch (error) {
    result.status = 'failed'
    result.summary = null
    result.failure = message(error)
    await save()
    throw error
  }
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    console.error(`counterexample: ${message(error)}`)
    process.exitCode = 1
  })
}
