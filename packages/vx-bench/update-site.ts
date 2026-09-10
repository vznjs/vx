#!/usr/bin/env bun
// Rewrite the landing page's benchmark rows, stat tiles and note, and the
// benchmarks doc's stress-shape section, from packages/vx-bench/results.json — the file
// `packages/vx-bench/compare.ts` commits. The site is a rendering of the runner's
// output, never hand-typed numbers; run this after every comparison.
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
// to a cold build over the ideal schedule of the tasks themselves, in ONE
// unit for every runner — clock time, `+m:ss` — never a percentage for one
// and a multiple for another (owner, 2026-09-10, late night: a percentage
// of a big example reads as "this scales"; seconds against minutes reads
// as what it is). `perPkg` is the same overhead per package, in ms, the
// number that says how the runner grows with the codebase.
const clock = (ms: number): string => {
  const m = Math.floor(ms / 60_000)
  const s = Math.round((ms - m * 60_000) / 1000)
  return `${m}:${String(s).padStart(2, '0')}`
}
const plus = (r: Row): string => `+${clock(Number(r.fresh) - B.fresh)}`
const perPkg = (r: Row): number => Math.round((Number(r.fresh) - B.fresh) / d.packages)

// ---- landing page ----
const bar = (name: string, val: number, c: string, best = false): string =>
  `      { name: '${name}', val: ${Math.round(val)}, disp: '${disp(val)}', c: '${c}'${best ? ', best: true' : ''} },`
const row = (task: string, key: keyof Row, baseKey: keyof Results['baseline']): string =>
  [
    '  {',
    `    task: '${task}',`,
    '    bars: [',
    bar('baseline', B[baseKey], 'var(--c-baseline)'),
    bar('vx', Number(vx[key]), 'var(--phosphor)', true),
    bar('turbo', Number(turbo[key]), 'var(--c-turbo)'),
    bar('nx', Number(nx[key]), 'var(--c-nx)'),
    '    ],',
    '  },',
  ].join('\n')
// The baseline is THEORETICAL: cold is the tasks' own durations under an
// ideal schedule; a cached run, a restore and the CPU a runner burns are 0
// in theory — everything drawn is the runner (owner's definition,
// 2026-09-03). The measured floors (one git walk, a raw copy, the task
// shells under xargs) stay in packages/vx-bench/RESULTS.md as context.
const zeroRow = (task: string, key: keyof Row): string =>
  [
    '  {',
    `    task: '${task}',`,
    '    bars: [',
    "      { name: 'baseline', val: 0, disp: '0', c: 'var(--c-baseline)' },",
    bar('vx', Number(vx[key]), 'var(--phosphor)', true),
    bar('turbo', Number(turbo[key]), 'var(--c-turbo)'),
    bar('nx', Number(nx[key]), 'var(--c-nx)'),
    '    ],',
    '  },',
  ].join('\n')
const rowsBlock =
  'const benchRows = [\n' +
  [
    row('Cold build · from scratch', 'fresh', 'fresh'),
    zeroRow('Fully cached · nothing to rebuild', 'warmNoRestore'),
    zeroRow('Restoring outputs · cache → disk', 'warmRestore'),
    zeroRow('CPU burned · cold build, user + system', 'freshCpu'),
  ].join('\n') +
  '\n]\n'

