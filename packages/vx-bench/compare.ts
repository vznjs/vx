#!/usr/bin/env bun
/**
 * Head-to-head benchmark: vx vs Turborepo vs Nx vs Vite Task (`vp run`,
 * from vite-plus) on ONE shared synthetic monorepo, every runner
 * configured identically. Writes packages/vx-bench/RESULTS.md and
 * results.json, which the site is generated from (update-site.ts).
 *
 *   bun packages/vx-bench/compare.ts [reps=3]
 *   CONCURRENCY=10 COLD_REPS=1 RUNNERS=vx,turbo bun packages/vx-bench/compare.ts
 *
 * The workspace is shape.ts (owner's spec, 2026-10-09): 29 levels of 50
 * libs and 100 apps, 50 terminal libs at level 15, one `e2e`
 * project on every edge, cross-level edges and five core libs most
 * projects use. Tasks: `installDeps` (no command, ^build), `build`, `lint`
 * and `test` (installDeps), `publish` (build), `typecheck` (^build). Every
 * task sleeps (build BENCH_BUILD_MS, lint ¼, test ½, publish ⅒, typecheck ½);
 * `build` also writes 200 KB of seeded incompressible bytes and concatenates the project's
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
 * snapshot (`--frozen`); `vx (no lock)` evaluates every config per run.
 */
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { summarize } from './ab.js'
import { benchEnv } from './bench-env.js'
import { listSchedule } from './ideal.js'
import { deleteDist, missingDist } from './outputs.js'
import { regressions } from './regress.js'
import {
  APPS,
  BUILD_MS,
  DEPENDS_ON,
  LEVELS,
  PER_LEVEL,
  RUN_TASKS,
  SOURCE_FILES,
  TERMINALS,
  command,
  idealOf,
  source,
  workspace,
  type TaskName,
} from './shape.js'

const REPS = Number(process.argv[2] ?? 3)
const COLD_REPS = Number(process.env.COLD_REPS ?? 1)
// Every runner is pinned to the SAME max concurrency so no tool is
// advantaged by a different default (vx defaults to CPU cores, Turbo to
// 10, Nx to 3).
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 10)
const OUT = process.env.OUT ?? import.meta.dir
const vxRoot = path.resolve(import.meta.dir, '..', '..')
const PROJECTS = workspace()
const BUILT = PROJECTS.filter((p) => 'build' in p.tasks).map((p) => `packages/${p.dir}`)
const TASKS = PROJECTS.reduce((n, p) => n + Object.keys(p.tasks).length, 0)

const RUNNER_ENV = benchEnv({
  NO_COLOR: '1',
  CI: '1',
  TURBO_TELEMETRY_DISABLED: '1',
  DO_NOT_TRACK: '1',
  NX_CLOUD: 'false',
})

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

// ---- scaffolding ----

const VP: Record<TaskName, string> = {
  installDeps: 'vp-install',
  build: 'vp-build',
  lint: 'vp-lint',
  test: 'vp-test',
  publish: 'vp-publish',
  typecheck: 'vp-typecheck',
}

