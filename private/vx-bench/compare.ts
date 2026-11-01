#!/usr/bin/env bun
/**
 * Head-to-head benchmark: vx vs Turborepo vs Nx vs Vite Task (`vp run`,
 * from vite-plus) on ONE synthetic monorepo, every runner configured
 * identically. Writes the runners' rows as JSON to OUT; the `bench.*` tasks
 * (vx.config.ts) run one runner each, and the site reads their files.
 *
 *   bun private/vx-bench/compare.ts [reps=3]
 *   CONCURRENCY=10 COLD_REPS=1 RUNNERS=vx,turbo OUT=out.json bun private/vx-bench/compare.ts
 *
 * Turborepo, Nx and vite-plus are this package's pinned devDependencies,
 * linked into the workspace: no install, so a run needs no network.
 *
 * The workspace is shape.ts (owner's spec, 2026-10-09): 29 levels of 50
 * libs and 100 apps, 50 terminal libs at level 15, one `e2e`
 * project on every edge, cross-level edges and five core libs most
 * projects use. Tasks: `installDeps` (no command, ^build), `build`, `lint`
 * and `test` (installDeps), `publish` (build), `typecheck` (^build). Every
 * task sleeps (build BENCH_BUILD_MS, lint ¼, test ½, publish ⅒, typecheck ½);
 * `build` also writes 200 KB of incompressible bytes and concatenates the project's
 * 20 source files into dist/index.js. `installDeps` is the owner's
 * `install`: a package.json `install` script would run on `bun install`.
 *
 * States, one runner at a time, every runner at the same concurrency, as in
 * CI (`CI=1`, so Nx's daemon is off; telemetry and cloud off):
 *   fresh         — cache and outputs cleared (COLD_REPS, default 1)
 *   warm          — everything cached, outputs intact
 *   restore       — every dist/ deleted, restored from cache
 * The headline is OVERHEAD: each state minus its ideal (the tasks' own
 * durations list-scheduled on the same workers, plus the floor of asking
 * git what changed). vx runs as its compiled binary from a `vx lock`
 * snapshot, as every vx run does.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { summarize } from './ab.js'
import { listSchedule } from './ideal.js'
import { deleteDist, missingDist } from './outputs.js'
import {
  generate,
  gitInit,
  linkRivals,
  RUNNER_ENV,
  rivalRuns,
  type Rival,
} from './site-workspace.js'
import {
  APPS,
  BUILD_MS,
  LEVELS,
  PER_LEVEL,
  RUN_TASKS,
  TERMINALS,
  command,
  idealOf,
  workspace,
} from './shape.js'

const REPS = Number(process.argv[2] ?? 3)
const COLD_REPS = Number(process.env.COLD_REPS ?? 1)
// Every runner is pinned to the SAME max concurrency so no tool is
// advantaged by a different default (vx defaults to CPU cores, Turbo to
// 10, Nx to 3).
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 10)
const OUT = process.env.OUT ?? path.join(import.meta.dir, 'site', 'bench.json')
const modules = path.join(import.meta.dir, 'node_modules')
const PROJECTS = workspace()
const BUILT = PROJECTS.filter((p) => 'build' in p.tasks).map((p) => `packages/${p.dir}`)
const TASKS = PROJECTS.reduce((n, p) => n + Object.keys(p.tasks).length, 0)

/**
 * Wall time and CPU time of one invocation. CPU is the runner process plus
 * every descendant it waited for (`getrusage(RUSAGE_CHILDREN)` semantics,
 * which Bun exposes as `resourceUsage()` after exit). A daemon that outlives
 * the invocation (Turbo's, Nx's) is NOT counted, so their CPU is a floor.
 */
