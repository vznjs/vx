#!/usr/bin/env bun
// Rewrite the landing page's benchmark rows, stat tiles and note, and the
// benchmarks doc's stress-shape section, from bench/results.json — the file
// `bench/compare.ts` commits. The site is a rendering of the runner's
// output, never hand-typed numbers; run this after every comparison.
//
//   bun bench/update-site.ts          # rewrite in place
//   bun bench/update-site.ts --check  # exit 1 if the site would change (CI-able)

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dir, '..')
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

const d = JSON.parse(readFileSync(path.join(ROOT, 'bench/results.json'), 'utf8')) as Results
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
const rowsBlock =
  'const benchRows = [\n' +
  [
    row('Cold build · from scratch', 'fresh', 'fresh'),
    row('Fully cached · nothing to rebuild', 'warmNoRestore', 'warmNoRestore'),
    row('Restoring outputs · cache → disk', 'warmRestore', 'warmRestore'),
    row('CPU burned · cold build, user + system', 'freshCpu', 'freshCpu'),
  ].join('\n') +
  '\n]\n'

const landingPath = path.join(ROOT, 'apps/docs/src/pages/index.astro')
let landing = readFileSync(landingPath, 'utf8')
landing = landing.replace(/const benchRows = \[\n[\s\S]*?\n\]\n/, rowsBlock)
landing = landing.replace(
  /<span class="num">\d+<\/span><span class="unit">ms<\/span><\/span>\n(\s*)<span class="label">Full cache replay<\/span>/,
  `<span class="num">${Math.round(vx.warmNoRestore)}</span><span class="unit">ms</span></span>\n$1<span class="label">Full cache replay</span>`,
)
landing = landing.replace(
  /<span class="sub">[\d,]+ tasks · [\d,]+ packages<\/span>/,
  `<span class="sub">${nodes.toLocaleString('en-US')} tasks · ${d.packages.toLocaleString('en-US')} packages</span>`,
)
landing = landing.replace(
  /<span class="num">[\d.]+<\/span><span class="unit">×<\/span><\/span>\n(\s*)<span class="label">Less CPU burned<\/span>/,
  `<span class="num">${(turbo.freshCpu / vx.freshCpu).toFixed(1)}</span><span class="unit">×</span></span>\n$1<span class="label">Less CPU burned</span>`,
)
landing = landing.replace(
  /<span class="num">[\d.]+<\/span><span class="unit">×<\/span><\/span>\n(\s*)<span class="label">Faster warm runs<\/span>/,
  `<span class="num">${(nx.warmNoRestore / vx.warmNoRestore).toFixed(1)}</span><span class="unit">×</span></span>\n$1<span class="label">Faster warm runs</span>`,
)
const note = `<p>
              ${d.packages.toLocaleString('en-US')} packages, ${nodes.toLocaleString('en-US')} tasks, 100 dependency layers, identical commands, every runner
              pinned to the same concurrency, daemons on for the others, measured one at a time
              (${d.date.slice(0, 10)}, Turborepo ${turbo.version}, Nx ${nx.version}, Apple silicon, 10 cores). The tasks are
              <code>sleep 1</code>, so the clock measures the runner and CPU measures its overhead:
              vx burned ${Math.round(vx.freshCpu / 1000)} s to build the whole graph cold, Turborepo ${Math.round(turbo.freshCpu / 1000)} s, Nx ${Math.round(nx.freshCpu / 60_000)} minutes. Warm,
              vx replays ${nodes.toLocaleString('en-US')} tasks in ${disp(vx.warmNoRestore)}; Turborepo ${disp(turbo.warmNoRestore)}; Nx ${disp(nx.warmNoRestore)}. Reproduce with
              <code>bun bench/compare.ts 100 11 1</code>; the committed results are this run. The dashed <em>baseline</em> bar is the theoretical best case: cold is the tasks' own ${disp(B.fresh)} on 10 perfectly parallel workers along the dependency graph, warm is one <code>git status</code> walk (${disp(B.warmNoRestore)}), restore adds a raw copy of every output file, and CPU is the tasks' own shells under <code>xargs</code> (${disp(B.freshCpu)}) — what is left above it is the runner. At this size the CPU floor and a runner's own CPU each vary by about two seconds between runs, so vx's cold CPU sits within the floor's noise.
            </p>`