const landingPath = path.join(ROOT, 'packages/vx-docs/src/pages/index.astro')
let landing = readFileSync(landingPath, 'utf8')
landing = landing.replace(/const benchRows = \[\n[\s\S]*?\n\]\n/, rowsBlock)
// The three stat tiles: the same overhead per package for every runner.
for (const [label, r] of [
  ['vx', vx],
  ['Turborepo', turbo],
  ['Nx', nx],
] as const) {
  const re = new RegExp(
    `<span class="num">[\\d,]+</span><span class="unit">ms</span></span>\\n(\\s*)<span class="label">per package · ${label}</span>\\n(\\s*)<span class="sub">[^<]*</span>`,
  )
  if (!re.test(landing)) throw new Error(`index.astro: stat tile for ${label} not found`)
  landing = landing.replace(
    re,
    `<span class="num">${perPkg(r).toLocaleString('en-US')}</span><span class="unit">ms</span></span>\n$1<span class="label">per package · ${label}</span>\n$2<span class="sub">${plus(r)} on ${d.packages.toLocaleString('en-US')} packages</span>`,
  )
}
const note = `<p>
              Your tasks alone take ${disp(B.fresh)} on this graph — the ideal schedule, ${d.concurrency} perfectly parallel workers
              along the dependency graph. vx finishes the cold build in ${disp(vx.fresh)} (${plus(vx)}), Turborepo in
              ${disp(turbo.fresh)} (${plus(turbo)}), Nx in ${disp(nx.fresh)} (${plus(nx)}). Everything above the
              baseline is the runner: ${perPkg(vx)} ms per package for vx, ${perPkg(turbo)} ms for Turborepo, ${perPkg(nx).toLocaleString('en-US')} ms for Nx.
            </p>
            <p>
              ${d.packages.toLocaleString('en-US')} packages, ${nodes.toLocaleString('en-US')} tasks, 100 dependency layers, identical commands, every runner
              pinned to the same concurrency, daemons on for the others, measured one at a time
              (${d.date.slice(0, 10)}, Turborepo ${turbo.version}, Nx ${nx.version}, Apple silicon, 10 cores). The tasks are
              <code>sleep 1</code>, so the clock measures the runner and CPU measures its overhead:
              vx burned ${Math.round(vx.freshCpu / 1000)} s to build the whole graph cold, Turborepo ${Math.round(turbo.freshCpu / 1000)} s, Nx ${Math.round(nx.freshCpu / 60_000)} minutes. Warm,
              vx replays ${nodes.toLocaleString('en-US')} tasks in ${disp(vx.warmNoRestore)}; Turborepo ${disp(turbo.warmNoRestore)}; Nx ${disp(nx.warmNoRestore)}. Reproduce with
              <code>bun packages/vx-bench/compare.ts 100 11 1</code>; the committed results are this run. The dashed <em>baseline</em> is the theoretical best case: cold is the tasks' own ${disp(B.fresh)} on 10 perfectly parallel workers along the dependency graph, and a cached run, a restore and the CPU a runner burns are 0 in theory — every bar is the runner's overhead. Bars are proportional within a row; a bar more than ten times the next runner's is clipped with a break, and the numbers are exact.
            </p>`
landing = landing.replace(
  /<p>\s*Your tasks alone take[\s\S]*?<\/p>\s*<p>\s*[\d,]+ packages, [\d,]+ tasks, 100 dependency layers,[\s\S]*?<\/p>/,
  note,
)

// ---- README benchmark sentence ----
// Between the bench markers the README states the same three numbers the
// landing page's stat tiles do; hand-typed, it drifted (559 ms where the
// committed run said 510, 2026-09-10). Rendered here, checked with the rest.
const readmePath = path.join(ROOT, 'README.md')
const readmeBlock = `<!-- bench:start — generated by packages/vx-bench/update-site.ts from results.json; do not hand-edit -->
The runner adds seconds to a cold build where others add minutes. On a
${d.packages.toLocaleString('en-US')}-package graph of ${nodes.toLocaleString('en-US')} tasks whose ideal schedule is ${disp(B.fresh)},
vx finishes in ${disp(vx.fresh)} (${plus(vx)}), Turborepo in ${disp(turbo.fresh)} (${plus(turbo)}) and Nx in
${disp(nx.fresh)} (${plus(nx)}) — ${perPkg(vx)} ms of overhead per package against ${perPkg(turbo)} ms and
${perPkg(nx).toLocaleString('en-US')} ms, so the graph can grow and the runner stays in seconds. The cold build
burns ${Math.round(vx.freshCpu / 1000)} s of CPU in vx, ${Math.round(turbo.freshCpu / 1000)} s in Turborepo and ${Math.round(nx.freshCpu / 60_000)} minutes in Nx; a
fully cached run replays the graph in ${Math.round(vx.warmNoRestore)} ms.
<!-- bench:end -->`
const readmeIn = readFileSync(readmePath, 'utf8')
const readmeOut = readmeIn.replace(/<!-- bench:start[\s\S]*?<!-- bench:end -->/, readmeBlock)
if (!readmeOut.includes('<!-- bench:start')) throw new Error('README.md: bench markers not found')

