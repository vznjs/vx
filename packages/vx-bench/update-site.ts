#!/usr/bin/env bun
// Rewrite the landing page's benchmark table and the graph's size, the
// README's benchmark table and the benchmarks doc's stress-shape section,
// from packages/vx-bench/results.json — the file `packages/vx-bench/compare.ts`
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
// The number the site leads with (owner, 2026-09-10): what the runner ADDS
// to a cold build over the ideal schedule of the tasks themselves, as time,
// never a percentage for one and a multiple for another (a percentage of a
// big example reads as "this scales"; seconds against minutes reads as what
// it is). `perPkg` is the same overhead per package, in ms, the number that
// says how the runner grows with the codebase.
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
// [label, the number compared, how a cell shows it]
const table: ReadonlyArray<readonly [string, (r: Row) => number, (r: Row) => string]> = [
  [
    'Cold build: time the runner adds',
    (r) => Number(r.fresh) - B.fresh,
    (r) => span(Number(r.fresh) - B.fresh),
  ],
  ['Cold build: CPU burned', (r) => r.freshCpu, (r) => span(r.freshCpu)],
  [
    'Fully cached run',
    (r) => r.warmNoRestore,
    (r) => disp(r.warmNoRestore).replace(/(\d)(ms|s)$/, '$1 $2'),
  ],
  [
    'Overhead per package',
    (r) => Number(r.fresh) - B.fresh,
    (r) => `${perPkg(r).toLocaleString('en-US')} ms`,
  ],
]
// Every competitor cell says how vx compares, as how many times as long the
// slower runner takes (owner, 2026-10-04: "say how many X", replacing the
// 2026-10-02 percentage). Rounded against vx: down when vx is faster, up
// when it is slower; whole from 10×, one decimal under it, two under
// 1.1× so a small win never reads as a tie.
function versus(ours: number, theirs: number): string {
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
const vs = (r: Row, n: (r: Row) => number, f: (r: Row) => string): string =>
  `${f(r)} (${versus(n(vx), n(r))})`
const tableBlock =
  'const benchTable = [\n' +
  table
    .map(
      ([label, n, f]) =>
        `  { label: '${label}', vx: '${f(vx)}', turbo: '${vs(turbo, n, f)}', nx: '${vs(nx, n, f)}' },`,
    )
    .join('\n') +
  '\n]\n' +
  `const benchFormula = '${FORMULA}'\n`

// ---- landing page ----
const landingPath = path.join(ROOT, 'packages/vx-docs/src/pages/index.astro')
let landing = readFileSync(landingPath, 'utf8')
landing = rewrite(
  landing,
  /const benchTable = \[\n[\s\S]*?\n\]\nconst benchFormula = '[^'\n]*'\n(?:const benchNote = "[^"\n]*"\n)?/,
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

| ${d.packages.toLocaleString('en-US')} packages, ${nodes.toLocaleString('en-US')} tasks | vx | Turborepo | Nx |
| --- | --- | --- | --- |
${table.map(([label, n, f]) => `| ${label} | **${f(vx)}** | ${vs(turbo, n, f)} | ${vs(nx, n, f)} |`).join('\n')}

${FORMULA}

Time added is the wall time over the tasks' own ideal schedule (${span(B.fresh)}).
Same graph, commands and concurrency: [how it is measured](https://vznjs.github.io/vx/benchmarks/).

<!-- bench:end -->`
const readmeIn = readFileSync(readmePath, 'utf8')
const readmeOut = readmeIn.replace(/<!-- bench:start[\s\S]*?<!-- bench:end -->/, readmeBlock)
if (!readmeOut.includes('<!-- bench:start')) throw new Error('README.md: bench markers not found')

// ---- benchmarks.md stress section ----
let doc = docIn
const cell = (r: Row, key: keyof Row) =>
  `${disp(Number(r[key]))} (${versus(Number(vx[key]), Number(r[key]))})`
const section = `## A real monorepo: ${nodes.toLocaleString('en-US')} tasks, 100 layers (${d.date.slice(0, 10)})

The shape that actually stresses a task runner: **100 dependency layers**,
~11 packages per layer, ~30 deps per package, three tasks each
(\`build\` + \`installDeps\` + \`test\`, \`sleep 1\` for build and test) — **${nodes.toLocaleString('en-US')}
task nodes**, ${d.packages.toLocaleString('en-US')} packages. Same repo, same hardware, same task commands;
every runner pinned to concurrency ${d.concurrency}. \`bun packages/vx-bench/compare.ts 100 11 1\`,
this machine (${d.machine}), Turbo ${turbo.version}, Nx ${nx.version}, every Nx task an \`nx:run-commands\` target.
vx runs from a \`vx lock\` snapshot (\`--frozen\`), taken once before the reps,
as a CI pipeline runs it; *vx, no lock* is the same run evaluating every
config per run.
The committed \`packages/vx-bench/RESULTS.md\` / \`packages/vx-bench/results.json\` are this run.

|                              | vx         | vx, no lock | Turborepo | Nx       |
| ---------------------------- | ---------- | ----------- | --------- | -------- |
| **Cold** (nothing cached)    | **${disp(vx.fresh)}** | ${disp(noLock.fresh)} | ${cell(turbo, 'fresh')} | ${cell(nx, 'fresh')} |
| **Warm**, nothing to rebuild | **${disp(vx.warmNoRestore)}** | ${disp(noLock.warmNoRestore)} | ${cell(turbo, 'warmNoRestore')} | ${cell(nx, 'warmNoRestore')} |
| **Warm**, restore outputs    | **${disp(vx.warmRestore)}** | ${disp(noLock.warmRestore)} | ${cell(turbo, 'warmRestore')} | ${cell(nx, 'warmRestore')} |
| **CPU burned**, cold (user+sys) | **${disp(vx.freshCpu)}** | ${disp(noLock.freshCpu)} | ${cell(turbo, 'freshCpu')} | ${cell(nx, 'freshCpu')} |
| **CPU burned**, warm (user+sys) | **${disp(vx.warmNoRestoreCpu)}** | ${disp(noLock.warmNoRestoreCpu)} | ${cell(turbo, 'warmNoRestoreCpu')} | ${cell(nx, 'warmNoRestoreCpu')} |
| _Baseline_ (theoretical best) | ${disp(B.fresh)} cold; 0 warm, restore, CPU | — | — | — |
| _Measured floors_ (context)  | git walk ${disp(B.warmNoRestore)} · walk + raw copy ${disp(B.warmRestore)} · task shells ${disp(B.freshCpu)} | — | — | — |

${FORMULA}

**Baseline** is the theoretical best case, so each row shows its overhead:
cold is the tasks' own durations list-scheduled on 10 workers along the
exact dependency graph (critical path ${disp(B.criticalPathMs)}, total work ÷
workers ${disp(B.workBoundMs)}); a cached run, a restore and the CPU a
runner burns are 0 in theory, so every measured number in those rows is
the runner. vx's cold overhead over the ideal schedule is
${disp(vx.fresh - B.fresh)} on ${nodes.toLocaleString('en-US')} tasks (${perPkg(vx)} ms per package), ${disp(noLock.fresh - B.fresh)}
with no lock; Turborepo's is
${disp(turbo.fresh - B.fresh)} (${perPkg(turbo)} ms per package) and Nx's ${disp(nx.fresh - B.fresh)}
(${perPkg(nx).toLocaleString('en-US')} ms per package) — the number to read first, in one unit for every
runner: a runner that adds seconds to a three-minute build is a
different tool from one that adds a minute and a half. For context, the
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
> _runner_ overhead from real compilation. All three runners are
> configured **identically** — same commands, the same \`src/**\` inputs and
> \`dist/**\` outputs, the same concurrency. (Hashing \`**/*\` instead would
> include each task's own output in its inputs and break caching for
> everyone.) An earlier run of this shape (June 2026, a 4-core Linux box)
> read cold 3m 48s / 8m 18s / 8m 27s and CPU 22.7 s / 1,250 s / 2,038 s;
> cold wall time depends on how many cores the runners' overhead competes
> with the tasks for, which is why the CPU row is the one that travels.

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
const changed = before[0] !== landingOut || before[1] !== docOut || before[2] !== readmeFormatted
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
  process.stdout.write(
    changed ? 'site rewritten from packages/vx-bench/results.json\n' : 'site already matched\n',
  )
}
