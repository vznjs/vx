// The per-PR bench against Turborepo and the base commit's vx (2026-10-12):
// fails when this checkout's vx loses ground to either.
//
//   bun pr-bench.ts
//
// Restore and nothing-changed are timed on the site's own workspace
// (site-workspace.ts: 1,601 packages, 9,603 tasks), with the tasks' sleeps
// at BENCH_BUILD_MS (check.perf sets 0: neither case runs a task). On a
// 100-package workspace a per-task cost the site pays 96 times over read as
// noise: #4892 added 17-35 ms to every site run and passed. Cold stays on a
// small workspace (PROJECTS packages, build → test, cp-sized tasks): the
// site's cold runs its tasks for two minutes.
//
// Every tool runs in its own copy, interleaved reps, min of each over the
// quietest pairs (quiet.ts). A held case fails when vx is slower than Turbo,
// or slower than the base's vx in more of its quiet pairs than chance
// explains (a sign test, pr-bench-base.ts): no slack for a regression to
// land in a slice at a time.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { benchEnv } from './bench-env.js'
import { BENCH_WORKSPACE } from './edges.js'
import {
  baseFails,
  type BasePair,
  buildBase,
  HELD,
  SITE_ARMS,
  turboFails,
  undecided,
  type Arm,
} from './pr-bench-base.js'
import { deleteDist } from './outputs.js'
import { enoughQuiet, machineBusyMs, type Pair, quietest, tracerCpuMs } from './quiet.js'
import { RUN_TASKS } from './shape.js'
import { generate, gitInit, linkRivals } from './site-workspace.js'
import { copyWorkspace, outputMtimes } from './workspace-copy.js'

const PROJECTS = 100
/** The pairs of each held arm its ratio comes from: the quietest. */
const REPS = 7
/** Pairs an arm runs at most, waiting for REPS quiet ones or the base's verdict. */
const MAX_REPS = 40
/** A pair is quiet when other processes kept at most this many cores busy beside it. */
const QUIET_CORES = 0.5
/** The small workspace's concurrency; the site's runs at the site's. */
const CONCURRENCY = 4
const SITE_CONCURRENCY = 10
/** The commit this checkout is held to (CI: the PR's base, or main before the push); unset times no base. */
const BASE = process.env.VX_BENCH_BASE || undefined

type Tool = 'vx' | 'base' | 'turbo'

/** CPU ms every child this process spawned used: with its own and its tracer's, a pair's neighbours are what is left. */
let childCpuMs = 0
function sh(cmd: string[], cwd: string): { ok: boolean; out: string } {
  // Turbo's telemetry writes ~/.config/turborepo, which the task sandbox refuses.
  const env = benchEnv({ TURBO_TELEMETRY_DISABLED: '1', DO_NOT_TRACK: '1' })
  const r = Bun.spawnSync(cmd, { cwd, env, stdout: 'pipe', stderr: 'pipe' })
  if (r.resourceUsage !== undefined) childCpuMs += Number(r.resourceUsage.cpuTime.total) / 1000
  return { ok: r.exitCode === 0, out: r.stdout.toString() + r.stderr.toString() }
}
const ownCpuMs = (): number => {
  const u = process.cpuUsage()
  return (u.user + u.system) / 1000 + childCpuMs + tracerCpuMs()
}
function must(cmd: string[], cwd: string): string {
  const r = sh(cmd, cwd)
  if (!r.ok) throw new Error(`${cmd.join(' ')} failed:\n${r.out.slice(-2000)}`)
  return r.out
}

/** One workspace the bench times, each tool in its own copy. */
interface Bench {
  dirs: Record<Tool, string>
  runs: Record<Tool, string[]>
  /** Leave the tree as the arm starts from. */
  prepare: (tool: Tool, arm: Arm) => Promise<void>
}

