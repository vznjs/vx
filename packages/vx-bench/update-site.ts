#!/usr/bin/env bun
// Publish two independent synthetic workloads; never replace the committed measurements.
// bun packages/vx-bench/update-site.ts [--check]
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  analyticBaseline,
  assertTraceConformance,
  cliCacheHits,
  counterexampleFixtureFiles,
  counterexampleShape,
  summarizeCounterexample,
  type TraceEvent,
} from './counterexample.js'

const ROOT = path.resolve(import.meta.dir, '../..')
const TARGETS = [
  'README.md',
  'packages/vx-docs/src/pages/index.astro',
  'packages/vx/docs/benchmarks.md',
] as const

type Row = {
  runner: string
  version: string
  fresh: number
  warmNoRestore: number
  warmRestore: number
  freshCpu: number
  warmNoRestoreCpu: number
}
type Results = {
  layers: number
  perLayer: number
  packages: number
  depsPerPkg: number
  concurrency: number
  reps: number
  buildSleep: string
  date: string
  machine: string
  rows: Row[]
  baseline: {
    fresh: number
    warmNoRestore: number
    warmRestore: number
    freshCpu: number
    warmNoRestoreCpu: number
    criticalPathMs: number
    workBoundMs: number
  }
}

function requireValue(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(`benchmark publication: ${message}`)
}
function record(value: unknown, name: string): Record<string, unknown> {
  requireValue(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    `${name} must be an object`,
  )
  return value as Record<string, unknown>
}
function number(value: unknown, name: string, positive = false): number {
  requireValue(
    typeof value === 'number' && Number.isFinite(value) && (positive ? value > 0 : value >= 0),
    `${name} must be a finite ${positive ? 'positive' : 'nonnegative'} number`,
  )
  return value
}
function string(value: unknown, name: string): string {
  requireValue(typeof value === 'string' && value.length > 0, `${name} must be a nonempty string`)
  return value
}
function canonical(value: unknown): string {
  if (typeof value === 'number')
    requireValue(Number.isFinite(value), 'nonfinite number cannot match a recorded metric')
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'undefined'
}
function same(actual: unknown, expected: unknown, name: string): void {
  requireValue(
    canonical(actual) === canonical(expected),
    `${name} does not match its source calculation`,
  )
}
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')
function digest(value: unknown, name: string): string {
  const text = string(value, name)
  requireValue(/^[a-f0-9]{64}$/.test(text), `${name} must be a SHA-256 digest`)
  return text
}

