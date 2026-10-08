// Reproducible local benchmark for the table in docs/benchmarks.md.
//
//   bun packages/vx-bench/run.ts [projects=100] [reps=3]
//   VX_BIN=dist/vx-linux-x64 bun packages/vx-bench/run.ts 100 5   # the shipped binary
//
// Measures three conditions over the synthetic workspace from
// bench/generate.ts, reporting the median of `reps` runs each:
//   no-cache       — fresh cache dir every rep (cold key derivation +
//                    exec + save)
//   warm-no-restore— second run over an intact tree (stat-check skip
//                    path; the steady-state dev loop)
//   warm-restore   — outputs deleted, cache intact (full extract path)
//
// vx is invoked as a real subprocess (`bun src/bin.ts run build --all
// --frozen`, or the same through `$VX_BIN`) so process startup and discovery
// are included — the same costs a user pays. It runs from a `vx lock`
// snapshot taken once before the reps, as CI would; a config edit after it
// is re-locked explicitly (`vx lock`), never by the bench. The source path
// pays ~40 ms of transpile per run that the `--bytecode` release binary
// does not (measured 2026-09-09 on a two-package workspace: 114 vs
// 71 ms), so a small-workspace number should be taken through VX_BIN.

import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { summarize } from './ab.js'
import { benchEnv } from './bench-env.js'

const projects = Number(process.argv[2] ?? 100)
const reps = Number(process.argv[3] ?? 3)
const vxRoot = path.resolve(import.meta.dir, '..', '..')
const vxBin = process.env['VX_BIN']
const vxCmd: string[] =
  vxBin !== undefined && vxBin !== ''
    ? [path.resolve(vxBin)]
    : [process.execPath, path.join(vxRoot, 'packages', 'vx', 'src', 'bin.ts')]

async function vx(cwd: string, args: readonly string[]): Promise<number> {
  const t0 = Bun.nanoseconds()
  const p = Bun.spawn({
    cmd: [...vxCmd, ...args],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: benchEnv({ NO_COLOR: '1' }),
  })
  const code = await p.exited
  if (code !== 0) {
    console.error(await new Response(p.stderr).text())
    throw new Error(`vx ${args[0]} failed (${code})`)
  }
  return (Bun.nanoseconds() - t0) / 1e6
}

const vxRun = (cwd: string) => vx(cwd, ['run', 'build', '--all', '--frozen'])

const ws = await mkdtemp(path.join(os.tmpdir(), 'vx-bench-'))
const gen = Bun.spawnSync({
  cmd: [process.execPath, path.join(import.meta.dir, 'generate.ts'), ws, String(projects)],
  stdout: 'inherit',
  stderr: 'inherit',
})
if (gen.exitCode !== 0) throw new Error('generate failed')
await vx(ws, ['lock'])

const wipeCache = () => rm(path.join(ws, '.vx'), { recursive: true, force: true })
const wipeOutputs = async () => {
  const glob = new Bun.Glob('packages/*/dist')
  for await (const d of glob.scan({ cwd: ws, onlyFiles: false })) {
    await rm(path.join(ws, d), { recursive: true, force: true })
  }
}

const noCache: number[] = []
for (let i = 0; i < reps; i++) {
  await wipeCache()
  await wipeOutputs()
  noCache.push(await vxRun(ws))
}

// Warm the cache once, then measure the all-hits stat-skip path.
await wipeCache()
await wipeOutputs()
await vxRun(ws)
const warmNoRestore: number[] = []
for (let i = 0; i < reps; i++) warmNoRestore.push(await vxRun(ws))

const warmRestore: number[] = []
for (let i = 0; i < reps; i++) {
  await wipeOutputs()
  warmRestore.push(await vxRun(ws))
}

await rm(ws, { recursive: true, force: true })

const fmt = (xs: number[]) =>
  `${summarize(xs).median.toFixed(0)} ms  (all: ${xs.map((x) => x.toFixed(0)).join(' / ')})`
console.log(`\nvx benchmark — ${projects} projects × build, median of ${reps}`)
console.log(`  no-cache        : ${fmt(noCache)}`)
console.log(`  warm, no restore: ${fmt(warmNoRestore)}`)
console.log(`  warm, restore   : ${fmt(warmRestore)}`)
