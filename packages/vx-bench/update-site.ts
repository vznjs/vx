#!/usr/bin/env bun
// Rewrite the landing page's benchmark table and the graph's size, the
// README's benchmark table, the vx-vs-Turborepo and vx-vs-Nx pages' tables
// and the benchmarks doc's stress-shape section, from
// packages/vx-bench/results.json — the file `packages/vx-bench/compare.ts`
// commits. The site is a rendering of the runner's output, never hand-typed
// numbers; run this after every comparison. The landing shows this one
// benchmark (design/site-short-2026-09.md).
//
//   bun packages/vx-bench/update-site.ts          # rewrite in place
//   bun packages/vx-bench/update-site.ts --check  # exit 1 if the site would change (CI-able)

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dir, '../..')
const CHECK = process.argv.includes('--check')

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
  packages: number
  concurrency: number
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

const d = JSON.parse(
  readFileSync(path.join(ROOT, 'packages/vx-bench/results.json'), 'utf8'),
) as Results
const rows = new Map(d.rows.map((r) => [r.runner, r]))
const vx = rows.get('vx')!
const turbo = rows.get('turbo')!
const nx = rows.get('nx')!
const vt = rows.get('vite-task')!
// The same run evaluating every config per run; the page keeps it beside
// the frozen headline so config eval's cost stays visible.
const noLock = rows.get('vx (no lock)')!
const B = d.baseline
const nodes = d.packages * 3

function disp(ms: number): string {
  if (ms >= 60_000) {
    const m = Math.floor(ms / 60_000)
    const s = Math.round((ms - m * 60_000) / 1000)
    return `${m}m ${String(s).padStart(2, '0')}s`
  }
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`
  return `${Math.round(ms)}ms`
}
// What the runner adds to a cold build over the tasks' own ideal schedule,
// per package, in ms: how the runner grows with the codebase.
const perPkg = (r: Row): number => Math.round((Number(r.fresh) - B.fresh) / d.packages)

// ---- the table the README and the landing lead with ----
// One row per number a Turbo or Nx user weighs, a unit in every cell, no
// prose of numbers (owner, 2026-09-28). The baseline is THEORETICAL: the
// tasks' own durations under an ideal schedule; a cached run and the CPU a
// runner burns are 0 in theory, so every number is the runner's (owner,
// 2026-09-03).
const span = (ms: number): string => {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s} s`
  if (s < 600) return `${Math.floor(s / 60)} min ${s % 60} s`
  return `${Math.round(s / 60)} min`
}
// [label, the number compared, how a cell shows it, whether it shows a multiple]
// Runner overhead only, labelled as overhead; no cold build total time
// (owner, 2026-10-09 17:54: "the overhead is what matters", reversing the
// 10:50 total-time rule). Every row is time or CPU the runner itself adds:
// the cold row subtracts the tasks' ideal schedule, and a cached run's
// ideal is 0.
const unit = (ms: number): string =>
  ms >= 60_000 ? span(ms) : disp(ms).replace(/(\d)(ms|s)$/, '$1 $2')
const table: ReadonlyArray<readonly [string, (r: Row) => number, (r: Row) => string, boolean]> = [
  [
    'Cold build: overhead the runner adds',
    (r) => Number(r.fresh) - B.fresh,
    (r) => unit(Number(r.fresh) - B.fresh),
    true,
  ],
  ['Cold build: CPU the runner burns', (r) => r.freshCpu, (r) => span(r.freshCpu), true],
  ['Fully cached run, restored: overhead', (r) => r.warmRestore, (r) => unit(r.warmRestore), true],
  [
    'Fully cached run, up-to-date: overhead',
    (r) => r.warmNoRestore,
    (r) => unit(r.warmNoRestore),
    true,
  ],
]
// Under every bench table: what "overhead" means here.
const OVERHEAD = `Overhead: the time a runner adds on top of the tasks' own ideal schedule (${span(B.fresh)} cold, 0 for a cached run).`
// Every competitor cell says how vx compares, as how many times as long the
// slower runner takes (owner, 2026-10-04: "say how many X", replacing the
// 2026-10-02 percentage). Under 2× it is a percentage again, the bigger
// number to the eye (owner, 2026-10-09: "30% is bigger than 1.3"). Rounded
// to nearest: whole from 10×, one decimal from 2×.
function versus(ours: number, theirs: number): string {
  const faster = ours < theirs
  const r = faster ? theirs / ours : ours / theirs
  if (r < 2) {
    const pct = Math.round((r - 1) * 100)
    return pct === 0 ? 'vx same' : `vx ${pct}% ${faster ? 'faster' : 'slower'}`
  }
  const n = r >= 10 ? Math.round(r) : Math.round(r * 10) / 10
  return `vx ${n}× ${faster ? 'faster' : 'slower'}`
}
const FORMULA = 'vx N% or N× faster: that tool takes N% longer or N times as long as vx.'
// Under every bench table: when, where and which versions (owner, 2026-10-09).
const vxCommit = / @ (\w+)$/.exec(vx.version)?.[1]
const RUN = `Run ${d.date.slice(0, 10)} on ${d.machine}: vx ${vxCommit ? `at commit ${vxCommit}` : 'from source'}, Turborepo ${turbo.version}, Nx ${nx.version}, Vite Task (vite-plus) ${vt.version}.`
// Beside every bench number (owner, 2026-10-09), true to compare.ts's shape.
const WORKLOAD =
  'Benchmark workload: a synthetic monorepo of 1,090 packages and 3,270 tasks in 100 dependency layers, every build and test taking 1 s; real repos with uneven task times will differ.'