/** Only a complete, unfiltered five-round experiment can supply publication figures. */
export function validateCounterexample(input: unknown) {
  const result = record(input, 'counterexample')
  requireValue(
    result.schemaVersion === 1 &&
      result.kind === 'synthetic-scheduling-counterexample' &&
      result.measurement === 'real-cli-subprocess',
    'unsupported counterexample schema or measurement',
  )
  requireValue(
    result.status === 'complete' && result.failure === null,
    'counterexample must be complete with no failure',
  )
  const options = record(result.options, 'options')
  requireValue(options.reps === 5, 'counterexample requires five rounds')
  const longSeconds = number(options.longSeconds, 'longSeconds', true)
  const leafSeconds = number(options.leafSeconds, 'leafSeconds', true)
  const noiseMs = number(options.noiseMs, 'noiseMs')
  const tasks = counterexampleShape(longSeconds, leafSeconds)
  const model = analyticBaseline(longSeconds, leafSeconds)
  requireValue(
    model.caseId === 'two-commandless-readiness-gates' &&
      model.dagNodes === 7 &&
      model.executableTasks === 5,
    'primary publication requires the seven-node gated case with five executions',
  )
  same(model.commandlessGates, ['f-left-gate', 'g-right-gate'], 'two commandless root gates')
  same(result.tasks, tasks, 'tasks')
  same(result.model, model, 'analytic model and feasible witness')
  const date = string(result.createdAt, 'createdAt')
  requireValue(Number.isFinite(Date.parse(date)), 'invalid measurement date')
  const fixture = string(result.fixture, 'fixture')
  const provenance = record(result.provenance, 'provenance')
  const git = record(provenance.git, 'git provenance')
  const commit = string(git.commit, 'source commit')
  requireValue(/^[a-f0-9]{40,64}$/.test(commit), 'missing immutable source commit')
  const harness = record(provenance.harness, 'harness provenance')
  digest(harness.sha256, 'harness digest')
  const core = record(provenance.coreSource, 'core source provenance')
  const coreFiles = record(core.files, 'core source hashes')
  requireValue(
    'packages/vx/src/bin.ts' in coreFiles &&
      'packages/vx/package.json' in coreFiles &&
      'bun.lock' in coreFiles,
    'incomplete core source provenance',
  )
  for (const [file, hash] of Object.entries(coreFiles)) digest(hash, file)
  requireValue(
    digest(core.sha256, 'core source digest') === sha256(JSON.stringify(coreFiles)),
    'core source digest does not match its file hashes',
  )
  const bun = record(provenance.bun, 'Bun provenance')
  requireValue(bun.version === '1.4.2', 'measurement requires Bun 1.4.2')
  const bunRevision = string(bun.revision, 'Bun revision')
  requireValue(/^1\.4\.2\+[a-f0-9]+$/.test(bunRevision), 'missing exact Bun build revision')
  digest(bun.sha256, 'Bun executable digest')
  const host = record(provenance.host, 'host provenance')
  requireValue(
    ['darwin', 'linux'].includes(String(host.platform)) &&
      ['x64', 'arm64'].includes(String(host.arch)),
    'unsupported native measurement host',
  )
  const release = string(host.release, 'host release')
  const cores = number(host.cores, 'host cores', true)
  requireValue(
    Number.isSafeInteger(cores) &&
      Array.isArray(host.cpuModels) &&
      host.cpuModels.length > 0 &&
      host.cpuModels.every((item) => typeof item === 'string' && item.length > 0),
    'incomplete CPU provenance',
  )
  const tools = record(provenance.tools, 'tools')
  const vx = record(tools.vx, 'vx provenance')
  const turbo = record(tools.turbo, 'Turborepo provenance')
  const vxPath = string(vx.path, 'vx executable')
  const turboPath = string(turbo.path, 'Turborepo executable')
  const vxVersion = string(vx.version, 'vx version')
  requireValue(
    /^vx \d+\.\d+\.\d+(?:[-+].+)?$/.test(vxVersion) &&
      vx.sourceCommit === commit &&
      String(vx.origin).startsWith('compiled from clean core source'),
    'vx must be compiled from the recorded clean core commit',
  )
  requireValue(
    turbo.version === '2.11.7' &&
      turbo.executionMode === 'native-direct' &&
      turbo.headerFormat === (host.platform === 'darwin' ? 'Mach-O' : 'ELF'),
    'Turborepo must be pinned and invoked as a native binary, not a launcher',
  )
  digest(vx.sha256, 'vx executable digest')
  digest(turbo.sha256, 'Turborepo executable digest')
  if (turbo.nativePackage !== null) {
    const pkg = record(turbo.nativePackage, 'native Turborepo package')
    const suffix = `${String(host.platform)}-${host.arch === 'x64' ? '64' : String(host.arch)}`
    requireValue(
      [`@turbo/${suffix}`, `turbo-${suffix}`].includes(String(pkg.name)) &&
        pkg.version === turbo.version,
      'native Turborepo package does not match the host/version',
    )
    digest(pkg.sha256, 'native package digest')
  } else {
    requireValue(
      String(turbo.origin).startsWith('native direct run of external pinned-version'),
      'missing native Turborepo origin',
    )
  }
  requireValue(
    provenance.preparationTimedAsSamples === false,
    'preparation must be outside sample timers',
  )
  requireValue(
    Array.isArray(result.preparation) && result.preparation.length > 0,
    'missing preparation logs',
  )
  const preparation = result.preparation.map((entry) => record(entry, 'preparation entry'))
  requireValue(
    preparation.every((entry) => entry.exitCode === 0 && entry.signal === null),
    'failed preparation cannot be published',
  )
  for (const [executable, version] of [
    [vxPath, vxVersion],
    [turboPath, turbo.version],
  ]) {
    requireValue(
      preparation.some(
        (entry) =>
          canonical(entry.argv) === canonical([executable, '--version']) &&
          typeof entry.stdout === 'string' &&
          entry.stdout.trim() === version,
      ),
      'native tool version lacks a successful preparation probe',
    )
  }
  requireValue(
    preparation.some(
      (entry) =>
        Array.isArray(entry.argv) &&
        entry.argv.includes('--compile') &&
        entry.argv.includes(vxPath),
    ),
    'missing vx native compilation probe',
  )
  const traceClock = record(provenance.traceClock, 'trace clock')
  requireValue(
    traceClock.method === 'native clock_gettime(CLOCK_MONOTONIC) via bun:ffi' &&
      Array.isArray(traceClock.probes) &&
      traceClock.probes.length === 2,
    'missing shared monotonic clock probes',
  )
  let previous = 0n
  for (const probe of traceClock.probes) {
    const p = record(probe, 'clock probe')
    requireValue(
      typeof p.monotonicNs === 'string' &&
        /^\d+$/.test(p.monotonicNs) &&
        typeof p.processRelativeNs === 'string' &&
        /^\d+$/.test(p.processRelativeNs),
      'invalid clock probe',
    )
    const now = BigInt(p.monotonicNs)
    requireValue(
      now > previous && now > BigInt(p.processRelativeNs) + 1_000_000_000n,
      'process-relative clocks cannot substantiate task ordering',
    )
    previous = now
  }
  const sources = record(result.fixtureSources, 'fixture sources')
  const expectedSources = counterexampleFixtureFiles(tasks, turbo.nativePackage !== null)
  for (const [file, content] of Object.entries(expectedSources)) {
    const source = record(sources[file], `fixture source ${file}`)
    requireValue(
      source.content === content && source.sha256 === sha256(content),
      `fixture ${file} does not match the native graph/commands`,
    )
  }
  for (const file of ['bun.lock', 'vx-lock.json']) {
    const source = record(sources[file], `fixture source ${file}`)
    requireValue(
      source.sha256 === sha256(string(source.content, file)),
      `fixture ${file} digest mismatch`,
    )
  }
  requireValue(
    Array.isArray(result.samples) && result.samples.length === 10,
    'counterexample requires ten actual samples, without omissions',
  )
  const elapsed: Record<'vx' | 'turbo', number[]> = { vx: [], turbo: [] }
  for (const [index, entry] of result.samples.entries()) {
    const sample = record(entry, `sample ${index + 1}`)
    const round = Math.floor(index / 2) + 1
    const position = (index % 2) + 1
    const runner = ((round % 2 === 1) === (position === 1) ? 'vx' : 'turbo') as 'vx' | 'turbo'
    requireValue(
      sample.runner === runner &&
        sample.round === round &&
        sample.position === position &&
        sample.attemptId === `${round}-${runner}`,
      'samples must retain all five alternating rounds in actual order',
    )
    requireValue(
      sample.state === 'complete' &&
        sample.exitCode === 0 &&
        sample.signal === null &&
        sample.failure === null,
      'every sample must complete successfully',
    )
    requireValue(
      Number.isSafeInteger(sample.pid) &&
        Number(sample.pid) > 0 &&
        typeof sample.startedAt === 'string' &&
        Number.isFinite(Date.parse(sample.startedAt)),
      'missing actual subprocess identity',
    )
    const ms = number(sample.elapsedMs, 'sample elapsedMs', true)
    const cacheDir = path.join(fixture, '.bench/cache', `${round}-${runner}`)
    requireValue(
      sample.cwd === fixture && sample.cacheDir === cacheDir,
      'sample must use its own isolated fixture cache',
    )
    const argv =
      runner === 'vx'
        ? [
            vxPath,
            'run',
            ...tasks.map((task) => task.id),
            '--all',
            '--frozen',
            '--concurrency=2',
            `--cache-dir=${cacheDir}`,
            '--cache=local:rw,remote:',
          ]
        : [
            turboPath,
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
          ]
    same(sample.argv, argv, 'native sample invocation')
    requireValue(
      typeof sample.stdout === 'string' && typeof sample.stderr === 'string',
      'missing actual CLI output',
    )
    const cacheHits = cliCacheHits(runner, sample.stdout, sample.stderr)
    requireValue(cacheHits === 0, 'every sample must have zero cache hits')
    const trace = string(sample.traceJSONL, 'raw trace')
    const events = trace
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as TraceEvent)
    same(sample.events, events, 'raw and decoded trace')
    const outputs = record(sample.outputs, 'task outputs') as Record<string, string>
    const conformance = assertTraceConformance(tasks, { exitCode: 0, cacheHits, events, outputs })
    requireValue(
      conformance.dagNodes === model.dagNodes && conformance.executions === model.executableTasks,
      'trace must record five executions, not seven processes',
    )
    same(conformance.untracedCommandlessNodes, model.commandlessGates, 'untraced commandless gates')
    same(sample.conformance, conformance, 'trace conformance')
    const starts = events.map((event) => BigInt(event.monotonicNs))
    const first = starts.reduce((a, b) => (a < b ? a : b))
    const last = starts.reduce((a, b) => (a > b ? a : b))
    requireValue(
      ms >= Number(last - first) / 1e6,
      'CLI elapsed time is shorter than its actual task trace',
    )
    const cpu = record(sample.cpu, 'CPU accounting')
    const user = number(cpu.userMs, 'CPU userMs')
    const system = number(cpu.systemMs, 'CPU systemMs')
    requireValue(
      Math.round(number(cpu.totalMs, 'CPU totalMs') * 1000) ===
        Math.round(user * 1000) + Math.round(system * 1000),
      'CPU total does not match user + system at recorded microsecond precision',
    )
    elapsed[runner].push(ms)
  }
  // This is the harness's real consumer, not a second implementation that can drift.
  const summary = summarizeCounterexample(elapsed, model.idealMs, noiseMs)
  same(result.summary, summary, 'all summary metrics, pairs and spread envelope')
  requireValue(summary.totals.vx?.n === 5 && summary.totals.turbo?.n === 5, 'incomplete summary')
  return {
    summary,
    model,
    tasks,
    date,
    commit,
    vxVersion,
    turboVersion: String(turbo.version),
    bunRevision,
    release,
    cores,
    cpuModels: host.cpuModels as string[],
    platform: String(host.platform),
    arch: String(host.arch),
  }
}

