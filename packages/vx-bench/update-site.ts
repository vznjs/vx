#!/usr/bin/env bun
// Rewrite the landing page's benchmark chart and the graph's size, the
// README's benchmark table, the vx-vs-Turborepo and vx-vs-Nx pages' tables
// and the benchmarks doc's head-to-head section, from
// packages/vx-bench/results.json — the file `packages/vx-bench/compare.ts`
// commits. The site is a rendering of the runner's output, never hand-typed
// numbers; run this after every comparison.
//
//   bun packages/vx-bench/update-site.ts          # rewrite in place
//   bun packages/vx-bench/update-site.ts --check  # exit 1 if the site would change (CI-able)

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dir, '../..')
const CHECK = process.argv.includes('--check')

const STATES = ['warmNoRestore', 'warmRestore', 'fresh'] as const
type State = (typeof STATES)[number]
type Row = Record<State, number> & {
  runner: string
  version: string
  freshCpu: number
  warmNoRestoreCpu: number
}
type Results = {
  levels: number
  packages: number
  tasks: number
  buildMs: number
  concurrency: number
  date: string
  machine: string
  rows: Row[]
  baseline: Record<State, number> & {
    freshCpu: number
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
// The same run evaluating every config per run; the doc keeps it beside
// the frozen headline so config eval's cost stays visible.
const noLock = rows.get('vx (no lock)')!
const B = d.baseline
const n = (x: number): string => x.toLocaleString('en-US')

function disp(ms: number): string {
  if (ms >= 60_000) {
    const m = Math.floor(ms / 60_000)
    const s = Math.round((ms - m * 60_000) / 1000)
    return `${m} min ${s} s`
  }
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`
  return `${Math.round(ms)} ms`
}
// What a runner adds over the theoretical best case (compare.ts's ideal):
// the headline, total times never (owner, 2026-10-09: "the overhead is what
// matters"). Never below zero: a runner cannot beat the ideal, and a
// measurement under it is noise.
const over = (r: Row, s: State): number => Math.max(0, r[s] - B[s])
const cpu = (r: Row): number => Math.max(0, r.freshCpu - B.freshCpu)

// [label, the number compared]
const table: ReadonlyArray<readonly [string, (r: Row) => number]> = [
  ['Nothing changed', (r) => over(r, 'warmNoRestore')],
  ['Nothing changed, outputs restored', (r) => over(r, 'warmRestore')],
  ['Cold build', (r) => over(r, 'fresh')],
  ['Cold build: CPU the runner burns', cpu],
]
// Every competitor cell says how vx compares, as how many times as long the
// slower runner takes (owner, 2026-10-04). Under 2× it is a percentage
// (owner, 2026-10-09). Rounded to nearest: whole from 10×, one decimal from 2×.
function versus(ours: number, theirs: number): string {
  const a = Math.max(ours, 1)
  const b = Math.max(theirs, 1)
  const faster = a < b
  const r = faster ? b / a : a / b
  if (r < 2) {
    const pct = Math.round((r - 1) * 100)
    return pct === 0 ? 'vx same' : `vx ${pct}% ${faster ? 'faster' : 'slower'}`
  }
  const k = r >= 10 ? Math.round(r) : Math.round(r * 10) / 10
  return `vx ${k}× ${faster ? 'faster' : 'slower'}`
}
const FORMULA =
  'Time each tool adds over the ideal run; vx N% or N× faster means that tool adds N% more or N times as much as vx.'
const vxCommit = / @ (\w+)$/.exec(vx.version)?.[1]
const RUN = `Run ${d.date.slice(0, 10)} on ${d.machine}: vx ${vxCommit ? `at commit ${vxCommit}` : 'from source'}, Turborepo ${turbo.version}, Nx ${nx.version}, Vite Task (vite-plus) ${vt.version}.`
const s = (ms: number): string => `${+(ms / 1000).toFixed(2)} s`
const WORKLOAD = `Benchmark workload: a synthetic monorepo of ${n(d.packages)} projects and ${n(d.tasks)} tasks in ${d.levels} dependency levels, five core libraries a quarter of the projects use; build ${s(d.buildMs)}, test and typecheck ${s(d.buildMs / 2)}, lint ${s(d.buildMs / 4)}, publish ${s(d.buildMs / 10)}; real repos with uneven task times will differ.`
const vs = (r: Row, f: (r: Row) => number): string => `${disp(f(r))} (${versus(f(vx), f(r))})`
const tableBlock =
  'const benchTable = [\n' +
  table
    .map(
      ([label, f]) =>
        `  { label: '${label}', vx: '${disp(f(vx))}', turbo: '${vs(turbo, f)}', nx: '${vs(nx, f)}', vt: '${vs(vt, f)}' },`,
    )
    .join('\n') +
  '\n]\n' +
  `const benchFormula = '${FORMULA}'\n` +
  `const benchWorkload = '${WORKLOAD}'\n` +
  `const benchRun = '${RUN}'\n`

// ---- landing page ----
const landingPath = path.join(ROOT, 'packages/vx-docs/src/pages/index.astro')
let landing = readFileSync(landingPath, 'utf8')
landing = rewrite(
  landing,
  /const benchTable = \[\n[\s\S]*?\n\]\nconst benchFormula = '[^'\n]*'\n(?:const benchWorkload = '[^'\n]*'\n)?(?:const benchRun = '[^'\n]*'\n)?/,
  tableBlock,
  'the benchTable block',
)
function rewrite(text: string, re: RegExp, to: string, what: string): string {
  if (!re.test(text)) throw new Error(`index.astro: ${what} not found`)
  return text.replace(re, to)
}
landing = rewrite(
  landing,
  /\/\/ [\d,]+ tasks · [\d,]+ (?:packages|projects) · \d+ (?:layers|levels) ·/,
  `// ${n(d.tasks)} tasks · ${n(d.packages)} projects · ${d.levels} levels ·`,
  'the benchmark kicker',
)

// ---- README benchmark table ----
const readmePath = path.join(ROOT, 'README.md')
const head = `Time added over the ideal run, ${n(d.packages)} projects, ${n(d.tasks)} tasks`
const readmeBlock = `<!-- bench:start — generated by packages/vx-bench/update-site.ts from results.json; do not hand-edit -->

| ${head} | vx | Turborepo | Nx | Vite Task |
| --- | --- | --- | --- | --- |
${table.map(([label, f]) => `| ${label} | **${disp(f(vx))}** | ${vs(turbo, f)} | ${vs(nx, f)} | ${vs(vt, f)} |`).join('\n')}

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

| ${head} | vx | ${name} |
| --- | --- | --- |
${table.map(([label, f]) => `| ${label} | **${disp(f(vx))}** | ${vs(r, f)} |`).join('\n')}

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

// ---- benchmarks.md head-to-head section ----
const docPath = path.join(ROOT, 'packages/vx/docs/benchmarks.md')
let doc = readFileSync(docPath, 'utf8')
const cell = (r: Row, f: (r: Row) => number): string =>
  r === vx ? `**${disp(f(r))}**` : r === noLock ? disp(f(r)) : vs(r, f)
const cols = [vx, noLock, turbo, nx, vt]
const section = `## Head to head: ${n(d.tasks)} tasks, ${d.levels} levels (${d.date.slice(0, 10)})

The shape (owner's spec, 2026-10-09): ${d.levels - 1} levels of 50 libraries and a
last level of 100 apps; 50 more libraries at level 15 that nothing depends on;
one \`e2e\` project depending on every app and on those 50. Every project depends
on 2–5 others in the five levels below, and five core libraries at level 1 are
each used by about a quarter of the projects. ${n(d.packages)} projects, 20 source files each.
Tasks: \`installDeps\` (no command, after the dependencies' \`build\`), \`build\`,
\`lint\` and \`test\` (after \`installDeps\`), \`publish\` (after \`build\`) and
\`typecheck\` (after the dependencies' \`build\`); \`e2e\` has \`lint\` and \`test\`.
${n(d.tasks)} task nodes. Each sleeps in the same ratios: build ${s(d.buildMs)}, test and
typecheck ${s(d.buildMs / 2)}, lint ${s(d.buildMs / 4)}, publish ${s(d.buildMs / 10)}, long enough that the tasks, not
any tool's own per-task work, set the pace. \`build\` writes 200 KB of seeded
incompressible bytes plus a file that folds its dependencies' outputs.
The bench times what CI runs: a cold build, a run with nothing changed, and a
restore from cache (owner, 2026-10-09: an edit needs Nx's daemon, which CI
does not run, so no edit row compares fairly).

Same repo, same hardware, same commands, every tool at concurrency ${d.concurrency}, each in its own native
config: Turborepo ${turbo.version} (\`turbo.json\`), Nx ${nx.version} (\`nx:run-commands\` targets,
\`^\` inputs), Vite Task (\`vp run\`, vite-plus ${vt.version}, tasks in each \`vite.config.ts\`).
vx runs from a \`vx lock\` snapshot (\`--frozen\`), as a CI pipeline runs it;
*vx, no lock* evaluates every config per run. This machine: ${d.machine}.
\`bun packages/vx-bench/compare.ts 3\`; the committed
\`packages/vx-bench/RESULTS.md\` / \`packages/vx-bench/results.json\` are this run.

**Time each tool adds over the ideal run:**

|                              | vx         | vx, no lock | Turborepo | Nx       | Vite Task |
| ---------------------------- | ---------- | ----------- | --------- | -------- | --------- |
${table.map(([label, f]) => `| **${label}** | ${cols.map((r) => cell(r, f)).join(' | ')} |`).join('\n')}

${FORMULA}

${WORKLOAD}

**The ideal run** is the theoretical best case, so every row is overhead.
Nothing changed: one \`git status -uall\` walk (${disp(B.warmNoRestore)}), the floor of asking what changed.
Outputs restored: that walk plus a raw copy of every output (${disp(B.warmRestore)}).
Cold: every task list-scheduled critical-path first (critical path
${disp(B.criticalPathMs)}, work ÷ workers ${disp(B.workBoundMs)}).
**CPU** is user + system of the invocation and the children it waited for,
less what the task commands themselves burn under \`xargs -P ${d.concurrency}\`
(${disp(B.freshCpu)}); a daemon that outlives the invocation (Turborepo's, Nx's)
is not counted, so theirs is a floor.

> Methodology note: a synthetic graph with \`sleep\`-based tasks isolates
> _runner_ overhead from real compilation. All four runners are
> configured **identically**: same commands, the same \`src/**\` inputs and
> \`dist/**\` outputs, the same concurrency, and each sees a dependency's
> change (Turborepo and vx fold upstream keys; Nx through \`^\` inputs;
> Vite Task through each dependency's output as an input).

`
const start = doc.search(/^## (?:A real monorepo|Head to head):/m)
const end = doc.indexOf('\n## ', start + 1) + 1
if (start === -1 || end === 0)
  throw new Error('benchmarks.md: head-to-head section anchors not found')
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
