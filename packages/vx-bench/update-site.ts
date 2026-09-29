#!/usr/bin/env bun
// Rewrite the landing page's benchmark table and the graph's size, the
// README's benchmark table and the benchmarks doc's stress-shape section,
// from packages/vx-bench/results.json — the file `packages/vx-bench/compare.ts`
// commits. The site is a rendering of the runner's output, never hand-typed
// numbers; run this after every comparison. The landing shows this one
// benchmark (design/site-short-2026-09.md); the real-repo tables stay in
// benchmarks.md, typed there.
//
//   bun packages/vx-bench/update-site.ts          # rewrite in place
//   bun packages/vx-bench/update-site.ts --check  # exit 1 if the site would change (CI-able)

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
const x = (a: Row, key: keyof Row): string => `${(Number(a[key]) / Number(vx[key])).toFixed(1)}×`
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
const table = [
  ['Cold build: time the runner adds', (r: Row) => span(Number(r.fresh) - B.fresh)],
  ['Cold build: CPU burned', (r: Row) => span(r.freshCpu)],
  ['Fully cached run', (r: Row) => disp(r.warmNoRestore).replace(/(\d)(ms|s)$/, '$1 $2')],
  ['Overhead per package', (r: Row) => `${perPkg(r).toLocaleString('en-US')} ms`],
] as const
const tableBlock =
  'const benchTable = [\n' +
  table
    .map(
      ([label, f]) =>
        `  { label: '${label}', vx: '${f(vx)}', turbo: '${f(turbo)}', nx: '${f(nx)}' },`,
    )
    .join('\n') +
  '\n]\n'

