// The per-PR bench against every rival and the base commit's vx
// (2026-10-12): fails when this checkout's vx loses ground to any of them.
//
//   bun pr-bench.ts
//
// Both workspaces are the site's own (site-workspace.ts), every runner
// configured as the site configures it, with the tasks' sleeps at
// BENCH_BUILD_MS (check.perf sets 0). Restore and nothing-changed run on the
// whole of it (1,601 packages, 9,603 tasks): on a 100-package workspace a
// per-task cost the site pays 9,603 times read as noise, and #4892 added
// 17-35 ms to every site run and passed. Cold runs on its first two levels
// (100 packages): the site's cold runs its tasks for two minutes.
//
// Every tool runs in its own copy. vx, the base and Turbo run in
// interleaved pairs, min of each over the quietest pairs (quiet.ts); Nx and
// Vite Task, many times slower outside cold, run once per case, three times
// when within reach of vx. A held case fails when vx is slower than any
// rival or uses more CPU than one CPU_HELD names, or when vx is slower than
// the base's vx in more of its quiet pairs than chance explains (a sign
// test, pr-bench-base.ts): no slack for a regression to land a slice at a
// time.
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  baseFails,
  type BasePair,
  type Best,
  buildBase,
  HELD,
  rivalFails,
  RIVALS,
  SITE_ARMS,
  undecided,
  type Arm,
  type Rival,
} from './pr-bench-base.js'
import { deleteDist } from './outputs.js'
import { enoughQuiet, machineBusyMs, type Pair, quietest, tracerCpuMs } from './quiet.js'
import { RUN_TASKS, workspace } from './shape.js'
import { generate, gitInit, linkRivals, RUNNER_ENV, rivalRuns } from './site-workspace.js'
import { copyWorkspace, outputMtimes } from './workspace-copy.js'

/** The pairs of each held arm its figures come from: the quietest. */
const REPS = 7
/** Pairs an arm runs at most, waiting for REPS quiet ones or the base's verdict. */
const MAX_REPS = 40
/** A pair is quiet when other processes kept at most this many cores busy beside it. */
const QUIET_CORES = 0.5
const CONCURRENCY = 10
/** The cold workspace: the site's levels up to this one, which name only each other. */
const COLD_LEVELS = 2
/** Nx or Vite Task within this factor of vx's best runs twice more. */
const REACH = 1.25
/** The commit this checkout is held to (CI: the PR's base, or main before the push); unset times no base. */
const BASE = process.env.VX_BENCH_BASE || undefined

type Tool = 'vx' | 'base' | Rival
/** A pair as quiet.ts judges it, with each tool's CPU. */
type CpuPair = Pair & { cpu: Partial<Record<Tool, number>> }

/** CPU ms every child this process spawned used: with its own and its tracer's, a pair's neighbours are what is left. */
let childCpuMs = 0
function sh(cmd: string[], cwd: string): { ok: boolean; out: string; cpuMs: number } {
  const r = Bun.spawnSync(cmd, { cwd, env: RUNNER_ENV, stdout: 'pipe', stderr: 'pipe' })
  const cpuMs = r.resourceUsage === undefined ? 0 : Number(r.resourceUsage.cpuTime.total) / 1000
  childCpuMs += cpuMs
  return { ok: r.exitCode === 0, out: r.stdout.toString() + r.stderr.toString(), cpuMs }
}
const ownCpuMs = (): number => {
  const u = process.cpuUsage()
  return (u.user + u.system) / 1000 + childCpuMs + tracerCpuMs()
}
function must(cmd: string[], cwd: string): { out: string; cpuMs: number } {
  const r = sh(cmd, cwd)
  if (!r.ok) throw new Error(`${cmd.join(' ')} failed:\n${r.out.slice(-2000)}`)
  return r
}

/** One workspace the bench times, each tool in its own copy. */
interface Bench {
  dirs: Record<Tool, string>
  runs: Record<Tool, string[]>
  clear: (tool: Tool) => Promise<void>
}

const scratch: string[] = []

/**
 * The site's workspace over `projects`, locked by vx before its commit (as
 * the site does), then copied once per tool: Turbo rewrites every output on
 * a warm hit, so in one shared tree vx's next noop restored all of them.
 * The base locks its own copy: a run's memo is named by the code that wrote it.
 */
