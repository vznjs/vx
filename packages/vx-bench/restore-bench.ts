// Sequential restore of every artifact in a workspace's local cache, each
// into its own empty directory (a real run cleans outputs first, so no
// restore replaces a file), min and median over `reps` passes — the
// per-artifact cost of `Cache.restoreOutputs` in isolation, where a change
// of a few syscalls shows (item 627: 525–576 → 470–484 µs per one-file
// artifact) while the four-worker run overlaps it into its ±6 % noise.
//
//   bun packages/vx-bench/restore-bench.ts <vx-repo-root> <workspace> [reps]
//
// `<vx-repo-root>` is the checkout whose core to measure, so a `git
// worktree` of the before-arm runs the same script; the workspace must
// have been run once so its cache holds the artifacts.
import { mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import type { Database } from 'bun:sqlite'

const [root, ws, repsArg] = process.argv.slice(2)
if (root === undefined || ws === undefined) {
  console.error('usage: bun restore-bench.ts <vx-repo-root> <workspace> [reps]')
  process.exit(2)
}
const reps = Number(repsArg ?? 5)
const { Cache } = (await import(path.join(root, 'packages/vx/src/cache/index.ts'))) as {
  Cache: new (dir: string) => {
    restoreOutputs(hash: string, projectDir: string): Promise<void>
    dbHandle(): Database
    close(): void
  }
}
// `entries` lives in the shared store DB (SCHEMA v32), which only the
// Cache knows how to locate.
const cache = new Cache(path.join(ws, '.vx/cache'))
const hashes = (cache.dbHandle().query('SELECT hash FROM entries').all() as { hash: string }[]).map(
  (r) => r.hash,
)
const dest = path.join(ws, '.restore-bench')
const dirs = hashes.map((_, i) => path.join(dest, String(i)))
const times: number[] = []
for (let r = 0; r < reps; r++) {
  rmSync(dest, { recursive: true, force: true })
  for (const d of dirs) mkdirSync(d, { recursive: true })
  const t = performance.now()
  for (let i = 0; i < hashes.length; i++) await cache.restoreOutputs(hashes[i]!, dirs[i]!)
  times.push(performance.now() - t)
}
rmSync(dest, { recursive: true, force: true })
times.sort((a, b) => a - b)
const min = times[0]!
console.log(
  `${hashes.length} artifacts × ${reps} reps: min ${min.toFixed(1)} ms, median ${times[Math.floor(reps / 2)]!.toFixed(1)} ms, ${((min / hashes.length) * 1000).toFixed(0)} µs per artifact`,
)
cache.close()