// ---- landing page ----
const landingPath = path.join(ROOT, 'packages/vx-docs/src/pages/index.astro')
let landing = readFileSync(landingPath, 'utf8')
landing = rewrite(
  landing,
  /const benchTable = \[\n[\s\S]*?\n\]\n/,
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
${table.map(([label, f]) => `| ${label} | **${f(vx)}** | ${f(turbo)} | ${f(nx)} |`).join('\n')}

Time added is the wall time over the tasks' own ideal schedule (${span(B.fresh)}).
Same graph, commands and concurrency: [how it is measured](https://vznjs.github.io/vx/benchmarks/).

<!-- bench:end -->`
const readmeIn = readFileSync(readmePath, 'utf8')
let readmeOut = readmeIn.replace(/<!-- bench:start[\s\S]*?<!-- bench:end -->/, readmeBlock)
if (!readmeOut.includes('<!-- bench:start')) throw new Error('README.md: bench markers not found')

// ---- real Turbo and Nx repos: the README table and the site page ----
// One row per repo in real-repos.json, each naming the benchmarks.md section
// that records its harness and numbers. A new bench is one data edit; a row
// whose section is gone is an error, not a dead link.
type Repo = {
  repo: string
  tool: 'Turbo' | 'Nx'
  version: string
  setup: string
  date: string
  heading: string
  cold: [string, string]
  restore: [string, string]
  noop: [string, string]
  why?: string
}
const repos = (
  JSON.parse(readFileSync(path.join(ROOT, 'packages/vx-bench/real-repos.json'), 'utf8')) as {
    rows: Repo[]
  }
).rows
const headings = new Set(
  docIn
    .split('\n')
    .filter((l) => /^#{2,3} /.test(l))
    .map((l) => l.replace(/^#+ /, '')),
)
for (const r of repos)
  if (!headings.has(r.heading))
    throw new Error(`real-repos.json: ${r.repo} names no benchmarks.md heading "${r.heading}"`)
// The anchor Starlight (github-slugger) gives a heading.
const slug = (h: string): string =>
  h
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, '')
    .replace(/ /g, '-')
const pair = ([ours, theirs]: [string, string]): string => `${ours} / ${theirs}`
const repoLink = (r: Repo): string => `[${r.repo}](https://github.com/${r.repo})`
const PAGE = 'https://vznjs.github.io/vx/benchmarks/real-repos/'
const reposBlock = `<!-- repos:start — generated by packages/vx-bench/update-site.ts from real-repos.json; do not hand-edit -->

| Repo | Against | Cold build | Restore outputs | Nothing to do |
| --- | --- | --- | --- | --- |
${repos.map((r) => `| ${repoLink(r)} | ${r.tool} | ${pair(r.cold)} | ${pair(r.restore)} | ${pair(r.noop)} |`).join('\n')}

vx first, theirs second; **bold** marks the other tool winning. These
rows ran vx without a lock (every config evaluated per run); the harness
now runs it from a \`vx lock\` snapshot (\`--frozen\`). How each
repo was run, versions, dates and why a tool wins where it does:
[vx on real Turbo and Nx repos](${PAGE}).

<!-- repos:end -->`
readmeOut = readmeOut.replace(/<!-- repos:start[\s\S]*?<!-- repos:end -->/, reposBlock)
if (!readmeOut.includes('<!-- repos:start')) throw new Error('README.md: repos markers not found')

const pagePath = path.join(ROOT, 'packages/vx-docs/src/content/docs/benchmarks/real-repos.md')
const wins = repos.filter((r) => r.why)
const pageText = `---
title: vx on real Turbo and Nx repos
description: vx against Turborepo and Nx on public monorepos, each with its own turbo.json or Nx graph, same machine and tasks per row.
---

<!-- Generated by packages/vx-bench/update-site.ts from packages/vx-bench/real-repos.json; do not hand-edit. -->

Each repo runs its own build under vx and under the tool it ships with,
on the same machine and the same tasks; medians of interleaved reps. vx
first, theirs second; **bold** marks the other tool winning.

Every row below ran vx without a lock, evaluating every config per run.
The harness (\`packages/vx-bench/real/\`) now takes a \`vx lock\` once per
repo and runs vx \`--frozen\`, as CI does; a row re-measured that way
will say so.

| Repo | Against | Cold build | Restore outputs | Nothing to do | Setup | Measured |
| --- | --- | --- | --- | --- | --- | --- |
${repos.map((r) => `| ${repoLink(r)} | ${r.tool} ${r.version} | ${pair(r.cold)} | ${pair(r.restore)} | ${pair(r.noop)} | ${r.setup} | [${r.date}](../#${slug(r.heading)}) |`).join('\n')}

## Where the other tool wins

${wins.map((r) => `- **${r.repo}** (${r.tool}). ${r.why} [Details](../#${slug(r.heading)}).`).join('\n')}

The harness, revisions and every run: [the numbers](../).
`

// ---- benchmarks.md stress section ----
let doc = docIn
const cell = (r: Row, key: keyof Row) => `${disp(Number(r[key]))} (${x(r, key)})`
const section = `## A real monorepo: ${nodes.toLocaleString('en-US')} tasks, 100 layers (${d.date.slice(0, 10)})

The shape that actually stresses a task runner: **100 dependency layers**,
~11 packages per layer, ~30 deps per package, three tasks each
(\`build\` + \`installDeps\` + \`test\`, \`sleep 1\` for build and test) — **${nodes.toLocaleString('en-US')}
task nodes**, ${d.packages.toLocaleString('en-US')} packages. Same repo, same hardware, same task commands;
every runner pinned to concurrency ${d.concurrency}. \`bun packages/vx-bench/compare.ts 100 11 1\`,
this machine (macOS arm64, 10 cores), Turbo ${turbo.version}, Nx ${nx.version}.
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
different tool from one that adds half an hour. For context, the
**measured floors** row gives what the cheapest possible implementation
of each step costs on this machine: one \`git status -uall\` walk (the
cost of asking what changed), that walk plus a raw copy of every output
file, and the task shells themselves under \`xargs -P 10\` (which vary by
about two seconds between runs; vx's cold CPU sits within that noise).

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
const pageOut = formatted('real-repos.md', pageText)
const before = [
  readFileSync(landingPath, 'utf8'),
  readFileSync(docPath, 'utf8'),
  readFileSync(readmePath, 'utf8'),
  existsSync(pagePath) ? readFileSync(pagePath, 'utf8') : '',
]
const changed =
  before[0] !== landingOut ||
  before[1] !== docOut ||
  before[2] !== readmeFormatted ||
  before[3] !== pageOut
if (CHECK) {
  if (changed) {
    process.stderr.write(
      'packages/vx-bench/update-site.ts --check: the site does not match results.json or real-repos.json\n',
    )
    process.exit(1)
  }
  process.stdout.write('site matches results.json and real-repos.json\n')
} else {
  writeFileSync(landingPath, landingOut)
  writeFileSync(docPath, docOut)
  writeFileSync(readmePath, readmeFormatted)
  mkdirSync(path.dirname(pagePath), { recursive: true })
  writeFileSync(pagePath, pageOut)
  process.stdout.write(
    changed ? 'site rewritten from packages/vx-bench/results.json\n' : 'site already matched\n',
  )
}