const vs = (r: Row, n: (r: Row) => number, f: (r: Row) => string, ratio: boolean): string =>
  ratio ? `${f(r)} (${versus(n(vx), n(r))})` : f(r)
const tableBlock =
  'const benchTable = [\n' +
  table
    .map(
      ([label, n, f, ratio]) =>
        `  { label: '${label}', vx: '${f(vx)}', turbo: '${vs(turbo, n, f, ratio)}', nx: '${vs(nx, n, f, ratio)}', vt: '${vs(vt, n, f, ratio)}' },`,
    )
    .join('\n') +
  '\n]\n' +
  `const benchFormula = '${FORMULA}'\n` +
  `const benchOverhead = "${OVERHEAD}"\n` +
  `const benchWorkload = '${WORKLOAD}'\n` +
  `const benchRun = '${RUN}'\n`

// ---- landing page ----
const landingPath = path.join(ROOT, 'packages/vx-docs/src/pages/index.astro')
let landing = readFileSync(landingPath, 'utf8')
landing = rewrite(
  landing,
  /const benchTable = \[\n[\s\S]*?\n\]\nconst benchFormula = '[^'\n]*'\n(?:const benchOverhead = "[^"\n]*"\n)?(?:const benchWorkload = '[^'\n]*'\n)?(?:const benchRun = '[^'\n]*'\n)?/,
  tableBlock,
  'the benchTable block',
)
function rewrite(text: string, re: RegExp, to: string, what: string): string {
  if (!re.test(text)) throw new Error(`index.astro: ${what} not found`)
  return text.replace(re, to)
}
// The graph's size, where the page names it: the panel's kicker.
landing = rewrite(
  landing,
  /\/\/ [\d,]+ tasks · [\d,]+ packages · \d+ layers ·/,
  `// ${nodes.toLocaleString('en-US')} tasks · ${d.packages.toLocaleString('en-US')} packages · ${d.layers} layers ·`,
  'the benchmark kicker',
)

const docPath = path.join(ROOT, 'packages/vx/docs/benchmarks.md')
const docIn = readFileSync(docPath, 'utf8')
// ---- README benchmark table ----
// Hand-typed, the README's numbers drifted (559 ms where the committed run
// said 510, 2026-09-10); rendered here, checked with the rest.
const readmePath = path.join(ROOT, 'README.md')
const readmeBlock = `<!-- bench:start — generated by packages/vx-bench/update-site.ts from results.json; do not hand-edit -->

| ${d.packages.toLocaleString('en-US')} packages, ${nodes.toLocaleString('en-US')} tasks | vx | Turborepo | Nx | Vite Task |
| --- | --- | --- | --- | --- |
${table.map(([label, n, f, ratio]) => `| ${label} | **${f(vx)}** | ${vs(turbo, n, f, ratio)} | ${vs(nx, n, f, ratio)} | ${vs(vt, n, f, ratio)} |`).join('\n')}

${OVERHEAD}
${FORMULA}

${WORKLOAD}
${RUN}

Same graph, commands and concurrency: [how it is measured](https://vznjs.github.io/vx/benchmarks/).

<!-- bench:end -->`
const readmeIn = readFileSync(readmePath, 'utf8')
const readmeOut = readmeIn.replace(/<!-- bench:start[\s\S]*?<!-- bench:end -->/, readmeBlock)
if (!readmeOut.includes('<!-- bench:start')) throw new Error('README.md: bench markers not found')

