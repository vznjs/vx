// The per-PR bench against Turborepo (owner, 2026-10-12): a run that takes
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
// when its ratio grew past TOLERANCE over the recorded one. Cold is printed,
// not held: 200 spawns on 4 cores moved its ratio from 0.71 to 1.12 between
// two CI runs of one commit (2026-10-12). A case vx loses prints LOSS.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { benchEnv } from './bench-env.js'

const PROJECTS = 100
const REPS = 7
const CONCURRENCY = 4
/** A ratio past baseline × this fails. */
const TOLERANCE = 1.3
const BASELINE = path.join(import.meta.dir, 'pr-bench-baseline.json')
const update = process.argv.includes('--update')

const ARMS = ['cold', 'restore', 'noop'] as const
const HELD: readonly Arm[] = ['restore', 'noop']
type Arm = (typeof ARMS)[number]

function sh(cmd: string[], cwd: string): { ok: boolean; out: string } {
  // Turbo's telemetry writes ~/.config/turborepo, which the task sandbox refuses.
  const env = benchEnv({ TURBO_TELEMETRY_DISABLED: '1', DO_NOT_TRACK: '1' })
  const r = Bun.spawnSync(cmd, { cwd, env, stdout: 'pipe', stderr: 'pipe' })
  return { ok: r.exitCode === 0, out: r.stdout.toString() + r.stderr.toString() }
}
function must(cmd: string[], cwd: string): string {
  const r = sh(cmd, cwd)
  if (!r.ok) throw new Error(`${cmd.join(' ')} failed:\n${r.out.slice(-2000)}`)
  return r.out
}

const ws = await mkdtemp(path.join(os.tmpdir(), 'vx-prbench-'))
try {
  const json = (p: string, v: unknown) => writeFile(path.join(ws, p), JSON.stringify(v) + '\n')
  await writeFile(path.join(ws, '.gitignore'), 'node_modules\ndist\n.vx\n.turbo\n')
  await json('package.json', {
    name: 'bench-root',
    private: true,
    packageManager: 'bun@1.4.2',
    workspaces: ['packages/*'],
  })
  await writeFile(path.join(ws, 'vx.workspace.mjs'), 'export default { plugins: [] }\n')
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
    cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] } } },
  test: { dependsOn: ['build'], exec: { command: 'true' },
    cache: { inputs: { files: ['src/**'] }, outputs: { files: [] } } },
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

  const runs: Record<'vx' | 'turbo', string[]> = {
    vx: [vx, 'run', 'build', 'test', '--all', `--concurrency=${CONCURRENCY}`],
    turbo: [turbo, 'run', 'build', 'test', `--concurrency=${CONCURRENCY}`, '--no-daemon'],
  }
  const wipeOutputs = () =>
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
      ],
      ws,
    )
  // Each tool's own cache only: Turbo's cold rep must not empty vx's before vx's restore rep.
  const wipeCache = (tool: 'vx' | 'turbo') => {
    sh(['rm', '-rf', ...(tool === 'vx' ? ['.vx'] : ['.turbo', 'node_modules/.cache/turbo'])], ws)
  }
  const best = new Map<string, number>()
  const time = (tool: 'vx' | 'turbo', arm: Arm) => {
    if (arm === 'cold') {
      wipeCache(tool)
      wipeOutputs()
    } else if (arm === 'restore') wipeOutputs()
    const t0 = Bun.nanoseconds()
    must(runs[tool], ws)
    const ms = (Bun.nanoseconds() - t0) / 1e6
    const k = `${tool} ${arm}`
    best.set(k, Math.min(best.get(k) ?? Infinity, ms))
  }
  // Warm both tools once, then interleave: vx and Turbo alternate within each rep.
  for (const tool of ['vx', 'turbo'] as const) time(tool, 'cold')
  best.clear()
  for (let rep = 0; rep < REPS; rep++) {
    for (const arm of ARMS) for (const tool of ['vx', 'turbo'] as const) time(tool, arm)
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
    for (const f of fails) console.log(`FAIL ${f}`)
    process.exitCode = fails.length > 0 ? 1 : 0
  }
} finally {
  if (!process.env.KEEP) await rm(ws, { recursive: true, force: true })
  else console.log(ws)
}
