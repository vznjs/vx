#!/usr/bin/env bun
// Partition the core test files into N shards and run one of them, so the
// gate runs the suite as N parallel `bun test` processes instead of one
// ~145 s process.
//
//   bun tests/helpers/shard.ts run  <shards> <index>   → run shard <index>
//   bun tests/helpers/shard.ts list <shards> <index>   → print its files
//
// Balancing is longest-first greedy (LPT) over an estimated cost per file:
// a `// @vx-shard-cost <seconds>` line near the top of a test file when it
// has one, else the file's size (~0.1 s per KB across this suite, measured
// 2026-09-03 with a JUnit run). Size alone put one 42 s file — a memory
// measurement that is small on disk — into a 77 s shard beside two of
// 30 s; the hint is how such a file says what it costs, next to the code
// that makes it cost that, so a wrong hint only unbalances and never
// silently rots a list nobody sees.
//
// A file marked `// @vx-shard-isolate` gets a `bun test` process of its own
// within its shard. `bun test` pins ~2 descriptors per dynamically imported
// module and 2–3 per directory it lives in, for the life of the process
// (Bun 1.4.0; pinned by tests/bun-test-import-descriptors.test.ts). A
// fixture that imports 2 000 configs therefore parks the process at the
// 10 240-descriptor macOS cap, and the next spawn in ANY later file fails
// with EBADF. The whole-suite process survives only because that file
// sorts late alphabetically; a shard is one file-order away from the same
// failure unless the hungry file runs alone.
//
// Separate processes are also STRICTER than one: a spy or global leaked
// by one file cannot reach another shard, which is the failure a single
// process hid once (a prototype spy left by a failing test, 2026-09-03).

import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

const [mode, shardsArg, indexArg] = process.argv.slice(2)
const shards = Number(shardsArg)
const index = Number(indexArg)
if (
  (mode !== 'run' && mode !== 'list') ||
  !Number.isInteger(shards) ||
  shards < 1 ||
  !Number.isInteger(index) ||
  index < 0 ||
  index >= shards
) {
  process.stderr.write('usage: shard.ts run|list <shards> <index>\n')
  process.exit(2)
}
const dir = path.resolve(import.meta.dir, '..')

interface TestFile {
  rel: string
  cost: number
  isolate: boolean
}

function describe(file: string): TestFile {
  const head = readFileSync(path.join(dir, file), 'utf8').slice(0, 2000)
  const hint = /^\/\/ @vx-shard-cost (\d+(?:\.\d+)?)\b/m.exec(head)
  return {
    rel: `./tests/${file}`,
    cost: hint !== null ? Number(hint[1]) : statSync(path.join(dir, file)).size / 10_000,
    isolate: /^\/\/ @vx-shard-isolate\b/m.test(head),
  }
}

const files = readdirSync(dir)
  .filter((f) => f.endsWith('.test.ts'))
  .map(describe)
  .sort((a, b) => b.cost - a.cost || (a.rel < b.rel ? -1 : 1))
const load: number[] = Array.from({ length: shards }, () => 0)
const buckets: TestFile[][] = Array.from({ length: shards }, () => [])
for (const file of files) {
  let lightest = 0
  for (let i = 1; i < shards; i++) if (load[i]! < load[lightest]!) lightest = i
  load[lightest]! += file.cost
  buckets[lightest]!.push(file)
}
const mine = buckets[index]!

if (mode === 'list') {
  process.stdout.write(mine.map((f) => f.rel).join(' ') + '\n')
  process.exit(0)
}

// One process for the shared files, one per isolated file. Every group runs
// even after a failure so a red shard reports every failing test, not the
// first group's.
const groups: string[][] = []
const shared = mine.filter((f) => !f.isolate).map((f) => f.rel)
if (shared.length > 0) groups.push(shared)
for (const f of mine) if (f.isolate) groups.push([f.rel])

let exit = 0
for (const group of groups) {
  const proc = Bun.spawn({
    cmd: ['bun', 'test', '--preload', './tests/setup.ts', ...group],
    cwd: path.resolve(dir, '..'),
    stdio: ['inherit', 'inherit', 'inherit'],
  })
  const code = await proc.exited
  if (code !== 0 && exit === 0) exit = code
}
process.exit(exit)