async function sh(
  cmd: string[],
  cwd: string,
): Promise<{ ms: number; cpuMs: number; ok: boolean; out: string }> {
  const t0 = Bun.nanoseconds()
  const p = Bun.spawn({ cmd, cwd, stdout: 'pipe', stderr: 'pipe', env: RUNNER_ENV })
  const [code, out, err] = await Promise.all([
    p.exited,
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ])
  const usage = p.resourceUsage()
  // Bun reports cpuTime as BigInt microseconds.
  const cpuMs = usage ? Number(usage.cpuTime.user + usage.cpuTime.system) / 1000 : NaN
  return { ms: (Bun.nanoseconds() - t0) / 1e6, cpuMs, ok: code === 0, out: out + err }
}

// ---- runners ----

interface Runner {
  name: string
  version: string
  run: string[]
  clear: () => Promise<void>
}

async function buildRunners(dir: string, wanted: (name: string) => boolean): Promise<Runner[]> {
  const runners: Runner[] = []

  // vx — compile the standalone binary (the artifact real users install via
  // npm / release.yml). Comparing TS-source startup against Turbo's
  // and Nx's precompiled binaries would handicap vx unfairly.
  if (wanted('vx')) {
    const vxBin = path.join(dir, '.vx-runner')
    const target = `bun-${process.platform}-${process.arch === 'x64' ? 'x64' : process.arch}`
    const compiled = await sh(
      [
        'bun',
        'build',
        '--compile',
        '--minify',
        '--bytecode',
        `--target=${target}`,
        path.join(modules, '@vzn', 'vx', 'src', 'bin.ts'),
        '--outfile',
        vxBin,
      ],
      dir,
    )
    // Bun 1.4.0's compiled binary carries a signature this macOS rejects
    // (SIGKILL on launch, exit 137 — see docs/benchmarks.md); an ad-hoc
    // re-sign repairs it, exactly as release.yml does.
    if (compiled.ok && process.platform === 'darwin')
      await sh(['codesign', '-s', '-', '--force', vxBin], dir)
    const version = await sh([vxBin, '--version'], dir)
    if (!compiled.ok || !version.ok)
      throw new Error(`the compiled vx does not launch:\n${compiled.out}${version.out}`)
    // A source build reports 0.0.0; the commit says which vx ran
    // (2026-10-09: every bench table names its versions). A task's sandbox
    // hides .git, so CI's commit comes from its environment.
    const rev = await sh(['git', 'rev-parse', '--short=9', 'HEAD'], import.meta.dir)
    const vxCommit = process.env['GITHUB_SHA']?.slice(0, 9) ?? (rev.ok ? rev.out.trim() : '')
    const vxVer = `${version.out.trim().replace(/ \(.*\)$/, '')}${vxCommit ? ` @ ${vxCommit}` : ''}`
    // Every run loads configs only from the lock, taken once here, before any rep.
    const locked = await sh([vxBin, 'lock'], dir)
    if (!locked.ok) throw new Error(`vx lock failed:\n${locked.out}`)
    runners.push({
      name: 'vx',
      version: vxVer,
      run: [vxBin, 'run', ...RUN_TASKS, '--all', '--concurrency', String(CONCURRENCY)],
      clear: () => rm(path.join(dir, '.vx', 'cache'), { recursive: true, force: true }),
    })
  }

  // turbo + nx + vite-plus — this package's pinned installs, linked in.
  const bin = (t: string) => path.join(dir, 'node_modules', '.bin', t)
  const rivals = rivalRuns(dir, CONCURRENCY)
  const clear = (r: Rival) => async () => {
    const { command, paths } = rivals[r].clear
    if (command !== undefined) await sh(command, dir)
    for (const p of paths) await rm(path.join(dir, p), { recursive: true, force: true })
  }
  const turboV = wanted('turbo') ? await sh([bin('turbo'), '--version'], dir) : null
  if (turboV?.ok)
    runners.push({
      name: 'turbo',
      version: turboV.out.trim(),
      run: rivals.turbo.run,
      clear: clear('turbo'),
    })
  const nxV = wanted('nx') ? await sh([bin('nx'), '--version'], dir) : null
  if (nxV?.ok)
    runners.push({
      name: 'nx',
      version: (nxV.out.match(/Local:\s*v?([\d.]+)/)?.[1] ?? nxV.out.trim()).slice(0, 12),
      run: rivals.nx.run,
      clear: clear('nx'),
    })
  const vpV = wanted('vite-task') ? await sh([bin('vp'), '--version'], dir) : null
  if (vpV?.ok)
    runners.push({
      name: 'vite-task',
      version: vpV.out.match(/\d+\.\d+\.\d+/)?.[0] ?? vpV.out.trim(),
      run: rivals['vite-task'].run,
      clear: clear('vite-task'),
    })
  return runners
}