// ---- the head-to-head pages: vx and one tool, the same rows ----
const PAIRS = [
  ['compare/turborepo.md', 'Turborepo', turbo],
  ['compare/nx.md', 'Nx', nx],
] as const
const pairBlock = (
  name: string,
  r: Row,
): string => `<!-- bench:start — generated by packages/vx-bench/update-site.ts from results.json; do not hand-edit -->

| ${d.packages.toLocaleString('en-US')} packages, ${nodes.toLocaleString('en-US')} tasks | vx | ${name} |
| --- | --- | --- |
${table.map(([label, n, f, ratio]) => `| ${label} | **${f(vx)}** | ${vs(r, n, f, ratio)} |`).join('\n')}

${OVERHEAD}
${FORMULA}

${WORKLOAD}
${RUN}

Same graph, commands and concurrency, each tool in its own native config: [how it is measured](../../benchmarks/).

<!-- bench:end -->`
const pairs = PAIRS.map(([rel, name, r]) => {
  const file = path.join(ROOT, 'packages/vx-docs/src/content/docs', rel)
  const text = readFileSync(file, 'utf8')
  if (!text.includes('<!-- bench:start')) throw new Error(`${rel}: bench markers not found`)
  const out = text.replace(/<!-- bench:start[\s\S]*?<!-- bench:end -->/, pairBlock(name, r))
  return { file, before: text, out: formatted(rel, out) }
})

// ---- benchmarks.md stress section ----
let doc = docIn
const over = (r: Row): number => Number(r.fresh) - B.fresh
const overCell = (r: Row) => `${disp(over(r))} (${versus(over(vx), over(r))})`
const cell = (r: Row, key: keyof Row) =>
  `${disp(Number(r[key]))} (${versus(Number(vx[key]), Number(r[key]))})`
