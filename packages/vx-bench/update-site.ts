#!/usr/bin/env bun
// Rewrite the landing page's benchmark rows and the graph's size, the
// README's benchmark sentence and chart (packages/vx-docs/public/bench-{light,dark}.svg)
// and the benchmarks doc's stress-shape section,
// from packages/vx-bench/results.json — the file `packages/vx-bench/compare.ts`
// commits. The site is a rendering of the runner's output, never hand-typed
// numbers; run this after every comparison. The landing shows this one
// benchmark (design/site-short-2026-09.md); the real-repo tables stay in
// benchmarks.md, typed there.
//
//   bun packages/vx-bench/update-site.ts          # rewrite in place
//   bun packages/vx-bench/update-site.ts --check  # exit 1 if the site would change (CI-able)

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
landing = rewrite(landing, /const benchRows = \[\n[\s\S]*?\n\]\n/, rowsBlock, 'the benchRows block')
function rewrite(text: string, re: RegExp, to: string, what: string): string {
  if (!re.test(text)) throw new Error(`index.astro: ${what} not found`)
  return text.replace(re, to)
}
// The graph's size, where the page names it: the panel's kicker and its
// sub.
landing = rewrite(
  landing,
  /\/\/ [\d,]+ tasks · [\d,]+ packages · \d+ layers ·/,
  `// ${nodes.toLocaleString('en-US')} tasks · ${d.packages.toLocaleString('en-US')} packages · ${d.layers} layers ·`,
  'the benchmark kicker',
)
landing = rewrite(
  landing,
  /synthetic [\d,]+-task graph/,
  `synthetic ${nodes.toLocaleString('en-US')}-task graph`,
  "the benchmark panel's graph size",
)

const docPath = path.join(ROOT, 'packages/vx/docs/benchmarks.md')
const docIn = readFileSync(docPath, 'utf8')
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

// ---- the chart image ----
// The README's chart, cold build and fully cached, one bar per runner, from
// the same rows as the text above. One file per theme: the README's
// <picture> picks by GitHub's theme setting, which an SVG's own
// `prefers-color-scheme` rule cannot see. System fonts, since an <img>
// loads none.
const THEMES = {
  light: { text: '#1f2328', muted: '#59636e', vx: '#7cb518' },
  dark: { text: '#e6edf3', muted: '#9198a1', vx: '#c6f84e' },
}
type Theme = keyof typeof THEMES
const chartPath = (t: Theme): string => path.join(ROOT, `packages/vx-docs/public/bench-${t}.svg`)
function chart(theme: Theme): string {
  const c = THEMES[theme]
  const W = 760
  const labelW = 110
  const barMax = 470
  const rowH = 30
  const panel = (
    y0: number,
    title: string,
    note: string,
    key: keyof Row,
    ideal?: number,
  ): string => {
    const runners = [
      { r: vx, name: 'vx', cls: 'vx' },
      { r: turbo, name: 'Turborepo', cls: 'turbo' },
      { r: nx, name: 'Nx', cls: 'nx' },
    ]
    const max = Math.max(...runners.map((x) => Number(x.r[key])))
    const w = (v: number): number => Math.max(2, Math.round((v / max) * barMax))
    const out = [
      `<text class="title" x="0" y="${y0}">${title}</text>`,
      `<text class="note" x="${W}" y="${y0}" text-anchor="end">${note}</text>`,
    ]
    runners.forEach((x, i) => {
      const v = Number(x.r[key])
      const y = y0 + 16 + i * rowH
      out.push(
        `<text class="${x.cls === 'vx' ? 'vxname' : 'name'}" x="${labelW - 12}" y="${y + 15}" text-anchor="end">${x.name}</text>`,
        `<rect class="${x.cls}" x="${labelW}" y="${y}" width="${w(v)}" height="20" rx="3"/>`,
        `<text class="${x.cls === 'vx' ? 'val vxval' : 'val'}" x="${labelW + w(v) + 8}" y="${y + 15}">${disp(v)}</text>`,
      )
    })
    if (ideal !== undefined) {
      const ix = labelW + w(ideal)
      const bottom = y0 + 16 + runners.length * rowH - 6
      out.push(
        `<line class="ideal" x1="${ix}" y1="${y0 + 8}" x2="${ix}" y2="${bottom}"/>`,
        `<text class="note" x="${ix + 4}" y="${bottom + 12}">ideal schedule ${disp(ideal)}</text>`,
      )
    }
    return out.join('\n  ')
  }
  const H = 290
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Cold build: vx ${disp(vx.fresh)}, Turborepo ${disp(turbo.fresh)}, Nx ${disp(nx.fresh)}. Fully cached: vx ${disp(vx.warmNoRestore)}, Turborepo ${disp(turbo.warmNoRestore)}, Nx ${disp(nx.warmNoRestore)}.">
  <style>
    text { font-family: ui-sans-serif, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif; font-size: 14px; fill: ${c.text}; }
    .title { font-weight: 600; font-size: 15px; }
    .note { font-size: 12px; }
    .note, .name { fill: ${c.muted}; }
    .vxname, .vxval { font-weight: 700; }
    .val { font-variant-numeric: tabular-nums; }
    .vx { fill: ${c.vx}; } .turbo { fill: #ff5e9c; } .nx { fill: #6aa8ff; }
    .ideal { stroke: ${c.muted}; stroke-dasharray: 3 3; }
  </style>
  ${panel(18, `Cold build · ${nodes.toLocaleString('en-US')} tasks, ${d.packages.toLocaleString('en-US')} packages`, 'lower is better', 'fresh', B.fresh)}
  ${panel(168, 'Fully cached · nothing to rebuild', `concurrency ${d.concurrency}, same commands`, 'warmNoRestore')}
</svg>
`
}
const chartOut = { light: chart('light'), dark: chart('dark') }
const readOr = (p: string): string => (existsSync(p) ? readFileSync(p, 'utf8') : '')

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
  readOr(chartPath('light')),
  readOr(chartPath('dark')),
]
const changed =
  before[0] !== landingOut ||
  before[1] !== docOut ||
  before[2] !== readmeFormatted ||
  before[3] !== chartOut.light ||
  before[4] !== chartOut.dark
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
  writeFileSync(chartPath('light'), chartOut.light)
  writeFileSync(chartPath('dark'), chartOut.dark)
  process.stdout.write(
    changed ? 'site rewritten from packages/vx-bench/results.json\n' : 'site already matched\n',
  )
}
