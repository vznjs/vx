// The per-PR bench against Turborepo (2026-10-12): a run that takes
// seconds and fails when this checkout's vx loses ground to Turbo.
//
//   bun pr-bench.ts            check against pr-bench-baseline.json
//   bun pr-bench.ts --update   record this platform's ratios
//
// One small workspace (PROJECTS packages, build → test, cp-sized tasks),
// both tools at the same concurrency, interleaved reps, min of each. Time
// on a shared runner moves with the box, so what is held is the RATIO
// vx / turbo taken in the same job: a slower box slows both. Restore and
// nothing-changed are the runner's own overhead and are held: a case fails
// when its ratio grew past TOLERANCE over the recorded one. Cold is printed
// from one warm-up run, not held: 200 spawns on 4 cores moved its ratio from 0.71 to 1.12 between
// two CI runs of one commit (2026-10-12). A case vx loses prints LOSS.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { benchEnv } from './bench-env.js'
import { BENCH_WORKSPACE } from './edges.js'
import { baseFails, buildBase } from './pr-bench-base.js'
import { enoughQuiet, machineBusyMs, type Pair, quietest, tracerCpuMs } from './quiet.js'
import { copyWorkspace, outputMtimes } from './workspace-copy.js'

const PROJECTS = 100
/** The pairs of each held arm its ratio comes from: the quietest. */
const REPS = 7
/** Pairs an arm runs at most, waiting for REPS quiet ones. */
const MAX_REPS = 30
/** A pair is quiet when other processes kept at most this many cores busy beside it. */
const QUIET_CORES = 0.5
const CONCURRENCY = 4
/** A ratio past baseline × this fails. */
const TOLERANCE = 1.3
const BASELINE = path.join(import.meta.dir, 'pr-bench-baseline.json')
const update = process.argv.includes('--update')
/** The commit this checkout is held to (CI: the PR's base, or main before the push); unset times no base. */
const BASE = process.env.VX_BENCH_BASE || undefined

const ARMS = ['cold', 'restore', 'noop'] as const
const HELD: readonly Arm[] = ['restore', 'noop']
type Arm = (typeof ARMS)[number]
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