function stressResults(input: unknown): Results {
  const d = record(input, 'stress results')
  for (const field of ['layers', 'perLayer', 'packages', 'depsPerPkg', 'concurrency', 'reps']) {
    requireValue(
      Number.isSafeInteger(number(d[field], field, true)),
      `stress ${field} must be a positive integer`,
    )
  }
  requireValue(
    d.packages === (Number(d.layers) - 1) * Number(d.perLayer) + 1,
    'stress package count does not match the generator',
  )
  string(d.date, 'stress date')
  string(d.machine, 'stress machine')
  requireValue(
    typeof d.buildSleep === 'string' &&
      Number.isFinite(Number(d.buildSleep)) &&
      Number(d.buildSleep) >= 0,
    'invalid stress task sleep',
  )
  requireValue(Array.isArray(d.rows) && d.rows.length === 5, 'stress results require every runner')
  const names = new Set<string>()
  for (const value of d.rows) {
    const row = record(value, 'stress row')
    names.add(string(row.runner, 'runner'))
    string(row.version, 'version')
    for (const key of ['fresh', 'warmNoRestore', 'warmRestore', 'freshCpu', 'warmNoRestoreCpu'])
      number(row[key], key, true)
  }
  requireValue(
    ['vx', 'vx (no lock)', 'turbo', 'nx', 'vite-task'].every((name) => names.has(name)),
    'stress runner set is incomplete',
  )
  const baseline = record(d.baseline, 'stress baseline')
  for (const key of [
    'fresh',
    'warmNoRestore',
    'warmRestore',
    'freshCpu',
    'warmNoRestoreCpu',
    'criticalPathMs',
    'workBoundMs',
  ])
    number(baseline[key], key)
  return d as unknown as Results
}