async function generate(dir: string): Promise<void> {
  const json = (p: string, obj: unknown) =>
    writeFile(path.join(dir, p), JSON.stringify(obj, null, 2) + '\n')

  await mkdir(path.join(dir, 'packages'), { recursive: true })
  await writeFile(
    path.join(dir, '.gitignore'),
    [
      'node_modules',
      'dist',
      '.vx',
      '.turbo',
      '.nx',
      '.vx-runner',
      '*.tsbuildinfo',
      'vx-timings.json',
    ].join('\n') + '\n',
  )
  await json('package.json', {
    name: 'bench-root',
    version: '0.0.0',
    private: true,
    packageManager: 'bun@1.4.2',
    workspaces: ['packages/*'],
  })
  await writeFile(path.join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
  // vx as a user tunes it for CI (owner, 2026-10-09: "config is part of
  // the experience"): the history plugin orders by the critical path a
  // timings file from an earlier run recorded. The file sits outside .vx,
  // so a cache wipe keeps it, as CI caches it between runners.
  const history = path.join(vxRoot, 'packages', 'vx-schedule-history', 'src', 'index.ts')
  await writeFile(
    path.join(dir, 'vx.workspace.mjs'),
    `import { scheduleHistoryPlugin } from ${JSON.stringify(history)}\n` +
      `export default { plugins: [scheduleHistoryPlugin({ file: 'vx-timings.json' })] }\n`,
  )
  const turboTask = (t: TaskName) => ({
    dependsOn: [...DEPENDS_ON[t]],
    inputs: t === 'installDeps' ? [] : ['src/**'],
    outputs: t === 'build' ? ['dist/**'] : [],
  })
  await json('turbo.json', {
    $schema: 'https://turborepo.com/schema.json',
    tasks: Object.fromEntries(
      (Object.keys(DEPENDS_ON) as TaskName[]).map((t) => [t, turboTask(t)]),
    ),
  })
  await json('nx.json', {
    $schema: './node_modules/nx/schemas/nx-schema.json',
    parallel: CONCURRENCY,
    // `src` with `^src`: Nx does not fold a dependency's change into a
    // task's hash on its own, so an edit reaches the dependents only through
    // the `^` input (vx and Turborepo fold upstream keys).
    namedInputs: {
      default: ['{projectRoot}/**/*'],
      production: ['default'],
      src: ['{projectRoot}/src/**'],
    },
    analytics: false,
  })

  for (const p of PROJECTS) {
    const rel = path.join('packages', p.dir)
    const abs = path.join(dir, rel)
    await mkdir(path.join(abs, 'src'), { recursive: true })
    const tasks = Object.keys(p.tasks) as TaskName[]
    const run = tasks.filter((t) => t !== 'installDeps')
    const cmd = (t: TaskName) => command(p, t)
    await json(path.join(rel, 'package.json'), {
      name: p.name,
      version: '0.0.0',
      private: true,
      main: 'dist/index.js',
      scripts: Object.fromEntries(run.map((t) => [t, cmd(t)])),
      dependencies: Object.fromEntries(p.deps.map((d) => [d, 'workspace:*'])),
    })
    // Nx: `nx:run-commands`, the command vx runs, from Nx's own process
    // (`nx:run-script` forks a Node per task, item 735). installDeps is a
    // cached `nx:noop`: an uncached one held the warm run at 16.6 s
    // against 5.9 s cached.
    await json(path.join(rel, 'project.json'), {
      name: p.name,
      $schema: '../../node_modules/nx/schemas/project-schema.json',
      sourceRoot: `${rel}/src`,
      projectType: p.kind === 'app' ? 'application' : 'library',
      targets: Object.fromEntries(
        tasks.map((t) => [
          t,
          t === 'installDeps'
            ? { executor: 'nx:noop', dependsOn: ['^build'], inputs: [], outputs: [], cache: true }
            : {
                executor: 'nx:run-commands',
                options: { command: cmd(t), cwd: '{projectRoot}' },
                dependsOn: [...DEPENDS_ON[t]],
                inputs: ['src', '^src'],
                outputs: t === 'build' ? ['{projectRoot}/dist'] : [],
                cache: true,
              },
        ]),
      ),
    })
    // Vite Task: no command-less task with a dependency of its own, so
    // `installDeps`'s ^build moves onto the tasks that wait for it. Task
    // names cannot repeat a package.json script, and `vp run` takes one
    // task, so `vp-all` (no command) gathers the rest.
    const fromDeps = { task: VP.build, from: 'dependencies' }
    // Vite Task keys a task on its inputs alone, so they name the direct
    // dependencies' outputs: each build output folds its dependencies' in,
    // so an edit reaches every dependent.
    const vpInput = [
      'src/**',
      ...p.deps.map((d) => ({
        pattern: `packages/${d.slice('@bench/'.length)}/dist/index.js`,
        base: 'workspace',
      })),
    ]
    const vpDeps = (t: TaskName): unknown[] =>
      DEPENDS_ON[t].map((s): unknown =>
        s === '^build' || s === 'installDeps' ? fromDeps : VP[s as TaskName],
      )
    await writeFile(
      path.join(abs, 'vite.config.ts'),
      `export default ${JSON.stringify(
        {
          run: {
            tasks: {
              ...Object.fromEntries(
                run.map((t) => [
                  VP[t],
                  {
                    command: cmd(t),
                    dependsOn: vpDeps(t),
                    cache: { input: vpInput, output: t === 'build' ? ['dist/**'] : [] },
                  },
                ]),
              ),
              'vp-all': { command: [], dependsOn: run.map((t) => VP[t]) },
            },
          },
        },
        null,
        2,
      )}\n`,
    )
    const vxTask = (t: TaskName): string =>
      t === 'installDeps'
        ? `    installDeps: { dependsOn: ['^build'] },`
        : `    ${t}: {
      exec: { command: ${JSON.stringify(cmd(t))} },
      dependsOn: ${JSON.stringify(DEPENDS_ON[t])},
      cache: { inputs: { files: ['src/**'] }, outputs: { files: ${t === 'build' ? "['dist/**']" : '[]'} } },
    },`
    await writeFile(
      path.join(abs, 'vx.config.ts'),
      `export default {\n  tasks: {\n${tasks.map(vxTask).join('\n')}\n  },\n}\n`,
    )
    for (let n = 0; n < SOURCE_FILES; n++)
      await writeFile(path.join(abs, 'src', `f${String(n).padStart(2, '0')}.js`), source(p.name, n))
  }
}

// git is required by vx (input hashing). Commit AFTER install so the
// lockfile is tracked and the tree is clean — the realistic scenario, and
// the one where vx's git-OID hashing does zero file reads.
async function gitInit(dir: string): Promise<void> {
  await sh(['git', 'init', '-q'], dir)
  await sh(['git', 'add', '-A'], dir)
  await sh(
    [
      'git',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'user.email=b@b.b',
      '-c',
      'user.name=b',
      'commit',
      '-qm',
      'init',
    ],
    dir,
  )
}

// ---- runners ----

interface Runner {
  name: string
  version: string
  run: string[]
  clear: () => Promise<void>
}

let seedVx = async (): Promise<void> => {}

async function buildRunners(dir: string): Promise<Runner[]> {
  const runners: Runner[] = []

  // vx — compile the standalone binary (the artifact real users install via
  // npm / release.yml). Comparing TS-source startup against Turbo's
  // and Nx's precompiled binaries would handicap vx unfairly.
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
      path.join(vxRoot, 'packages', 'vx', 'src', 'bin.ts'),
      '--outfile',
      vxBin,
    ],
    vxRoot,
  )
  // Bun 1.4.0's compiled binary carries a signature this macOS rejects
  // (SIGKILL on launch, exit 137 — see docs/benchmarks.md); an ad-hoc
  // re-sign repairs it, exactly as release.yml does. Fall back to the source
  // tree only when the binary still cannot answer `--version`.
  if (compiled.ok && process.platform === 'darwin')
    await sh(['codesign', '-s', '-', '--force', vxBin], dir)
  const binWorks = compiled.ok && (await sh([vxBin, '--version'], dir)).ok
  if (compiled.ok && !binWorks)
    console.error('  compiled vx binary does not launch; measuring from source')
  const vxRun = binWorks
    ? [vxBin]
    : [process.execPath, path.join(vxRoot, 'packages', 'vx', 'src', 'bin.ts')]
  // A source build reports 0.0.0; the commit says which vx ran (owner,
  // 2026-10-09: every bench table names its versions).
  const rev = await sh(['git', 'rev-parse', '--short=9', 'HEAD'], vxRoot)
  const vxCommit = rev.ok ? rev.out.trim() : ''
  const vxVer = `${(await sh([...vxRun, '--version'], dir)).out.trim() || 'workspace'}${vxCommit ? ` @ ${vxCommit}` : ''}`
  const conc = ['--concurrency', String(CONCURRENCY)]
  const clearVx = () => rm(path.join(dir, '.vx'), { recursive: true, force: true })
  const suffix = compiled.ok ? '' : ' (ts-source)'
  // The headline vx row runs from a lock taken once here, before any rep:
  // the CI fast path, no config evaluation per run. A failed lock is a bug
  // to see, never a silent fall back to the unfrozen row.
  const locked = await sh([...vxRun, 'lock'], dir)
  if (!locked.ok) throw new Error(`vx lock failed:\n${locked.out}`)
  // One untimed run, once git is in place, writes the timings file every
  // timed rep reads.
  seedVx = async () => {
    const seeded = await sh([...vxRun, 'run', ...RUN_TASKS, '--all', ...conc, '--frozen'], dir)
    if (!seeded.ok) throw new Error(`vx seed run failed:\n${seeded.out}`)
    await clearVx()
    await deleteDist(dir)
  }
  runners.push({
    name: `vx${suffix}`,
    version: vxVer,
    run: [...vxRun, 'run', ...RUN_TASKS, '--all', ...conc, '--frozen'],
    clear: clearVx,
  })
  runners.push({
    name: `vx (no lock)${suffix}`,
    version: vxVer,
    run: [...vxRun, 'run', ...RUN_TASKS, '--all', ...conc],
    clear: clearVx,
  })

  // turbo + nx + vite-plus — installed into the generated workspace.
  const bin = (t: string) => path.join(dir, 'node_modules', '.bin', t)
  const turboV = await sh([bin('turbo'), '--version'], dir)
  if (turboV.ok) {
    runners.push({
      name: 'turbo',
      version: turboV.out.trim(),
      run: [bin('turbo'), 'run', ...RUN_TASKS, `--concurrency=${CONCURRENCY}`],
      clear: async () => {
        await sh([bin('turbo'), 'daemon', 'stop'], dir)
        await rm(path.join(dir, '.turbo'), { recursive: true, force: true })
        await rm(path.join(dir, 'node_modules', '.cache', 'turbo'), {
          recursive: true,
          force: true,
        })
      },
    })
  }
  const nxV = await sh([bin('nx'), '--version'], dir)
  if (nxV.ok) {
    runners.push({
      name: 'nx',
      version: (nxV.out.match(/Local:\s*v?([\d.]+)/)?.[1] ?? nxV.out.trim()).slice(0, 12),
      run: [bin('nx'), 'run-many', '-t', ...RUN_TASKS, `--parallel=${CONCURRENCY}`],
      clear: () => sh([bin('nx'), 'reset'], dir).then(() => undefined),
    })
  }
  const vpV = await sh([bin('vp'), '--version'], dir)
  if (vpV.ok) {
    runners.push({
      name: 'vite-task',
      version: vpV.out.match(/\d+\.\d+\.\d+/)?.[0] ?? vpV.out.trim(),
      // Flags before the task name: after it they are the task's arguments,
      // and the run fell back to the default limit of 4.
      run: [bin('vp'), 'run', '-r', '--concurrency-limit', String(CONCURRENCY), 'vp-all'],
      clear: () =>
        rm(path.join(dir, 'node_modules', '.vite', 'task-cache'), { recursive: true, force: true }),
    })
  }
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
// Cold: the tasks' own durations list-scheduled (critical path first) on
// CONCURRENCY workers along the exact graph. Warm: ONE
// `git status --porcelain -uall` walk, the floor of asking what changed.
// Restore: that walk plus a raw copy of every output file. CPU: the
// tasks' own commands with the sleeps taken out, under `xargs -P`.
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
  const status = ['git', 'status', '--porcelain', '-z', '-uall']
  const walks: Array<{ ms: number; cpuMs: number }> = []
  for (let i = 0; i < 5; i++) walks.push(await sh(status, dir))
  const walk = walks.sort((a, b) => a.ms - b.ms)[0]!
  // Every output, copied back from a pristine snapshot, best of 3.
  const snapshot = path.join(dir, '.baseline-outputs')
  await rm(snapshot, { recursive: true, force: true })
  for (const b of BUILT)
    await cp(path.join(dir, b, 'dist'), path.join(snapshot, b), { recursive: true })
  const copies: number[] = []
  for (let i = 0; i < 3; i++) {
    await deleteDist(dir)
    const t0 = Bun.nanoseconds()
    await Promise.all(
      BUILT.map((b) => cp(path.join(snapshot, b), path.join(dir, b, 'dist'), { recursive: true })),
    )
    copies.push((Bun.nanoseconds() - t0) / 1e6)
  }
  await rm(snapshot, { recursive: true, force: true })
  const cmds: string[] = []
  for (const p of PROJECTS)
    for (const t of RUN_TASKS) {
      if (!(t in p.tasks)) continue
      const bare = command(p, t).replace(/^sleep [\d.]+( && )?/, '') || 'true'
      cmds.push(`cd ${path.join(dir, 'packages', p.dir)} && ${bare}`)
    }
  const list = path.join(dir, '.baseline-cmds.txt')
  await writeFile(list, cmds.join('\n') + '\n')
  const xargsCpu: number[] = []
  for (let i = 0; i < 2; i++) {
    const xargs = await sh(['sh', '-c', `xargs -P ${CONCURRENCY} -I{} sh -c '{}' < ${list}`], dir)
    if (!xargs.ok) throw new Error(`baseline xargs failed:\n${xargs.out.slice(-500)}`)
    xargsCpu.push(xargs.cpuMs)
  }
  await rm(list, { force: true })
  return {
    fresh: all.makespan,
    warmNoRestore: walk.ms,
    warmRestore: walk.ms + Math.min(...copies),
    freshCpu: Math.min(...xargsCpu) + walk.cpuMs,
    warmNoRestoreCpu: walk.cpuMs,
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
  // No cold totals (owner, 2026-10-09 17:54): cold shows only as overhead.
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

<!-- Generated by \`bun packages/vx-bench/compare.ts\`. Do not edit by hand. -->

- **Workspace:** ${PROJECTS.length.toLocaleString('en-US')} projects, ${TASKS.toLocaleString('en-US')} tasks: ${LEVELS - 1} levels × ${PER_LEVEL} libs and ${APPS} apps, ${TERMINALS} terminal libs at level 15, one \`e2e\` on every edge, five core libs ~400 projects each use (packages/vx-bench/shape.ts).
- **Tasks:** \`installDeps\` (^build, no command), \`build\`, \`lint\`, \`test\` (after installDeps), \`publish\` (after build), \`typecheck\` (^build). Each sleeps: build ${BUILD_MS} ms, lint ${BUILD_MS / 4} ms, test ${BUILD_MS / 2} ms, publish ${BUILD_MS / 10} ms, typecheck ${BUILD_MS / 2} ms. \`build\` writes dist/index.js from 20 source files and 200 KB of seeded incompressible bytes. Identical commands in every runner.
- **Concurrency:** ${CONCURRENCY} for every runner. **Reps:** cold ${COLD_REPS}, the rest median of ${REPS}.
- **vx:** compiled binary from a \`vx lock\` snapshot (\`--frozen\`); \`vx (no lock)\` evaluates every config per run. Both use \`scheduleHistoryPlugin({ file: 'vx-timings.json' })\`, its timings recorded by an earlier, untimed run; cache wipes keep that file.
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
${fmt(b.criticalPathMs)}, work ÷ workers ${fmt(b.workBoundMs)}); warm is one
\`git status -uall\` walk, the floor of asking what changed; restore adds a raw
copy of every output.
CPU is user + system of the invocation and the children it waited for; a
daemon that outlives the invocation (Turbo's, Nx's) is not counted.

Reproduce: \`bun packages/vx-bench/compare.ts ${REPS}\`.
`
}