landing = landing.replace(
  /<p>\s*[\d,]+ packages, [\d,]+ tasks, 100 dependency layers,[\s\S]*?<\/p>/,
  note,
)

// ---- benchmarks.md stress section ----
const docPath = path.join(ROOT, 'docs/benchmarks.md')
let doc = readFileSync(docPath, 'utf8')
const cell = (r: Row, key: keyof Row) => `${disp(Number(r[key]))} (${x(r, key)})`
const section = `## A real monorepo: ${nodes.toLocaleString('en-US')} tasks, 100 layers (${d.date.slice(0, 10)})

The shape that actually stresses a task runner: **100 dependency layers**,
~11 packages per layer, ~30 deps per package, three tasks each
(\`build\` + \`installDeps\` + \`test\`, \`sleep 1\` for build and test) — **${nodes.toLocaleString('en-US')}
task nodes**, ${d.packages.toLocaleString('en-US')} packages. Same repo, same hardware, same task commands;
every runner pinned to concurrency ${d.concurrency}. \`bun bench/compare.ts 100 11 1\`,
this machine (macOS arm64, 10 cores), Turbo ${turbo.version}, Nx ${nx.version}.
The committed \`bench/RESULTS.md\` / \`bench/results.json\` are this run.

|                              | vx         | Turborepo | Nx       |
| ---------------------------- | ---------- | --------- | -------- |
| **Cold** (nothing cached)    | **${disp(vx.fresh)}** | ${cell(turbo, 'fresh')} | ${cell(nx, 'fresh')} |
| **Warm**, nothing to rebuild | **${disp(vx.warmNoRestore)}** | ${cell(turbo, 'warmNoRestore')} | ${cell(nx, 'warmNoRestore')} |
| **Warm**, restore outputs    | **${disp(vx.warmRestore)}** | ${cell(turbo, 'warmRestore')} | ${cell(nx, 'warmRestore')} |
| **CPU burned**, cold (user+sys) | **${disp(vx.freshCpu)}** | ${cell(turbo, 'freshCpu')} | ${cell(nx, 'freshCpu')} |
| **CPU burned**, warm (user+sys) | **${disp(vx.warmNoRestoreCpu)}** | ${cell(turbo, 'warmNoRestoreCpu')} | ${cell(nx, 'warmNoRestoreCpu')} |
| _Baseline_ (theoretical best) | ${disp(B.fresh)} | — | — |
| _Baseline_, warm / restore | ${disp(B.warmNoRestore)} / ${disp(B.warmRestore)} | — | — |
| _Baseline_, CPU cold / warm | ${disp(B.freshCpu)} / ${disp(B.warmNoRestoreCpu)} | — | — |

**Baseline** is the theoretical best case, so each row shows its overhead:
cold is the tasks' own durations list-scheduled on 10 workers along the
exact dependency graph (critical path ${disp(B.criticalPathMs)}, total work ÷
workers ${disp(B.workBoundMs)}); warm is ONE \`git status -uall\` walk — the floor
of asking what changed; restore adds a raw copy of every output file; CPU
is the tasks' own shells (one measured spawn × the task count) plus that
walk. vx's cold overhead over the ideal schedule is
${Math.round((vx.fresh - B.fresh) / 1000)} s on ${nodes.toLocaleString('en-US')} tasks. At this size the CPU floor
and a runner's own CPU each vary by about two seconds between runs (the same
3,270 shells under \`xargs\` read 33.5–34.9 s across readings), so vx's cold
CPU sits within the floor's noise.

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
const before = [readFileSync(landingPath, 'utf8'), readFileSync(docPath, 'utf8')]
const changed = before[0] !== landingOut || before[1] !== docOut
if (CHECK) {
  if (changed) {
    process.stderr.write(
      'bench/update-site.ts --check: the site does not match bench/results.json\n',
    )
    process.exit(1)
  }
  process.stdout.write('site matches bench/results.json\n')
} else {
  writeFileSync(landingPath, landingOut)
  writeFileSync(docPath, docOut)
  process.stdout.write(
    changed ? 'site rewritten from bench/results.json\n' : 'site already matched\n',
  )
}