async function bench(
  name: string,
  projects: ReturnType<typeof workspace>,
  vx: string,
  baseVx: string | undefined,
): Promise<Bench> {
  const ws = await mkdtemp(path.join(os.tmpdir(), `vx-prbench-${name}-`))
  scratch.push(ws)
  await generate(ws, CONCURRENCY, projects)
  await linkRivals(ws)
  must([vx, 'lock'], ws)
  gitInit(ws)
  const tools: Tool[] = baseVx === undefined ? ['vx', ...RIVALS] : ['vx', 'base', ...RIVALS]
  const dirs = {} as Record<Tool, string>
  for (const tool of tools) {
    dirs[tool] = `${ws}-${tool}`
    scratch.push(dirs[tool])
    copyWorkspace(ws, dirs[tool])
  }
  if (baseVx !== undefined) must([baseVx, 'lock'], dirs.base)
  const vxRun = ['run', ...RUN_TASKS, '--all', '--concurrency', String(CONCURRENCY)]
  const runs = { vx: [vx, ...vxRun], base: [baseVx ?? '', ...vxRun] } as Record<Tool, string[]>
  for (const rival of RIVALS) runs[rival] = rivalRuns(dirs[rival], CONCURRENCY)[rival].run
  return {
    dirs,
    runs,
    clear: async (tool) => {
      if (tool === 'vx' || tool === 'base') {
        // `.vx/cache`, not `.vx`: the workspace config lives there.
        await rm(path.join(dirs[tool], '.vx', 'cache'), { recursive: true, force: true })
        return
      }
      const { command, paths } = rivalRuns(dirs[tool], CONCURRENCY)[tool].clear
      if (command !== undefined) sh(command, dirs[tool])
      for (const p of paths) await rm(path.join(dirs[tool], p), { recursive: true, force: true })
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
  const all = workspace()
  const small = await bench(
    'cold',
    all.filter((p) => p.level <= COLD_LEVELS && p.kind !== 'e2e'),
    vx,
    baseVx,
  )
  const site = await bench('site', all, vx, baseVx)
  const benchOf = (arm: Arm): Bench => (SITE_ARMS.includes(arm) ? site : small)
  const paired: readonly Tool[] = BASE === undefined ? ['vx', 'turbo'] : ['vx', 'base', 'turbo']

  const time = async (tool: Tool, arm: Arm): Promise<Best> => {
    const b = benchOf(arm)
    if (arm === 'cold') await b.clear(tool)
    if (arm !== 'noop') await deleteDist(b.dirs[tool])
    const before =
      (tool === 'vx' || tool === 'base') && arm === 'noop'
        ? JSON.stringify(outputMtimes(b.dirs[tool]))
        : ''
    const t0 = Bun.nanoseconds()
    const { cpuMs } = must(b.runs[tool], b.dirs[tool])
    const ms = (Bun.nanoseconds() - t0) / 1e6
    // A noop that rewrote an output timed a restore, not a noop.
    if (before !== '' && JSON.stringify(outputMtimes(b.dirs[tool])) !== before)
      throw new Error(`${tool} noop rewrote outputs: the arm timed a restore`)
    return { ms, cpuMs }
  }
  // vx and the base, in turn first, then Turbo, back to back, and the cores
  // other processes kept busy over them: the machine's busy time less this
  // process's and its children's. In turn: with vx always first, right
  // behind the last pair's Turbo, a CI-only change read noop 1.24× its own
  // base (#4885).
  const pair = async (arm: Arm, rep: number): Promise<CpuPair> => {
    const busy0 = machineBusyMs()
    const own0 = ownCpuMs()
    const t0 = Bun.nanoseconds()
    const baseFirst = BASE !== undefined && rep % 2 === 1
    const early = baseFirst ? await time('base', arm) : undefined
    const v = await time('vx', arm)
    const base = BASE === undefined ? undefined : (early ?? (await time('base', arm)))
    const turbo = await time('turbo', arm)
    const busy1 = machineBusyMs()
    const wall = (Bun.nanoseconds() - t0) / 1e6
    const others =
      busy0 === undefined || busy1 === undefined
        ? 0
        : Math.max(0, busy1 - busy0 - (ownCpuMs() - own0)) / wall
    return {
      vx: v.ms,
      turbo: turbo.ms,
      others,
      cpu: { vx: v.cpuMs, turbo: turbo.cpuMs, ...(base === undefined ? {} : { base: base.cpuMs }) },
      ...(base === undefined ? {} : { base: base.ms }),
    }
  }
  // Fill each tool's caches once: the cold workspace's first cold rep does it there.
  for (const tool of [...paired, 'nx', 'vite-task'] as const) {
    await time(tool, 'cold')
    must(site.runs[tool], site.dirs[tool])
  }
  // Each arm reps until REPS of its pairs ran quiet, and on while its quiet
  // pairs lean slower than the base without proving it (MAX_REPS at most).
  const pairs = new Map<Arm, CpuPair[]>(HELD.map((a) => [a, []]))
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
  const best = new Map<Arm, { vx: Best; base?: Best } & Partial<Record<Rival, Best>>>()
  for (const arm of HELD) {
    const ran = pairs.get(arm)!
    const kept = quietest(ran, REPS) as CpuPair[]
    const min = (xs: number[]) => Math.min(...xs)
    const of = (tool: 'vx' | 'base' | 'turbo'): Best => ({
      ms: min(kept.map((p) => p[tool]!)),
      cpuMs: min(kept.map((p) => p.cpu[tool]!)),
    })
    const b: { vx: Best; base?: Best } & Partial<Record<Rival, Best>> = {
      vx: of('vx'),
      turbo: of('turbo'),
      ...(BASE === undefined ? {} : { base: of('base') }),
    }
    for (const rival of ['nx', 'vite-task'] as const) {
      const runs = [await time(rival, arm)]
      const near = (r: Best) => r.ms < b.vx.ms * REACH || r.cpuMs < b.vx.cpuMs * REACH
      if (near(runs[0]!)) runs.push(await time(rival, arm), await time(rival, arm))
      b[rival] = { ms: min(runs.map((r) => r.ms)), cpuMs: min(runs.map((r) => r.cpuMs)) }
    }
    best.set(arm, b)
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

  const tools: readonly Tool[] = BASE === undefined ? ['vx', ...RIVALS] : ['vx', 'base', ...RIVALS]
  console.log(`case      ${tools.map((t) => t.padStart(18)).join('')}   (wall ms / CPU ms)`)
  for (const arm of HELD) {
    const b = best.get(arm)! as Partial<Record<Tool, Best>>
    const cell = (t: Tool) =>
      (b[t] === undefined ? '-' : `${b[t].ms.toFixed(0)} / ${b[t].cpuMs.toFixed(0)}`).padStart(18)
    console.log(`${arm.padEnd(9)} ${tools.map(cell).join('')}`)
  }
  const fails = [
    ...baseFails(Object.fromEntries(HELD.map((arm) => [arm, quietBase(arm)])), HELD),
    ...rivalFails(Object.fromEntries(best), HELD),
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