// ---- main ----

const committed = (await Bun.file(path.join(import.meta.dir, 'results.json')).json()) as {
  shape?: string
  concurrency: number
  rows: Row[]
}
const sameShape = committed.shape === 'levels-2026-10' && committed.concurrency === CONCURRENCY

const ws = await mkdtemp(path.join(os.tmpdir(), 'vx-compare-'))
console.error(`scaffolding ${PROJECTS.length} projects, ${TASKS} tasks in ${ws} …`)
await generate(ws)
console.error('installing turbo + nx + vite-plus into the workspace …')
const install = await sh(['bun', 'add', '-d', 'turbo', 'nx', 'vite-plus', '--no-save'], ws).catch(
  () => null,
)
if (!install || !install.ok) await sh(['bun', 'add', '-d', 'turbo', 'nx', 'vite-plus'], ws)
let runners = await buildRunners(ws)
let rows: Row[] = []
const only = process.env['RUNNERS']
  ?.split(',')
  .map((n) => n.trim())
  .filter(Boolean)
if (only && only.length > 0) {
  runners = runners.filter((r) => only.includes(r.name))
  if (sameShape) rows = committed.rows.filter((r) => !only.includes(r.runner))
}
await gitInit(ws)
if (runners.some((r) => r.name.startsWith('vx'))) await seedVx()
console.error(`runners: ${runners.map((r) => `${r.name}@${r.version}`).join(', ')}`)

