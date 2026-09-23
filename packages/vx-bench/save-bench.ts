// Sequential local saves of N one-file artifacts (distinct hashes) into a
// fresh cache directory, min and median over `reps` passes — the twin of
// restore-bench.ts for the miss path. What it resolves: a save is ~1.1 ms
// here, so a change of two round trips (item 630) sat inside the order
// effect between arms; a change to the pack or the index shows.
//
//   bun packages/vx-bench/save-bench.ts <vx-repo-root> <n> [reps]
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const [root, nArg, repsArg] = process.argv.slice(2)
const n = Number(nArg ?? 1000)
const reps = Number(repsArg ?? 5)
const { Cache } = (await import(path.join(root!, 'packages/vx/src/cache/index.ts'))) as {
  Cache: new (dir: string) => {
    save(a: {
      hash: string
      projectDir: string
      outputFiles: string[]
      entry: { taskId: string; command: string; durationMs: number; stdout: string }
    }): Promise<void>
    close(): void
  }
}
const base = mkdtempSync(path.join(os.tmpdir(), 'vx-save-bench-'))
const projectDir = path.join(base, 'proj')
mkdirSync(path.join(projectDir, 'dist'), { recursive: true })
const out = path.join(projectDir, 'dist', 'out.js')
writeFileSync(out, 'console.log(1)\n')
const times: number[] = []
for (let r = 0; r < reps; r++) {
  const dir = path.join(base, `cache-${r}`)
  const cache = new Cache(dir)
  const t = performance.now()
  for (let i = 0; i < n; i++) {
    await cache.save({
      hash: `h${r}-${i.toString(16).padStart(12, '0')}`,
      projectDir,
      outputFiles: [out],
      entry: { taskId: 'p#build', command: 'x', durationMs: 1, stdout: '' },
    })
  }
  times.push(performance.now() - t)
  cache.close()
  rmSync(dir, { recursive: true, force: true })
}
rmSync(base, { recursive: true, force: true })
times.sort((a, b) => a - b)
console.log(
  `${n} saves × ${reps} reps: min ${times[0]!.toFixed(1)} ms, median ${times[Math.floor(reps / 2)]!.toFixed(1)} ms, ${((times[0]! / n) * 1000).toFixed(0)} µs per save`,
)