const section = `## A real monorepo: ${nodes.toLocaleString('en-US')} tasks, 100 layers (${d.date.slice(0, 10)})

The shape that actually stresses a task runner: **100 dependency layers**,
~11 packages per layer, ~30 deps per package, three tasks each
(\`build\` + \`installDeps\` + \`test\`, \`sleep 1\` for build and test) — **${nodes.toLocaleString('en-US')}
task nodes**, ${d.packages.toLocaleString('en-US')} packages. Same repo, same hardware, same task commands;
every runner pinned to concurrency ${d.concurrency}. \`bun packages/vx-bench/compare.ts 100 11 1\`,
this machine (${d.machine}), Turbo ${turbo.version}, Nx ${nx.version}, every Nx task an \`nx:run-commands\` target,
Vite Task (\`vp run\`, vite-plus ${vt.version}), its tasks in each package's \`vite.config.ts\`.
vx runs from a \`vx lock\` snapshot (\`--frozen\`), taken once before the reps,
as a CI pipeline runs it; *vx, no lock* is the same run evaluating every
config per run.
The committed \`packages/vx-bench/RESULTS.md\` / \`packages/vx-bench/results.json\` are this run.

|                              | vx         | vx, no lock | Turborepo | Nx       | Vite Task |
| ---------------------------- | ---------- | ----------- | --------- | -------- | --------- |
| **Cold overhead** (over the ideal schedule) | **${disp(over(vx))}** | ${disp(over(noLock))} | ${overCell(turbo)} | ${overCell(nx)} | ${overCell(vt)} |
| **Warm**, nothing to rebuild | **${disp(vx.warmNoRestore)}** | ${disp(noLock.warmNoRestore)} | ${cell(turbo, 'warmNoRestore')} | ${cell(nx, 'warmNoRestore')} | ${cell(vt, 'warmNoRestore')} |
| **Warm**, restore outputs    | **${disp(vx.warmRestore)}** | ${disp(noLock.warmRestore)} | ${cell(turbo, 'warmRestore')} | ${cell(nx, 'warmRestore')} | ${cell(vt, 'warmRestore')} |
| **CPU burned**, cold (user+sys) | **${disp(vx.freshCpu)}** | ${disp(noLock.freshCpu)} | ${cell(turbo, 'freshCpu')} | ${cell(nx, 'freshCpu')} | ${cell(vt, 'freshCpu')} |
| **CPU burned**, warm (user+sys) | **${disp(vx.warmNoRestoreCpu)}** | ${disp(noLock.warmNoRestoreCpu)} | ${cell(turbo, 'warmNoRestoreCpu')} | ${cell(nx, 'warmNoRestoreCpu')} | ${cell(vt, 'warmNoRestoreCpu')} |
| _Baseline_ (theoretical best) | ${disp(B.fresh)} cold; 0 warm, restore, CPU | — | — | — | — |
| _Measured floors_ (context)  | git walk ${disp(B.warmNoRestore)} · walk + raw copy ${disp(B.warmRestore)} · task shells ${disp(B.freshCpu)} | — | — | — | — |

${FORMULA}

${WORKLOAD}

**Baseline** is the theoretical best case, so each row shows its overhead:
cold is the tasks' own durations list-scheduled on 10 workers along the
exact dependency graph (critical path ${disp(B.criticalPathMs)}, total work ÷
workers ${disp(B.workBoundMs)}); a cached run, a restore and the CPU a
runner burns are 0 in theory, so every measured number in those rows is
the runner, and the cold row is the wall time over the ideal schedule.
Every row is overhead; a cold build's total time is not compared
(owner, 2026-10-09). vx's cold overhead is
${disp(vx.fresh - B.fresh)} on ${nodes.toLocaleString('en-US')} tasks (${perPkg(vx)} ms per package), ${disp(noLock.fresh - B.fresh)}
with no lock; Turborepo's is
${disp(turbo.fresh - B.fresh)} (${perPkg(turbo)} ms per package), Nx's ${disp(nx.fresh - B.fresh)}
(${perPkg(nx).toLocaleString('en-US')} ms per package) and Vite Task's ${disp(vt.fresh - B.fresh)}
(${perPkg(vt).toLocaleString('en-US')} ms per package), in one unit for every runner. For context, the
**measured floors** row gives what the cheapest possible implementation
of each step costs on this machine: one \`git status -uall\` walk (the
cost of asking what changed), that walk plus a raw copy of every output
file, and the task shells themselves under \`xargs -P 10\` (which vary by
about two seconds between runs).

**CPU** is user + system time of the invocation and every child it
waited for. The tasks are \`sleep\`, so this is the runner's own work; a
daemon that outlives the invocation (Nx's) is not counted, so Nx's CPU
is a floor.

> Methodology note: a synthetic graph with \`sleep\`-based tasks isolates
> _runner_ overhead from real compilation. All four runners are
> configured **identically** — same commands, the same \`src/**\` inputs and
> \`dist/**\` outputs, the same concurrency. (Hashing \`**/*\` instead would
> include each task's own output in its inputs and break caching for
> everyone.) An earlier run of this shape (June 2026, a 4-core Linux box)
> read CPU 22.7 s / 1,250 s / 2,038 s; cold overhead depends on how many
> cores the runners' work competes with the tasks for, which is why the
> CPU row is the one that travels.

`
const start = doc.indexOf('## A real monorepo:')
const end = doc.indexOf('## Reproducible head-to-head')
if (start === -1 || end === -1) throw new Error('benchmarks.md: stress section anchors not found')
doc = doc.slice(0, start) + section + doc.slice(end)

// The committed files are formatter-normalized (oxfmt), so a comparison
// must format the generated text the same way before deciding.
function formatted(rel: string, text: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vx-update-site-'))
  const tmp = path.join(dir, path.basename(rel))
  writeFileSync(tmp, text)
  const fmt = Bun.spawnSync({
    cmd: [path.join(ROOT, 'node_modules/.bin/oxfmt'), tmp],
    stdout: 'ignore',
    stderr: 'ignore',
  })
  const out = fmt.exitCode === 0 ? readFileSync(tmp, 'utf8') : text
  rmSync(dir, { recursive: true, force: true })
  return out
}

const landingOut = formatted('index.astro', landing)
const docOut = formatted('benchmarks.md', doc)
const readmeFormatted = formatted('README.md', readmeOut)
const before = [
  readFileSync(landingPath, 'utf8'),
  readFileSync(docPath, 'utf8'),
  readFileSync(readmePath, 'utf8'),
]
const changed =
  before[0] !== landingOut ||
  before[1] !== docOut ||
  before[2] !== readmeFormatted ||
  pairs.some((p) => p.before !== p.out)
if (CHECK) {
  if (changed) {
    process.stderr.write(
      'packages/vx-bench/update-site.ts --check: the site does not match results.json\n',
    )
    process.exit(1)
  }
  process.stdout.write('site matches results.json\n')
} else {
  writeFileSync(landingPath, landingOut)
  writeFileSync(docPath, docOut)
  writeFileSync(readmePath, readmeFormatted)
  for (const p of pairs) writeFileSync(p.file, p.out)
  process.stdout.write(
    changed ? 'site rewritten from packages/vx-bench/results.json\n' : 'site already matched\n',
  )
}