const scratch: string[] = []
const temp = async (name: string): Promise<string> => {
  const dir = await mkdtemp(path.join(os.tmpdir(), `vx-prbench-${name}-`))
  scratch.push(dir, `${dir}-vx`, `${dir}-turbo`, `${dir}-base`)
  return dir
}
const turbo = path.join(import.meta.dir, 'node_modules', '.bin', 'turbo')
const git = (args: string[], cwd: string) =>
  must(
    ['git', '-c', 'user.email=b@vx', '-c', 'user.name=b', '-c', 'commit.gpgsign=false', ...args],
    cwd,
  )

/**
 * Lock `ws` with vx and commit it, then copy it once per tool: Turbo
 * rewrites every output on a warm hit, so in one shared tree vx's next
 * noop restored all of them. The base locks its own copy: a run's memo is
 * named by the code that wrote it.
 */
function copies(ws: string, baseVx: string | undefined): Record<Tool, string> {
  const dirs = { vx: `${ws}-vx`, turbo: `${ws}-turbo`, base: `${ws}-base` }
  copyWorkspace(ws, dirs.vx)
  copyWorkspace(ws, dirs.turbo)
  if (baseVx !== undefined) {
    copyWorkspace(ws, dirs.base)
    must([baseVx, 'lock'], dirs.base)
  }
  return dirs
}

async function smallBench(vx: string, baseVx: string | undefined): Promise<Bench> {
  const ws = await temp('small')
  const json = (p: string, v: unknown) => writeFile(path.join(ws, p), JSON.stringify(v) + '\n')
  await writeFile(path.join(ws, '.gitignore'), 'node_modules\ndist\n.vx/cache/\n.turbo\n')
  await json('package.json', {
    name: 'bench-root',
    private: true,
    packageManager: 'bun@1.4.2',
    workspaces: ['packages/*'],
  })
  await Bun.write(path.join(ws, '.vx/workspace.mjs'), BENCH_WORKSPACE)
  await json('turbo.json', {
    tasks: {
      build: { dependsOn: ['^build'], inputs: ['src/**'], outputs: ['dist/**'] },
      test: { dependsOn: ['build'], inputs: ['src/**'], outputs: [] },
    },
  })
  for (let i = 0; i < PROJECTS; i++) {
    const name = `pkg-${i}`
    const deps: Record<string, string> = {}
    for (const j of [i - 1, i - 4, i - 9]) if (j >= 0) deps[`pkg-${j}`] = 'workspace:*'
    const dir = path.join(ws, 'packages', name)
    await mkdir(path.join(dir, 'src'), { recursive: true })
    await writeFile(path.join(dir, 'src', 'index.js'), `export const v = ${i}\n`)
    await json(`packages/${name}/package.json`, {
      name,
      version: '0.0.0',
      dependencies: deps,
      scripts: { build: 'mkdir -p dist && cp src/index.js dist/out.js', test: 'true' },
    })
    await writeFile(
      path.join(dir, 'vx.config.mjs'),
      `export default { tasks: {
  build: { dependsOn: ['^build'], exec: { command: 'mkdir -p dist && cp src/index.js dist/out.js' },
    inputs: { files: ['src/**'] }, cache: { outputs: { files: ['dist/**'] } } },
  test: { dependsOn: ['build'], exec: { command: 'true' },
    inputs: { files: ['src/**'] }, cache: { outputs: { files: [] } } },
} }\n`,
    )
  }
  must(['ln', '-s', path.join(import.meta.dir, 'node_modules'), 'node_modules'], ws)
  git(['init', '-q'], ws)
  git(['add', '-A'], ws)
  git(['commit', '-qm', 'fixture'], ws)
  // Every run reads configs only from the lock.
  must([vx, 'lock'], ws)
  const dirs = copies(ws, baseVx)
  const vxRun = ['run', 'build', 'test', '--all', `--concurrency=${CONCURRENCY}`]
  const wipeOutputs = (cwd: string) =>
    sh(
      [
        'git',
        'clean',
        '-fdXq',
        '-e',
        '!node_modules',
        '-e',
        '!.vx',
        '-e',
        '!.vx/**',
        '-e',
        '!.turbo',
        '-e',
        '!.turbo/**',
      ],
      cwd,
    )
  return {
    dirs,
    runs: {
      vx: [vx, ...vxRun],
      base: [baseVx ?? '', ...vxRun],
      turbo: [turbo, 'run', 'build', 'test', `--concurrency=${CONCURRENCY}`, '--no-daemon'],
    },
    prepare: async (tool, arm) => {
      if (arm === 'cold') {
        // Each tool's own cache only. `.vx/cache`, not `.vx`: the lock lives there.
        const cache = tool === 'turbo' ? ['.turbo', 'node_modules/.cache/turbo'] : ['.vx/cache']
        sh(['rm', '-rf', ...cache], dirs[tool])
      }
      if (arm !== 'noop') wipeOutputs(dirs[tool])
    },
  }
}