// ---- benchmarks.md stress section ----
const docPath = path.join(ROOT, 'packages/vx/docs/benchmarks.md')
let doc = readFileSync(docPath, 'utf8')
const cell = (r: Row, key: keyof Row) => `${disp(Number(r[key]))} (${x(r, key)})`
const section = `## A real monorepo: ${nodes.toLocaleString('en-US')} tasks, 100 layers (${d.date.slice(0, 10)})

The shape that actually stresses a task runner: **100 dependency layers**,
~11 packages per layer, ~30 deps per package, three tasks each
(\`build\` + \`installDeps\` + \`test\`, \`sleep 1\` for build and test) — **${nodes.toLocaleString('en-US')}
task nodes**, ${d.packages.toLocaleString('en-US')} packages. Same repo, same hardware, same task commands;
every runner pinned to concurrency ${d.concurrency}. \`bun packages/vx-bench/compare.ts 100 11 1\`,
this machine (macOS arm64, 10 cores), Turbo ${turbo.version}, Nx ${nx.version}.
The committed \`packages/vx-bench/RESULTS.md\` / \`packages/vx-bench/results.json\` are this run.

|                              | vx         | Turborepo | Nx       |
| ---------------------------- | ---------- | --------- | -------- |
| **Cold** (nothing cached)    | **${disp(vx.fresh)}** | ${cell(turbo, 'fresh')} | ${cell(nx, 'fresh')} |
| **Warm**, nothing to rebuild | **${disp(vx.warmNoRestore)}** | ${cell(turbo, 'warmNoRestore')} | ${cell(nx, 'warmNoRestore')} |
| **Warm**, restore outputs    | **${disp(vx.warmRestore)}** | ${cell(turbo, 'warmRestore')} | ${cell(nx, 'warmRestore')} |
| **CPU burned**, cold (user+sys) | **${disp(vx.freshCpu)}** | ${cell(turbo, 'freshCpu')} | ${cell(nx, 'freshCpu')} |
| **CPU burned**, warm (user+sys) | **${disp(vx.warmNoRestoreCpu)}** | ${cell(turbo, 'warmNoRestoreCpu')} | ${cell(nx, 'warmNoRestoreCpu')} |
| _Baseline_ (theoretical best) | ${disp(B.fresh)} cold; 0 warm, restore, CPU | — | — |
| _Measured floors_ (context)  | git walk ${disp(B.warmNoRestore)} · walk + raw copy ${disp(B.warmRestore)} · task shells ${disp(B.freshCpu)} | — | — |

**Baseline** is the theoretical best case, so each row shows its overhead:
cold is the tasks' own durations list-scheduled on 10 workers along the
exact dependency graph (critical path ${disp(B.criticalPathMs)}, total work ÷
workers ${disp(B.workBoundMs)}); a cached run, a restore and the CPU a
runner burns are 0 in theory, so every measured number in those rows is
the runner. vx's cold overhead over the ideal schedule is
${disp(vx.fresh - B.fresh)} on ${nodes.toLocaleString('en-US')} tasks (${perPkg(vx)} ms per package); Turborepo's is
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
daemon that outlives the invocation (Turbo's, Nx's) is not counted, so
their CPU is a floor.

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
  process.stdout.write('site matches packages/vx-bench/results.json\n')
} else {
  writeFileSync(landingPath, landingOut)
  writeFileSync(docPath, docOut)
  writeFileSync(readmePath, readmeFormatted)
  process.stdout.write(
    changed ? 'site rewritten from packages/vx-bench/results.json\n' : 'site already matched\n',
  )
}
