// Sequential restore of every artifact in a workspace's local cache into one
// scratch directory, min and median over `reps` passes — the per-artifact
// cost of `Cache.restoreOutputs` in isolation, where a change of a few
// syscalls shows (item 627: 525–576 → 470–484 µs per one-file artifact)
// while the four-worker run overlaps it into its ±6 % noise.
//
//   bun packages/vx-bench/restore-bench.ts <vx-repo-root> <workspace> [reps]
//
// `<vx-repo-root>` is the checkout whose core to measure, so a `git
// worktree` of the before-arm runs the same script; the workspace must
// have been run once so `.vx/cache` holds its artifacts.
import { mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { Database } from 'bun:sqlite'

const [root, ws, repsArg] = process.argv.slice(2)
if (root === undefined || ws === undefined) {
  console.error('usage: bun restore-bench.ts <vx-repo-root> <workspace> [reps]')
  process.exit(2)
}
const reps = Number(repsArg ?? 5)
const { Cache } = (await import(path.join(root, 'packages/vx/src/cache/index.ts'))) as {
  Cache: new (dir: string) => {
    restoreOutputs(hash: string, projectDir: string): Promise<void>
    close(): void
  }
}
const cacheDir = path.join(ws, '.vx/cache')
const db = new Database(path.join(cacheDir, 'cache.db'), { readonly: true })
const hashes = (db.query('SELECT hash FROM entries').all() as { hash: string }[]).map((r) => r.hash)
db.close()
const cache = new Cache(cacheDir)
const dest = path.join(ws, '.restore-bench')
const times: number[] = []
for (let r = 0; r < reps; r++) {
  rmSync(dest, { recursive: true, force: true })
  mkdirSync(dest, { recursive: true })
  const t = performance.now()
  for (const h of hashes) await cache.restoreOutputs(h, dest)
  times.push(performance.now() - t)
  rmSync(dest, { recursive: true, force: true })
}
times.sort((a, b) => a - b)
const min = times[0]!
console.log(
  `${hashes.length} artifacts × ${reps} reps: min ${min.toFixed(1)} ms, median ${times[Math.floor(reps / 2)]!.toFixed(1)} ms, ${((min / hashes.length) * 1000).toFixed(0)} µs per artifact`,
)
cache.close()