const ws = await mkdtemp(path.join(os.tmpdir(), 'vx-prbench-'))
try {
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
  const turbo = path.join(import.meta.dir, 'node_modules', '.bin', 'turbo')
  must(['ln', '-s', path.join(import.meta.dir, 'node_modules'), 'node_modules'], ws)
  for (const args of [
    ['init', '-q'],
    ['add', '-A'],
    ['commit', '-qm', 'fixture'],
  ]) {
    must(
      ['git', '-c', 'user.email=b@vx', '-c', 'user.name=b', '-c', 'commit.gpgsign=false', ...args],
      ws,
    )
  }
  const vx = path.join(ws, '.vx-bin')
  const bin = path.join(import.meta.dir, 'node_modules', '@vzn', 'vx', 'src', 'bin.ts')
  must(['bun', 'build', '--compile', '--minify', '--bytecode', bin, '--outfile', vx], ws)
  // Every run reads configs only from the lock.
  must([vx, 'lock'], ws)
  // Turbo times its own copy: it rewrites every output on a warm hit, and in
  // one shared tree vx's next noop restored all of them.
  const turboWs = `${ws}-turbo`
  copyWorkspace(ws, turboWs)
  // The base times its own copy, locked by itself: a run's memo is named by
  // the code that wrote it, so one tree shared by two builds missed on each.
  const baseWs = `${ws}-base`
  const baseVx = path.join(baseWs, '.vx-base')
  if (BASE !== undefined) {
    copyWorkspace(ws, baseWs)
    buildBase(path.resolve(import.meta.dir, '../..'), BASE, baseVx)
    must([baseVx, 'lock'], baseWs)
  }
  const dirs = { vx: ws, base: baseWs, turbo: turboWs }
  const tools: readonly Tool[] = BASE === undefined ? ['vx', 'turbo'] : ['vx', 'base', 'turbo']

  const vxRun = ['run', 'build', 'test', '--all', `--concurrency=${CONCURRENCY}`]
  const runs: Record<Tool, string[]> = {
    vx: [vx, ...vxRun],
    base: [baseVx, ...vxRun],
    turbo: [turbo, 'run', 'build', 'test', `--concurrency=${CONCURRENCY}`, '--no-daemon'],
  }
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
        '-e',
        '!.vx-bin',
        '-e',
        '!.vx-base',
      ],
      cwd,
    )
  // Each tool's own cache only: Turbo's cold rep must not empty vx's before vx's restore rep.
  // `.vx/cache`, not `.vx`: the lock lives there.
  const wipeCache = (tool: Tool) => {
    sh(
      [
        'rm',
        '-rf',
        ...(tool === 'turbo' ? ['.turbo', 'node_modules/.cache/turbo'] : ['.vx/cache']),
      ],
      dirs[tool],
    )
  }
  const best = new Map<string, number>()
  const time = (tool: Tool, arm: Arm) => {
    if (arm === 'cold') {
      wipeCache(tool)
      wipeOutputs(dirs[tool])
    } else if (arm === 'restore') wipeOutputs(dirs[tool])
    const before =
      tool !== 'turbo' && arm === 'noop' ? JSON.stringify(outputMtimes(dirs[tool])) : ''
    const t0 = Bun.nanoseconds()
    must(runs[tool], dirs[tool])
    const ms = (Bun.nanoseconds() - t0) / 1e6
    // A noop that rewrote an output timed a restore, not a noop.
    if (before !== '' && JSON.stringify(outputMtimes(dirs[tool])) !== before)
      throw new Error(`${tool} noop rewrote outputs: the arm timed a restore`)
    const k = `${tool} ${arm}`
    best.set(k, Math.min(best.get(k) ?? Infinity, ms))
    return ms
  }
  // vx, the base, then Turbo, back to back, and the cores other processes
  // kept busy over them: the machine's busy time less this process's and its children's.
  const pair = (arm: Arm): Pair => {
    const busy0 = machineBusyMs()
    const own0 = ownCpuMs()
    const t0 = Bun.nanoseconds()
    const vx = time('vx', arm)
    const base = BASE === undefined ? undefined : time('base', arm)
    const turbo = time('turbo', arm)
    const busy1 = machineBusyMs()
    const wall = (Bun.nanoseconds() - t0) / 1e6
    const others =
      busy0 === undefined || busy1 === undefined
        ? 0
        : Math.max(0, busy1 - busy0 - (ownCpuMs() - own0)) / wall
    return { vx, turbo, others, ...(base === undefined ? {} : { base }) }
  }
  // Warm both tools once, then interleave: vx and Turbo alternate within each rep.
  // A check reps only the held arms and prints cold from the warm-up: cold
  // reps were 14 of its 44 runs and most of its time (102 s on CI, the
  // longest task of a full run, 2026-10-23).
  for (const tool of tools) time(tool, 'cold')
  if (update) best.clear()
  // Each arm reps until REPS of its pairs ran quiet (MAX_REPS at most),
  // and its ratio is the min of each tool over its REPS quietest pairs.
  const arms = update ? ARMS : HELD
  const pairs = new Map<Arm, Pair[]>(arms.map((a) => [a, []]))
  for (let rep = 0; rep < MAX_REPS; rep++) {
    const left = arms.filter(
      (a) => pairs.get(a)!.length < REPS || !enoughQuiet(pairs.get(a)!, REPS, QUIET_CORES),
    )
    if (left.length === 0) break
    for (const arm of left) pairs.get(arm)!.push(pair(arm))
  }
  for (const arm of arms) {
    const ran = pairs.get(arm)!
    const kept = quietest(ran, REPS)
    best.set(`vx ${arm}`, Math.min(...kept.map((p) => p.vx)))
    best.set(`turbo ${arm}`, Math.min(...kept.map((p) => p.turbo)))
    if (BASE !== undefined) best.set(`base ${arm}`, Math.min(...kept.map((p) => p.base!)))
    const others = Math.max(...kept.map((p) => p.others))
    console.log(
      `${arm}: ${ran.length} pairs, the ${kept.length} quietest with ≤ ${others.toFixed(2)} cores busy beside them`,
    )
    if (others > QUIET_CORES)
      console.log(
        `BUSY ${arm}: no ${REPS} pairs ran quiet; held anyway, so a fail may be the neighbours`,
      )
  }

  const ratios = Object.fromEntries(
    ARMS.map((arm) => [arm, best.get(`vx ${arm}`)! / best.get(`turbo ${arm}`)!]),
  ) as Record<Arm, number>
  const baseline = (await Bun.file(BASELINE)
    .json()
    .catch(() => ({}))) as Partial<Record<string, Record<Arm, number>>>
  const platform = `${process.platform}-${process.arch}`
  const fails: string[] = []
  console.log(`case      vx        turbo     vx/turbo  baseline`)
  for (const arm of ARMS) {
    const was = baseline[platform]?.[arm]
    const r = ratios[arm]
    console.log(
      `${arm.padEnd(9)} ${best.get(`vx ${arm}`)!.toFixed(0).padStart(5)} ms  ${best.get(`turbo ${arm}`)!.toFixed(0).padStart(5)} ms  ${r.toFixed(2).padStart(8)}  ${was?.toFixed(2) ?? '-'}`,
    )
    if (r > 1) console.log(`LOSS ${arm}: vx is slower than Turbo (${r.toFixed(2)}×)`)
    if (HELD.includes(arm) && was !== undefined && r > was * TOLERANCE) {
      fails.push(
        `${arm}: vx/turbo ${was.toFixed(2)} → ${r.toFixed(2)}, past ${TOLERANCE}× the baseline`,
      )
    }
  }
  if (update) {
    baseline[platform] = Object.fromEntries(
      ARMS.map((a) => [a, Number(ratios[a].toFixed(3))]),
    ) as Record<Arm, number>
    await writeFile(BASELINE, JSON.stringify(baseline, null, 2) + '\n')
    console.log(`recorded ${platform} in pr-bench-baseline.json`)
  } else {
    const held = Object.fromEntries(
      HELD.map((arm) => [arm, { vx: best.get(`vx ${arm}`)!, base: best.get(`base ${arm}`) }]),
    )
    if (BASE !== undefined)
      for (const arm of HELD)
        console.log(
          `${arm.padEnd(9)} vx ${held[arm]!.vx.toFixed(0)} ms, base ${BASE.slice(0, 9)} ${held[arm]!.base!.toFixed(0)} ms`,
        )
    fails.push(...baseFails(held, HELD))
    for (const f of fails) console.log(`FAIL ${f}`)
    process.exitCode = fails.length > 0 ? 1 : 0
  }
} finally {
  if (!process.env.KEEP) {
    await rm(ws, { recursive: true, force: true })
    await rm(`${ws}-turbo`, { recursive: true, force: true })
    await rm(`${ws}-base`, { recursive: true, force: true })
  } else console.log(ws)
}