for (const r of runners) {
  await quiesce(ws)
  console.error(`measuring ${r.name} …`)
  try {
    rows.push(await measure(r, ws))
  } catch (err) {
    const lines = (err as Error).message.split('\n').filter((l) => l.trim() !== '')
    console.error(`  ${r.name} skipped: ${lines[0]} ${lines[1] ?? ''}`)
    rows.push({
      runner: r.name,
      version: r.version,
      fresh: NaN,
      warmNoRestore: NaN,
      warmRestore: NaN,
      freshCpu: NaN,
      warmNoRestoreCpu: NaN,
      warmRestoreCpu: NaN,
    })
  }
}

const ORDER = ['vx', 'vx (no lock)', 'turbo', 'nx', 'vite-task']
rows.sort((a, b) => ORDER.indexOf(a.runner) - ORDER.indexOf(b.runner))
console.error('measuring the baseline (ideal schedule, one git walk, a raw copy) …')
const baseline = await measureBaseline(ws)
const md = markdown(rows, baseline)
await writeFile(path.join(OUT, 'RESULTS.md'), md)
await writeFile(
  path.join(OUT, 'results.json'),
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
      machine: `${os.platform()} ${os.arch()}, ${os.cpus().length} cores`,
      rows,
      baseline,
    },
    null,
    2,
  ) + '\n',
)
console.error('\n' + md)
if (sameShape) {
  const measured = new Set(runners.map((r) => r.name))
  const slower = regressions(
    committed.rows,
    rows.filter((r) => measured.has(r.runner)),
  )
  console.error(
    slower.length === 0
      ? 'no timing more than 10% slower than the committed run'
      : `slower than the committed run by more than 10%:\n  ${slower.join('\n  ')}`,
  )
}
await rm(ws, { recursive: true, force: true })