// Stop any daemon a previous runner left running so it can't idle-contend
// for CPU while the next runner is timed. (vx has no daemon; Turbo and Nx
// each keep one alive.)
async function quiesce(dir: string): Promise<void> {
  const bin = (t: string) => path.join(dir, 'node_modules', '.bin', t)
  await sh([bin('turbo'), 'daemon', 'stop'], dir).catch(() => undefined)
  await sh([bin('nx'), 'reset'], dir).catch(() => undefined)
}

type Row = {
  runner: string
  version: string
  fresh: number
  warmNoRestore: number
  warmRestore: number
  /** CPU (user + system) of the invocation and the children it waited for. */
  freshCpu: number
  warmNoRestoreCpu: number
  warmRestoreCpu: number
}

async function timed(
  r: Runner,
  dir: string,
  label: string,
): Promise<{ ms: number; cpuMs: number }> {
  const res = await sh(r.run, dir)
  if (!res.ok) throw new Error(`${r.name} failed ${label}:\n${res.out.slice(-2000)}`)
  return res
}

async function checkDist(r: Runner, dir: string, label: string): Promise<void> {
  const missing = (await missingDist(dir)).filter((m) => BUILT.includes(m))
  if (missing.length > 0)
    throw new Error(`${r.name} left ${missing.length} dist/ missing ${label}, e.g. ${missing[0]}`)
}

async function measure(r: Runner, dir: string): Promise<Row> {
  const fresh: number[] = []
  const freshCpu: number[] = []
  for (let i = 0; i < COLD_REPS; i++) {
    await r.clear()
    await deleteDist(dir)
    const res = await timed(r, dir, 'cold')
    await checkDist(r, dir, 'cold')
    fresh.push(res.ms)
    freshCpu.push(res.cpuMs)
  }
  const warm: number[] = []
  const warmCpu: number[] = []
  for (let i = 0; i < REPS; i++) {
    const res = await timed(r, dir, 'warm')
    warm.push(res.ms)
    warmCpu.push(res.cpuMs)
  }
  const restore: number[] = []
  const restoreCpu: number[] = []
  for (let i = 0; i < REPS; i++) {
    await deleteDist(dir)
    const res = await timed(r, dir, 'restoring')
    await checkDist(r, dir, 'restoring')
    restore.push(res.ms)
    restoreCpu.push(res.cpuMs)
  }
  const med = (xs: number[]) => summarize(xs).median
  return {
    runner: r.name,
    version: r.version,
    fresh: med(fresh),
    warmNoRestore: med(warm),
    warmRestore: med(restore),
    freshCpu: med(freshCpu),
    warmNoRestoreCpu: med(warmCpu),
    warmRestoreCpu: med(restoreCpu),
  }
}

// ---- baseline: the theoretical best case, so every row shows its overhead ----
//
// Theoretical, never measured (2026-10-20): nothing changed and a
// restore cost 0, so everything a runner spends there is overhead. Cold:
// the tasks' own durations list-scheduled (critical path first) on
// CONCURRENCY workers along the exact graph. CPU: the tasks' own commands
// with the sleeps taken out, under `xargs -P`.
type Baseline = {
  fresh: number
  warmNoRestore: number
  warmRestore: number
  freshCpu: number
  warmNoRestoreCpu: number
  criticalPathMs: number
  workBoundMs: number
}

