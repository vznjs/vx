// Reproducible local benchmark for the table in docs/benchmarks.md.
//
//   bun bench/run.ts [projects=100] [reps=3]
//
// Measures three conditions over the synthetic workspace from
// bench/generate.ts, reporting the median of `reps` runs each:
//   no-cache       — fresh cache dir every rep (cold key derivation +
//                    exec + save)
//   warm-no-restore— second run over an intact tree (stat-check skip
//                    path; the steady-state dev loop)
//   warm-restore   — outputs deleted, cache intact (full extract path)
//
// vx is invoked as a real subprocess (`bun src/bin.ts run build -r`)
// so process startup, discovery, and config evaluation are included —
// the same costs a user pays.

import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const projects = Number(process.argv[2] ?? 100)
const reps = Number(process.argv[3] ?? 3)
const vxRoot = path.resolve(import.meta.dir, '..')

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]!
}

async function vxRun(cwd: string): Promise<number> {
  const t0 = Bun.nanoseconds()
  const p = Bun.spawn({
    cmd: [
      process.execPath,
      path.join(vxRoot, 'packages', 'vx', 'src', 'bin.ts'),
      'run',
      'build',
      '--all',
    ],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, NO_COLOR: '1' },
  })
  const code = await p.exited
  if (code !== 0) {
    console.error(await new Response(p.stderr).text())
    throw new Error(`vx run failed (${code})`)
  }
  return (Bun.nanoseconds() - t0) / 1e6
}

const ws = await mkdtemp(path.join(os.tmpdir(), 'vx-bench-'))
const gen = Bun.spawnSync({
  cmd: [process.execPath, path.join(import.meta.dir, 'generate.ts'), ws, String(projects)],
  stdout: 'inherit',
  stderr: 'inherit',
})
if (gen.exitCode !== 0) throw new Error('generate failed')

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
  `${median(xs).toFixed(0)} ms  (all: ${xs.map((x) => x.toFixed(0)).join(' / ')})`
console.log(`\nvx benchmark — ${projects} projects × build, median of ${reps}`)
console.log(`  no-cache        : ${fmt(noCache)}`)
console.log(`  warm, no restore: ${fmt(warmNoRestore)}`)
console.log(`  warm, restore   : ${fmt(warmRestore)}`)