function disp(ms: number): string {
  if (ms >= 60_000) {
    const seconds = Math.round(ms / 1000)
    return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`
  }
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`
  return `${Math.round(ms)}ms`
}
function versus(ours: number, theirs: number): string {
  if (ours <= 0 || theirs <= 0) return 'ratio unresolved: nonpositive residual'
  const faster = ours < theirs
  const r = faster ? theirs / ours : ours / theirs
  const round = faster ? Math.floor : Math.ceil
  if (r === 1) return 'vx same'
  const at = (k: number) => round(r * k) / k
  const n = r >= 10 ? round(r) : at(10) > 1 ? at(10) : at(100)
  return `vx ${n}× ${faster ? 'faster' : 'slower'}`
}
const FORMULA =
  'vx N× faster: that tool takes N times as long as vx (theirs ÷ vx); N× slower: vx takes N times as long (vx ÷ theirs).'
const RESIDUAL_NOTE =
  'Cold excess compares wall time minus the analytic ideal, including scheduling delay and runner work; its multiple is not the whole-build speedup.'
function replaceOnce(text: string, re: RegExp, to: string, name: string): string {
  requireValue(
    [...text.matchAll(new RegExp(re.source, 'g'))].length === 1,
    `${name}: expected exactly one generated region`,
  )
  return text.replace(re, () => to)
}
function caseBlock(text: string, caseName: string, content: string, file: string): string {
  const start = `<!-- ${caseName}:start -->`
  const end = `<!-- ${caseName}:end -->`
  return replaceOnce(
    text,
    new RegExp(`${start}[\\s\\S]*?${end}`),
    `${start}\n\n${content}\n\n${end}`,
    `${file}: ${caseName}`,
  )
}

/** Pure rendering: the real files are read/written only by publishSite. */
export function renderPublication(
  stressInput: unknown,
  counterexampleInput: unknown,
  sources: { readme: string; landing: string; benchmarks: string },
) {
  const c = validateCounterexample(counterexampleInput)
  const d = stressResults(stressInput)
  const rows = new Map(d.rows.map((r) => [r.runner, r]))
  const vx = rows.get('vx')!
  const turbo = rows.get('turbo')!
  const nx = rows.get('nx')!
  const vt = rows.get('vite-task')!
  const noLock = rows.get('vx (no lock)')!
  const baseline = d.baseline
  const nodes = d.packages * 3
  const executable = d.packages * 2
  const deps = Math.min(d.perLayer, d.depsPerPkg)
  const table: ReadonlyArray<readonly [string, (r: Row) => number, (r: Row) => string]> = [
    ['Cold build: whole wall time', (r) => r.fresh, (r) => disp(r.fresh)],
    [
      'Cold build: baseline-subtracted excess',
      (r) => r.fresh - baseline.fresh,
      (r) => disp(r.fresh - baseline.fresh),
    ],
    ['Cold build: CPU burned', (r) => r.freshCpu, (r) => disp(r.freshCpu)],
    ['Fully cached run (restored)', (r) => r.warmRestore, (r) => disp(r.warmRestore)],
    ['Fully cached run (up-to-date)', (r) => r.warmNoRestore, (r) => disp(r.warmNoRestore)],
  ]
  const vs = (r: Row, n: (r: Row) => number, f: (r: Row) => string) =>
    `${f(r)} (${versus(n(vx), n(r))})`
  const scope = `Synthetic layered stress graph (${d.date.slice(0, 10)}): ${d.packages.toLocaleString('en-US')} packages, ${executable.toLocaleString('en-US')} executable tasks + ${d.packages.toLocaleString('en-US')} ordering/group nodes; ${d.reps === 1 ? 'single repetition' : `${d.reps} repetitions`} per runner/state, concurrency ${d.concurrency}.`
  const tableBlock =
    'const benchTable = [\n' +
    table
      .map(
        ([label, n, f]) =>
          `  { label: '${label}', vx: '${f(vx)}', turbo: '${vs(turbo, n, f)}', nx: '${vs(nx, n, f)}', vt: '${vs(vt, n, f)}' },`,
      )
      .join('\n') +
    `\n]\nconst benchFormula = '${FORMULA}'\n`
  let landing = replaceOnce(
    sources.landing,
    /const benchTable\s*=\s*\[[\s\S]*?\n\]\s*\nconst benchFormula\s*=\s*(?:'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*");?\n/,
    tableBlock,
    'landing stress table',
  )
  landing = replaceOnce(
    landing,
    /const benchScope\s*=\s*(?:'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*");?\n/,
    `const benchScope = ${JSON.stringify(scope)}\n`,
    'landing stress scope',
  )
  landing = replaceOnce(
    landing,
    /\/\/ [\d,]+ tasks · [\d,]+ packages · \d+ layers ·/,
    `// ${nodes.toLocaleString('en-US')} tasks · ${d.packages.toLocaleString('en-US')} packages · ${d.layers} layers ·`,
    'landing stress size',
  )
  const readmeBlock = `<!-- bench:start — generated by packages/vx-bench/update-site.ts from results.json; do not hand-edit -->

### Synthetic layered stress graph

${scope}

| ${d.packages.toLocaleString('en-US')} packages, ${nodes.toLocaleString('en-US')} task nodes | vx | Turborepo | Nx | Vite Task |
| --- | --- | --- | --- | --- |
${table.map(([label, n, f]) => `| ${label} | ${f(vx)} | ${vs(turbo, n, f)} | ${vs(nx, n, f)} | ${vs(vt, n, f)} |`).join('\n')}

${FORMULA}

${RESIDUAL_NOTE}
The ideal is ${disp(baseline.fresh)}; ${deps} dependencies per non-bottom package (requested ${d.depsPerPkg}, capped by the ${d.perLayer}-package pool).
These are waiting commands, not compilation; the node counts describe the vx/Turborepo/Nx graph, while Vite Task uses direct dependency edges and empty \`vp-all\` aggregators.
Same executable work and concurrency: [methodology and both workloads](https://vznjs.github.io/vx/benchmarks/).

<!-- bench:end -->`
  let readme = replaceOnce(
    sources.readme,
    /<!-- bench:start[\s\S]*?<!-- bench:end -->/,
    readmeBlock,
    'README stress table',
  )
  const perPkg = (r: Row) => Math.round((r.fresh - baseline.fresh) / d.packages)
  const cell = (r: Row, key: keyof Row) =>
    `${disp(Number(r[key]))} (${versus(Number(vx[key]), Number(r[key]))})`
  const stressSection = `## Synthetic layered stress graph: ${nodes.toLocaleString('en-US')} task nodes, ${d.layers} layers (${d.date.slice(0, 10)})

${scope}
This is generated, not a real repository: ${d.layers} dependency layers,
${d.layers - 1} layers of ${d.perLayer} packages plus one top package,
${deps} dependencies per non-bottom package (requested ${d.depsPerPkg}, capped by the pool),
${executable.toLocaleString('en-US')} executable \`build\`/\`test\` tasks and ${d.packages.toLocaleString('en-US')} \`installDeps\` ordering/group nodes.
The tasks wait ${d.buildSleep} ${Number(d.buildSleep) === 1 ? 'second' : 'seconds'}; these counts describe the vx/Turborepo/Nx graph.
Vite Task uses direct build/test dependency edges and an empty \`vp-all\` aggregator per package instead of \`installDeps\`.
\`bun packages/vx-bench/compare.ts ${d.layers} ${d.perLayer} ${d.reps}\`, ${d.machine},
Turborepo ${turbo.version}, Nx ${nx.version} with \`nx:run-commands\`, Vite Task ${vt.version}.
vx runs from a \`vx lock\` snapshot (\`--frozen\`); *vx, no lock* evaluates the configs per run.
The existing \`packages/vx-bench/RESULTS.md\` / \`results.json\` remain this dated run.
A single repetition establishes no spread or statistical confidence.

| | vx | vx, no lock | Turborepo | Nx | Vite Task |
| --- | --- | --- | --- | --- | --- |
| **Cold** (nothing cached) | **${disp(vx.fresh)}** | ${disp(noLock.fresh)} | ${cell(turbo, 'fresh')} | ${cell(nx, 'fresh')} | ${cell(vt, 'fresh')} |
| **Warm**, nothing to rebuild | **${disp(vx.warmNoRestore)}** | ${disp(noLock.warmNoRestore)} | ${cell(turbo, 'warmNoRestore')} | ${cell(nx, 'warmNoRestore')} | ${cell(vt, 'warmNoRestore')} |
| **Warm**, restore outputs | **${disp(vx.warmRestore)}** | ${disp(noLock.warmRestore)} | ${cell(turbo, 'warmRestore')} | ${cell(nx, 'warmRestore')} | ${cell(vt, 'warmRestore')} |
| **CPU burned**, cold (user+sys) | **${disp(vx.freshCpu)}** | ${disp(noLock.freshCpu)} | ${cell(turbo, 'freshCpu')} | ${cell(nx, 'freshCpu')} | ${cell(vt, 'freshCpu')} |
| **CPU burned**, warm (user+sys) | **${disp(vx.warmNoRestoreCpu)}** | ${disp(noLock.warmNoRestoreCpu)} | ${cell(turbo, 'warmNoRestoreCpu')} | ${cell(nx, 'warmNoRestoreCpu')} | ${cell(vt, 'warmNoRestoreCpu')} |
| _Baseline_ (analytic ideal for this shape) | ${disp(baseline.fresh)} cold; 0 warm, restore, runner CPU | — | — | — | — |
| _Measured floors_ (context) | git walk ${disp(baseline.warmNoRestore)} · walk + raw copy ${disp(baseline.warmRestore)} · task shells ${disp(baseline.freshCpu)} | — | — | — | — |

${FORMULA}

**Baseline** is an analytic task-duration model, not a measured CLI run:
critical path ${disp(baseline.criticalPathMs)}, total work ÷ ${d.concurrency} workers ${disp(baseline.workBoundMs)}.
The feasible list schedule attains ${disp(baseline.fresh)} on this shape; that is not a general proof that critical-path-first is optimal.
${RESIDUAL_NOTE}
vx's cold excess is
${disp(vx.fresh - baseline.fresh)} on ${nodes.toLocaleString('en-US')} tasks (${perPkg(vx)} ms per package), ${disp(noLock.fresh - baseline.fresh)}
with no lock; Turborepo's is ${disp(turbo.fresh - baseline.fresh)} (${perPkg(turbo)} ms per package),
Nx's ${disp(nx.fresh - baseline.fresh)} (${perPkg(nx)} ms per package), Vite Task's ${disp(vt.fresh - baseline.fresh)} (${perPkg(vt)} ms per package).
The whole-wall row compares complete invocations without subtraction.

**CPU** is user + system time of the invocation and waited-for descendants, including task shells;
waiting tasks are not representative of compiler CPU consumption, and detached daemons are not counted.
The measured floors are a git walk, raw output copy and task shells, not interchangeable baselines for those metrics.

> Historical context: an earlier run of this shape (June 2026, a 4-core Linux box)
> read cold 3m 48s / 8m 18s / 8m 27s and CPU 22.7 s / 1,250 s / 2,038 s.
> Different hardware, versions and harness configurations are not a controlled comparison.
`
  let benchmarks = caseBlock(sources.benchmarks, 'stress', stressSection, 'benchmarks.md')
  const summary = c.summary
  const precise = (ms: number) => `${(ms / 1000).toFixed(3)} s`
  const ratioText = (value: number | null, reason: string | null, digits = 3) =>
    value === null ? `unresolved (${reason})` : `${value.toFixed(digits)}×`
  const totalRatio = ratioText(summary.totalRatio.value, summary.totalRatio.reason)
  const excessRatio = ratioText(summary.excessRatio.value, summary.excessRatio.reason)
  const envelope = summary.excessRatioEnvelope
  const envelopeText =
    envelope?.lower != null && envelope.upper != null
      ? `${envelope.lower.toFixed(5)}–${envelope.upper.toFixed(5)}×`
      : 'unresolved'
  const totalEnvelope =
    summary.totalRatio.value === null || summary.totals.turbo!.min <= summary.noiseMs
      ? 'unresolved'
      : `${(summary.totals.vx!.min / summary.totals.turbo!.max).toFixed(3)}–${(summary.totals.vx!.max / summary.totals.turbo!.min).toFixed(3)}×`
  const counterScope = `Synthetic scheduling counterexample (${c.date.slice(0, 10)}): ${c.model.dagNodes} DAG nodes, ${c.model.executableTasks} executable waiting tasks and ${c.model.commandlessGates.length} commandless root gates, two workers, five alternating rounds, ten conforming actual CLI samples, zero cache hits and zero exit codes.`
  const gatePurpose = c.model.gatePurpose
  const gateTraceLimit =
    'Only the five executable tasks have observed process spans and output files; commandless gate readiness timing is not trace-verified.'
  const predecessor = c.model.predecessor
  const preliminaryNote =
    'The retained earlier minimal five-task case includes an adverse Turborepo root-order run and an unresolved excess ratio; it is a different shared DAG, not a discarded outlier or a subset of this primary measurement.'
  const preliminaryLinks = predecessor.artifacts
    .map((file) => `[${file}](https://github.com/vznjs/vx/blob/main/packages/vx-bench/${file})`)
    .join(' · ')
  const stats = (runner: 'vx' | 'turbo', metric: 'totals' | 'excess') => {
    const spread = summary[metric][runner]!
    return `${precise(spread.median)}; ${precise(spread.min)}–${precise(spread.max)}`
  }
  const metricLines = [
    ['End-to-end wall time: median; min–max', stats('vx', 'totals'), stats('turbo', 'totals')],
    [
      'Baseline-subtracted excess: median; min–max',
      stats('vx', 'excess'),
      stats('turbo', 'excess'),
    ],
  ]
  const ratioLine = `End-to-end ratio of all-five-round medians (vx / Turborepo): ${totalRatio}; all-sample envelope ${totalEnvelope}.`
  const excessLine = `Excess ratio of all-five-round medians ((vx − ideal) / (Turborepo − ideal)): ${excessRatio}; all-sample envelope ${envelopeText}.`
  const pairs = summary.pairs.map(
    (pair) =>
      `Paired round ${pair.round}: end-to-end vx/Turborepo ratio ${ratioText(pair.total.value, pair.total.reason, 5)}; baseline-subtracted excess ratio ${ratioText(pair.excess?.value ?? null, pair.excess?.reason ?? 'unresolved', 5)}.`,
  )
  const below100 = summary.pairs.filter(
    (pair) => pair.excess?.value != null && pair.excess.value < 100,
  ).length
  const roundScope = `All five rounds are retained; ${below100} paired excess ${below100 === 1 ? 'ratio is' : 'ratios are'} below 100×, and a ratio of all-sample medians is not an every-round threshold or a universal guarantee.`
  const caution =
    'Envelopes are observed min/max combinations, not confidence intervals; an excess multiple is not that multiple slower whole builds.'
  const noiseLine = `Median excess denominator ${summary.excessRatio.denominatorMs!.toFixed(3)} ms; configured noise floor ${summary.noiseMs} ms; nonpositive or noise/spread-dominated denominators suppress the excess ratio.`
  const why = `Default vx counts dependent tasks, so the two parents can delay the long independent task; it does not know durations or guarantee an optimal schedule.`
  const provenanceLine = `${c.platform}/${c.arch} ${c.release}, ${c.cpuModels.join(' / ')}, ${c.cores} cores, Bun ${c.bunRevision}, ${c.vxVersion}, native-direct Turborepo ${c.turboVersion}; source commit ${c.commit}.`
  const markdownCase = `### Synthetic scheduling counterexample

${counterScope}

**Controlled readiness, identical executable work.** ${gatePurpose}
The root gates \`${c.model.commandlessGates[0]}\` and \`${c.model.commandlessGates[1]}\` precede their respective parents in both native configs.
They have no commands, scripts, outputs or trace events; positive-duration commands are unchanged, and the analytic total work and ideal remain the same.
${gateTraceLimit}

**Retained preliminary case.** ${preliminaryNote}
All earlier samples, including the unfavorable ordering, remain separate and unchanged; they are never pooled into the primary medians or filtered away.
Earlier harness preserved at commit \`${predecessor.sourceCommit}\`; each raw artifact keeps its own recorded core/tool provenance.
${preliminaryLinks}

| Metric | vx | Turborepo |
| --- | --- | --- |
${metricLines.map((line) => `| ${line.join(' | ')} |`).join('\n')}

${ratioLine}

${excessLine}

${roundScope}

${pairs.join('\n\n')}

Analytic ideal ${precise(c.model.idealMs)}: the feasible two-worker witness attains both work/2 and the critical-path lower bound.
${noiseLine}
${caution}
${why}
${provenanceLine}
No outliers are omitted; this measures waiting commands, not real compilation or a universal ranking.
[Raw samples and provenance](https://github.com/vznjs/vx/blob/main/packages/vx-bench/counterexample-results.json) ·
[Full report](https://github.com/vznjs/vx/blob/main/packages/vx-bench/COUNTEREXAMPLE.md).
`
  readme = caseBlock(readme, 'counterexample', markdownCase, 'README.md')
  benchmarks = caseBlock(
    benchmarks,
    'counterexample',
    markdownCase.replace(
      '### Synthetic scheduling counterexample',
      '## Synthetic scheduling counterexample',
    ) +
      `
Reproduce into a new output directory (the harness refuses overwriting earlier measurements):

\`bun packages/vx-bench/counterexample.ts --long ${dNumber(c.tasks[0]!.dur / 1000)} --leaf ${dNumber(c.tasks[3]!.dur / 1000)} --reps 5 --noise-ms ${summary.noiseMs} --output NEW_DIRECTORY\`

Each sample records native argv, stdout/stderr, CPU accounting, exact output contents and shared-monotonic start/end traces for five executable tasks.
The seven-node graph also has two commandless root gates; no process timestamps or output files are invented for them.
The publisher independently checks the artifact's status, five-round order, native provenance, gated graph/witness, every executable trace and all primary summary calculations before writing any page.
`,
    'benchmarks.md',
  )
  const json = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c')
  landing = replaceOnce(
    landing,
    /\/\/ counterexample:data:start\n[\s\S]*?\/\/ counterexample:data:end/,
    `// counterexample:data:start
const counterexampleScope = ${json(counterScope)}
const counterexampleRows = ${json(metricLines.map(([label, ours, theirs]) => ({ label, vx: ours, turbo: theirs })))}
const counterexampleGroups: BarGroup[] = ${json((['totals', 'excess'] as const).map((metric, i) => ({ title: metricLines[i]![0], bars: (['vx', 'turbo'] as const).map((runner) => ({ name: runner === 'vx' ? 'vx' : 'Turborepo', ms: summary[metric][runner]!.median, value: stats(runner, metric) })) })))}
const counterexampleNotes = ${json([ratioLine, excessLine, roundScope, ...pairs, ...gatePurpose.split(/(?<=\.)\s+/), gateTraceLimit, preliminaryNote, `Analytic ideal ${precise(c.model.idealMs)}; commandless gates add no modeled work or duration.`, noiseLine, caution, why, provenanceLine])}
const counterexamplePreliminaryLinks = ${json(predecessor.artifacts.map((file) => ({ label: file, href: `https://github.com/vznjs/vx/blob/main/packages/vx-bench/${file}` })))}
// counterexample:data:end`,
    'landing counterexample data',
  )
  return { readme, landing, benchmarks }
}
const dNumber = (value: number): string => String(value)

// Oxfmt rejects Astro in this checkout: keep that generated source byte-exact,
// while formatter failures for supported Markdown remain a publication refusal.
function formatted(root: string, rel: string, text: string): string {
  if (rel.endsWith('.astro')) return text
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vx-update-site-'))
  const tmp = path.join(dir, path.basename(rel))
  try {
    writeFileSync(tmp, text)
    const fmt = Bun.spawnSync({
      cmd: [path.join(root, 'node_modules/.bin/oxfmt'), tmp],
      stdout: 'pipe',
      stderr: 'pipe',
    })
    requireValue(fmt.exitCode === 0, `formatter failed for ${rel}: ${fmt.stderr.toString()}`)
    return readFileSync(tmp, 'utf8')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Scratch-root tests exercise the same file reads, check, and write path as the CLI. */
export function publishSite(
  root = ROOT,
  check = false,
  normalize: (rel: string, text: string) => string = (rel, text) => formatted(root, rel, text),
): boolean {
  const stress = JSON.parse(
    readFileSync(path.join(root, 'packages/vx-bench/results.json'), 'utf8'),
  ) as unknown
  const counterexample = JSON.parse(
    readFileSync(path.join(root, 'packages/vx-bench/counterexample-results.json'), 'utf8'),
  ) as unknown
  // Refuse incomplete measurements before even reading a publication target.
  const validated = validateCounterexample(counterexample)
  // The earlier unfavorable case is linked, never reinterpreted by the new graph or overwritten.
  for (const file of validated.model.predecessor.artifacts) {
    requireValue(
      readFileSync(path.join(root, 'packages/vx-bench', file)).byteLength > 0,
      `retained preliminary artifact is empty: ${file}`,
    )
  }
  const before = TARGETS.map((file) => readFileSync(path.join(root, file), 'utf8'))
  const rendered = renderPublication(stress, counterexample, {
    readme: before[0]!,
    landing: before[1]!,
    benchmarks: before[2]!,
  })
  const after = [rendered.readme, rendered.landing, rendered.benchmarks].map((text, i) =>
    normalize(TARGETS[i]!, text),
  )
  const changed = before.some((text, i) => text !== after[i])
  if (check)
    requireValue(
      !changed,
      'publication files do not match results.json and counterexample-results.json; run update-site.ts after measurements complete',
    )
  else for (const [i, file] of TARGETS.entries()) writeFileSync(path.join(root, file), after[i]!)
  return changed
}

if (import.meta.main) {
  try {
    const check = process.argv.includes('--check')
    const changed = publishSite(ROOT, check)
    process.stdout.write(
      check
        ? 'site matches both benchmark datasets\n'
        : changed
          ? 'site rewritten from both benchmark datasets\n'
          : 'site already matched both benchmark datasets\n',
    )
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