async function measureBaseline(dir: string): Promise<Baseline> {
  const all = listSchedule(idealOf(PROJECTS), CONCURRENCY)
  const cmds: string[] = []
  for (const p of PROJECTS)
    for (const t of RUN_TASKS) {
      if (!(t in p.tasks)) continue
      const bare = command(p, t).replace(/^sleep [\d.]+( && )?/, '') || 'true'
      cmds.push(`cd ${path.join(dir, 'packages', p.dir)} && ${bare}`)
    }
  const list = path.join(dir, '.baseline-cmds.txt')
  await writeFile(list, cmds.join('\n') + '\n')
  // Once: CPU time, unlike wall time, barely moves with the box's
  // neighbours, and a second pass of 9,603 commands cost each runner's
  // task as long again for the same figure.
  const xargs = await sh(['sh', '-c', `xargs -P ${CONCURRENCY} -I{} sh -c '{}' < ${list}`], dir)
  if (!xargs.ok) throw new Error(`baseline xargs failed:\n${xargs.out.slice(-500)}`)
  await rm(list, { force: true })
  return {
    fresh: all.makespan,
    warmNoRestore: 0,
    warmRestore: 0,
    freshCpu: xargs.cpuMs,
    warmNoRestoreCpu: 0,
    criticalPathMs: all.critical,
    workBoundMs: all.work / CONCURRENCY,
  }
}

// ---- report ----

function fmt(ms: number): string {
  if (Number.isNaN(ms)) return 'n/a'
  if (ms >= 60_000) return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`
}

const STATES = ['warmNoRestore', 'warmRestore', 'fresh'] as const
const LABEL: Record<(typeof STATES)[number], string> = {
  warmNoRestore: 'Warm',
  warmRestore: 'Restore',
  fresh: 'Cold',
}

function markdown(rows: Row[], b: Baseline): string {
  const over = (r: Row, k: (typeof STATES)[number]) => fmt(r[k] - b[k])
  const head = `| Runner | Version | ${STATES.map((k) => `${LABEL[k]} overhead`).join(' | ')} |`
  const rule = `| ${['---', '---', ...STATES.map(() => '---')].join(' | ')} |`
  const overhead = rows.map(
    (r) => `| ${r.runner} | ${r.version} | ${STATES.map((k) => over(r, k)).join(' | ')} |`,
  )
  // No cold totals (2026-10-09 17:54): cold shows only as overhead.
  const WALL = STATES.filter((k) => k !== 'fresh')
  const totals = [
    `| Runner | ${WALL.map((k) => LABEL[k]).join(' | ')} | CPU, cold | CPU, warm |`,
    `| ${['---', ...WALL.map(() => '---'), '---', '---'].join(' | ')} |`,
    `| ideal | ${WALL.map((k) => fmt(b[k])).join(' | ')} | ${fmt(b.freshCpu)} | ${fmt(b.warmNoRestoreCpu)} |`,
    ...rows.map(
      (r) =>
        `| ${r.runner} | ${WALL.map((k) => fmt(r[k])).join(' | ')} | ${fmt(r.freshCpu)} | ${fmt(r.warmNoRestoreCpu)} |`,
    ),
  ]
  return `# Benchmark results — vx vs Turborepo vs Nx vs Vite Task

<!-- Generated by \`bun private/vx-bench/compare.ts\`. Do not edit by hand. -->

- **Workspace:** ${PROJECTS.length.toLocaleString('en-US')} projects, ${TASKS.toLocaleString('en-US')} tasks: ${LEVELS - 1} levels × ${PER_LEVEL} libs and ${APPS} apps, ${TERMINALS} terminal libs at level 15, one \`e2e\` on every edge, five core libs ~400 projects each use (private/vx-bench/shape.ts).
- **Tasks:** \`installDeps\` (^build, no command), \`build\`, \`lint\`, \`test\` (after installDeps), \`publish\` (after build), \`typecheck\` (^build). Each sleeps: build ${BUILD_MS} ms, lint ${BUILD_MS / 4} ms, test ${BUILD_MS / 2} ms, publish ${BUILD_MS / 10} ms, typecheck ${BUILD_MS / 2} ms. \`build\` writes dist/index.js from 20 source files and 200 KB of incompressible bytes. Identical commands in every runner.
- **Concurrency:** ${CONCURRENCY} for every runner. **Reps:** cold ${COLD_REPS}, the rest median of ${REPS}.
- **vx:** compiled binary from a \`vx lock\` snapshot, as every run does. Uses \`vxHistory({ file: 'vx-timings.json' })\`, its timings recorded by an earlier, untimed run; cache wipes keep that file.
- **Git:** default config for every runner (\`GIT_CONFIG_GLOBAL=/dev/null\`, \`GIT_CONFIG_NOSYSTEM=1\`); the bench host's own sets \`core.checkstat=minimal\`, under which vx hashes every input from disk.
- **Host:** ${os.type()} ${os.release()} · ${os.cpus().length} cores · ${process.platform}/${process.arch}
- **Date:** ${new Date().toISOString().slice(0, 10)}

## Overhead (measured minus ideal)

${head}
${rule}
${overhead.join('\n')}

## Wall time (warm, restore)

${totals.join('\n')}

**Ideal** is the theoretical best case: cold is the tasks' own durations
list-scheduled critical-path first on ${CONCURRENCY} workers (critical path
${fmt(b.criticalPathMs)}, work ÷ workers ${fmt(b.workBoundMs)}); warm and
restore are 0, so all a runner spends there is overhead.
CPU is user + system of the invocation and the children it waited for; a
daemon that outlives the invocation (Turbo's, Nx's) is not counted.

Reproduce: \`bun private/vx-bench/compare.ts ${REPS}\`.
`
}