/** The site's workspace and run, as compare.ts times it. */
async function siteBench(vx: string, baseVx: string | undefined): Promise<Bench> {
  const ws = await temp('site')
  await generate(ws, SITE_CONCURRENCY)
  await linkRivals(ws)
  // The site locks before its commit, so the lock files are tracked.
  must([vx, 'lock'], ws)
  gitInit(ws)
  const dirs = copies(ws, baseVx)
  const vxRun = ['run', ...RUN_TASKS, '--all', '--concurrency', String(SITE_CONCURRENCY)]
  return {
    dirs,
    runs: {
      vx: [vx, ...vxRun],
      base: [baseVx ?? '', ...vxRun],
      turbo: [turbo, 'run', ...RUN_TASKS, `--concurrency=${SITE_CONCURRENCY}`, '--no-daemon'],
    },
    prepare: async (tool, arm) => {
      if (arm === 'restore') await deleteDist(dirs[tool])
    },
  }
}

const vx = path.join(os.tmpdir(), `vx-prbench-bin-${process.pid}`)
const baseVx = BASE === undefined ? undefined : `${vx}-base`
try {
  const bin = path.join(import.meta.dir, 'node_modules', '@vzn', 'vx', 'src', 'bin.ts')
  must(
    ['bun', 'build', '--compile', '--minify', '--bytecode', bin, '--outfile', vx],
    import.meta.dir,
  )
  if (baseVx !== undefined && BASE !== undefined)
    buildBase(path.resolve(import.meta.dir, '../..'), BASE, baseVx)
  const small = await smallBench(vx, baseVx)
  const site = await siteBench(vx, baseVx)
  const benchOf = (arm: Arm): Bench => (SITE_ARMS.includes(arm) ? site : small)
  const tools: readonly Tool[] = BASE === undefined ? ['vx', 'turbo'] : ['vx', 'base', 'turbo']

  const time = async (tool: Tool, arm: Arm) => {
    const b = benchOf(arm)
    await b.prepare(tool, arm)
    const before =
      tool !== 'turbo' && arm === 'noop' ? JSON.stringify(outputMtimes(b.dirs[tool])) : ''
    const t0 = Bun.nanoseconds()
    must(b.runs[tool], b.dirs[tool])
    const ms = (Bun.nanoseconds() - t0) / 1e6
    // A noop that rewrote an output timed a restore, not a noop.
    if (before !== '' && JSON.stringify(outputMtimes(b.dirs[tool])) !== before)
      throw new Error(`${tool} noop rewrote outputs: the arm timed a restore`)
    return ms
  }
  // vx and the base, in turn first, then Turbo, back to back, and the cores
  // other processes kept busy over them: the machine's busy time less this
  // process's and its children's. In turn: with vx always first, right
  // behind the last pair's Turbo, a CI-only change read noop 1.24× its own
  // base (#4885).
  const pair = async (arm: Arm, rep: number): Promise<Pair> => {
    const busy0 = machineBusyMs()
    const own0 = ownCpuMs()
    const t0 = Bun.nanoseconds()
    const baseFirst = BASE !== undefined && rep % 2 === 1
    const early = baseFirst ? await time('base', arm) : undefined
    const vxMs = await time('vx', arm)
    const base = BASE === undefined ? undefined : (early ?? (await time('base', arm)))
    const turboMs = await time('turbo', arm)
    const busy1 = machineBusyMs()
    const wall = (Bun.nanoseconds() - t0) / 1e6
    const others =
      busy0 === undefined || busy1 === undefined
        ? 0
        : Math.max(0, busy1 - busy0 - (ownCpuMs() - own0)) / wall
    return { vx: vxMs, turbo: turboMs, others, ...(base === undefined ? {} : { base }) }
  }
  // Fill each tool's cache once (the small workspace's cold rep does it there).
  for (const tool of tools) await time(tool, 'cold')
  for (const tool of tools) must(site.runs[tool], site.dirs[tool])
  // Each arm reps until REPS of its pairs ran quiet, and on while its quiet
  // pairs lean slower than the base without proving it (MAX_REPS at most).
  // Its figures are the min of each tool over its REPS quietest pairs; the
  // base is judged by the sign of every quiet pair.
  const pairs = new Map<Arm, Pair[]>(HELD.map((a) => [a, []]))
  const quietBase = (arm: Arm): BasePair[] =>
    pairs
      .get(arm)!
      .filter((p) => p.base !== undefined && p.others <= QUIET_CORES)
      .map((p) => ({ vx: p.vx, base: p.base! }))
  for (let rep = 0; rep < MAX_REPS; rep++) {
    const left = HELD.filter(
      (a) =>
        pairs.get(a)!.length < REPS ||
        !enoughQuiet(pairs.get(a)!, REPS, QUIET_CORES) ||
        (BASE !== undefined && undecided(quietBase(a))),
    )
    if (left.length === 0) break
    for (const arm of left) pairs.get(arm)!.push(await pair(arm, rep))
  }
  const best = new Map<Arm, { vx: number; turbo: number; base?: number }>()
  for (const arm of HELD) {
    const ran = pairs.get(arm)!
    const kept = quietest(ran, REPS)
    best.set(arm, {
      vx: Math.min(...kept.map((p) => p.vx)),
      turbo: Math.min(...kept.map((p) => p.turbo)),
      ...(BASE === undefined ? {} : { base: Math.min(...kept.map((p) => p.base!)) }),
    })
    const others = Math.max(...kept.map((p) => p.others))
    const vsBase = quietBase(arm)
    console.log(
      `${arm}: ${ran.length} pairs, the ${kept.length} quietest with ≤ ${others.toFixed(2)} cores busy beside them` +
        (BASE === undefined
          ? ''
          : `; vx slower than the base in ${vsBase.filter((p) => p.vx > p.base).length} of ${vsBase.length} quiet pairs`),
    )
    if (others > QUIET_CORES)
      console.log(
        `BUSY ${arm}: no ${REPS} pairs ran quiet; held anyway, so a fail may be the neighbours`,
      )
  }

  console.log(`case      vx        base      turbo     vx/turbo  vx/base`)
  const ms = (n: number | undefined) => (n === undefined ? '-' : `${n.toFixed(0)} ms`).padStart(8)
  for (const arm of HELD) {
    const b = best.get(arm)!
    console.log(
      `${arm.padEnd(9)} ${ms(b.vx)}  ${ms(b.base)}  ${ms(b.turbo)}  ${(b.vx / b.turbo).toFixed(3).padStart(8)}  ${b.base === undefined ? '-' : (b.vx / b.base).toFixed(3)}`,
    )
  }
  const fails = [
    ...baseFails(Object.fromEntries(HELD.map((arm) => [arm, quietBase(arm)])), HELD),
    ...turboFails(Object.fromEntries(best), HELD),
  ]
  for (const f of fails) console.log(`FAIL ${f}`)
  process.exitCode = fails.length > 0 ? 1 : 0
} finally {
  if (!process.env.KEEP) {
    for (const dir of scratch) await rm(dir, { recursive: true, force: true })
    await rm(vx, { force: true })
    if (baseVx !== undefined) await rm(baseVx, { force: true })
  } else console.log(scratch.join('\n'))
}