// ---- main ----

const ALL = ['vx', 'turbo', 'nx', 'vite-task']
const only = (process.env['RUNNERS'] ?? ALL.join(','))
  .split(',')
  .map((n) => n.trim())
  .filter(Boolean)
const unknown = only.filter((n) => !ALL.includes(n))
if (unknown.length > 0) throw new Error(`RUNNERS: no runner ${unknown.join(', ')}`)

const ws = await mkdtemp(path.join(os.tmpdir(), 'vx-compare-'))
try {
  console.error(`scaffolding ${PROJECTS.length} projects, ${TASKS} tasks in ${ws} …`)
  await generate(ws, CONCURRENCY)
  await linkRivals(ws)
  const runners = await buildRunners(ws, (name) => only.includes(name))
  const missing = only.filter((n) => !runners.some((r) => r.name === n))
  if (missing.length > 0) throw new Error(`${missing.join(', ')}: --version failed`)
  gitInit(ws)
  console.error(`runners: ${runners.map((r) => `${r.name}@${r.version}`).join(', ')}`)

  const rows: Row[] = []
  for (const r of runners) {
    await quiesce(ws)
    console.error(`measuring ${r.name} …`)
    rows.push(await measure(r, ws))
  }
  rows.sort((a, b) => ALL.indexOf(a.runner) - ALL.indexOf(b.runner))
  console.error('measuring the baseline (ideal schedule, task CPU) …')
  const baseline = await measureBaseline(ws)
  const cpu = os.cpus()
  await mkdir(path.dirname(OUT), { recursive: true })
  await writeFile(
    OUT,
    JSON.stringify(
      {
        shape: 'levels-2026-10',
        levels: LEVELS,
        perLevel: PER_LEVEL,
        terminals: TERMINALS,
        packages: PROJECTS.length,
        tasks: TASKS,
        buildMs: BUILD_MS,
        concurrency: CONCURRENCY,
        reps: REPS,
        coldReps: COLD_REPS,
        date: new Date().toISOString(),
        machine: {
          os: `${os.platform()} ${os.arch()}`,
          cores: cpu.length,
          cpu: cpu[0]?.model.trim() ?? 'unknown',
          memoryGb: Math.round(os.totalmem() / 2 ** 30),
        },
        rows,
        baseline,
      },
      null,
      2,
    ) + '\n',
  )
  console.error('\n' + markdown(rows, baseline))
} finally {
  await rm(ws, { recursive: true, force: true })
}
