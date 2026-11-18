// Deal the core test files across N shards by MEASURED weight, not by count.
//
// `bun test --shard=i/n` deals files round-robin by sorted name, so the
// shards' loads are whatever the alphabet made them: on 2026-09-10 the
// heaviest shard ran 24 s and the lightest 10 s, and the gate's wall time
// is the heaviest. Longest-processing-time-first over a recorded weight
// per file evens them to within a second. A file the table does not know
// gets the table's median, so a new file costs nothing to add.
//
//   bun scripts/test-shard.ts <i> <n>           the files for shard i of n
//   bun scripts/test-shard.ts <i> <n> --shape 24x4,12x2,24x1
//                                               the n shards unequal: 24 of
//                                               size 4, 12 of 2, 24 of 1
//   bun scripts/test-shard.ts <i> <n> --unsafe  the same over *.unsafe.test.ts
//   bun scripts/test-shard.ts <i> <n> --platform  only PLATFORM_TESTS (with
//                                               or without --unsafe)
//   bun scripts/test-shard.ts --weigh <dir>     refresh both weight tables
//                                               from the JUnit reports in <dir>
//                                            (`bun test --reporter=junit
//                                            --reporter-outfile=<dir>/s<i>.xml`)

import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const here = import.meta.dir
const TESTS = path.join(here, '..', 'tests')
// The unsafe suite is dealt too: as one task it was a run's critical path
// (178 s of a 216 s DTE run, 2026-10-22) on one agent at 34% CPU.
export type Suite = 'safe' | 'unsafe'
const TABLES: Record<Suite, string> = {
  safe: path.join(TESTS, 'shard-weights.json'),
  unsafe: path.join(TESTS, 'unsafe-shard-weights.json'),
}
const isUnsafe = (f: string): boolean => f.endsWith('.unsafe.test.ts')

/**
 * The files whose outcome is the platform's: tar and archives, restore and
 * links, the sandbox, signals and process trees, file watching, SQLite,
 * umask, clocks, procfs and descriptors held across runs. The macOS run takes only these: the rest is
 * the same code on the same Bun (2026-10-22).
 */
const PLATFORM_TESTS =
  /^(archive|artifact|restore|builtins-restore|tar|scan-tar|zstd|sandbox|seatbelt|kill-tree|task-tree-kill|signal|stop-signal|watch|sqlite|config-umask|fs-clock|cache-(close|disk-full|open-busy|out-of-fds|store|unreadable)|disk-full|committed-case|tmpdir|util-procfs|proc-sample|runner|linked-inputs|output-(links|empty-dir)|file-url-paths|repeated-runs)[-.]/

export function testFiles(suite: Suite = 'safe', platform = false): string[] {
  return readdirSync(TESTS)
    .filter(
      (f) =>
        f.endsWith('.test.ts') &&
        isUnsafe(f) === (suite === 'unsafe') &&
        (!platform || PLATFORM_TESTS.test(f)),
    )
    .sort()
}

// The Mac's own times for the platform's files: a Mac skips the Linux
// sandbox's tests and runs its own, so the Linux table dealt its six
// shards 57 to 84 s of work (2026-11-18). Only the safe suite has one.
// Weighed on CI's Macs: a passing task's output is in no log, so a probe
// PR's shards printed their JUnit file times and failed (#5330).
const PLATFORM_TABLE = path.join(TESTS, 'platform-shard-weights.json')

export function readWeights(suite: Suite = 'safe', platform = false): Record<string, number> {
  const table = JSON.parse(readFileSync(TABLES[suite], 'utf8')) as Record<string, number>
  if (!platform || suite !== 'safe') return table
  return {
    ...table,
    ...(JSON.parse(readFileSync(PLATFORM_TABLE, 'utf8')) as Record<string, number>),
  }
}

/**
 * `24x4,12x2,24x1` as each shard's relative size, biggest first: 24 of
 * size 4, 12 of 2, 24 of 1. Equal shards end a distributed run raggedly:
 * a worker's second shard is as long as its first, so the last ones start
 * with half the run gone and one slow runner's ends it. Big shards go
 * first by their rank and small ones fill the end: over 20 simulated runs
 * of each of two main runs the Linux work ended 13 to 23 s sooner
 * (2026-11-18).
 */
export function shardSizes(shape: string): number[] {
  const sizes = shape.split(',').flatMap((part) => {
    const m = /^(\d+)x(\d+)$/.exec(part)
    if (m === null || Number(m[1]) < 1 || Number(m[2]) < 1)
      throw new Error(`--shape is counts and sizes such as 24x4,12x2,24x1: not ${shape}`)
    return Array.from({ length: Number(m[1]) }, () => Number(m[2]))
  })
  return sizes.sort((a, b) => b - a)
}

/**
 * Deterministic LPT: heaviest first, ties by name, each into the bin it
 * leaves lightest for its size. `n` shards of one size, or each one's
 * relative size (`shardSizes`).
 */
export function partition(
  files: readonly string[],
  weights: Readonly<Record<string, number>>,
  n: number | readonly number[],
): string[][] {
  const known = Object.values(weights).sort((a, b) => a - b)
  const median = known.length === 0 ? 1 : (known[known.length >> 1] ?? 1)
  const weightOf = (f: string): number => weights[f] ?? median
  const order = [...files].sort((a, b) => weightOf(b) - weightOf(a) || a.localeCompare(b))
  const sizes = typeof n === 'number' ? Array.from({ length: n }, () => 1) : n
  const bins = sizes.map((size) => ({ size, load: 0, files: [] as string[] }))
  for (const f of order) {
    const w = weightOf(f)
    let target = bins[0]!
    for (const b of bins) if ((b.load + w) / b.size < (target.load + w) / target.size) target = b
    target.load += w
    target.files.push(f)
  }
  return bins.map((b) => b.files.sort())
}

/**
 * Each file's whole wall time out of Bun's JUnit reports in `dir`, in ms.
 * The FILE-level `<testsuite>` (the one named by its path), not the sum of
 * its test cases: `beforeAll` work is outside every case, and one file's
 * 6,000-package generator was 9.5 s of an 11.5 s file.
 */
function weighJunit(dir: string): Record<string, number> {
  const sums = new Map<string, number>()
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.xml')) continue
    const xml = readFileSync(path.join(dir, name), 'utf8')
    for (const m of xml.matchAll(
      /<testsuite name="(tests\/[^"]+)" file="\1"[^>]*?\btime="([\d.]+)"/g,
    )) {
      const file = path.basename(m[1]!)
      sums.set(file, (sums.get(file) ?? 0) + Number(m[2]))
    }
  }
  const out: Record<string, number> = {}
  for (const f of [...sums.keys()].sort()) out[f] = Math.round(sums.get(f)! * 1000)
  return out
}

if (import.meta.main) {
  const [a, b] = process.argv.slice(2)
  if (a === '--weigh') {
    if (b === undefined) throw new Error('usage: test-shard.ts --weigh <junit-dir>')
    const all = weighJunit(b)
    for (const suite of ['safe', 'unsafe'] as const) {
      const table = Object.fromEntries(
        Object.entries(all).filter(([f]) => isUnsafe(f) === (suite === 'unsafe')),
      )
      // A run of one suite leaves the other's table as it was.
      if (Object.keys(table).length === 0) continue
      writeFileSync(TABLES[suite], `${JSON.stringify(table, null, 2)}\n`)
      console.error(
        `${Object.keys(table).length} files weighed into ${path.relative(process.cwd(), TABLES[suite])}`,
      )
    }
  } else {
    const i = Number(a)
    const n = Number(b)
    if (!Number.isInteger(i) || !Number.isInteger(n) || i < 1 || i > n) {
      throw new Error(
        'usage: test-shard.ts <i> <n> [--unsafe] [--platform] [--shape 24x4,12x2,24x1]  (1 ≤ i ≤ n)',
      )
    }
    const flags = process.argv.slice(4)
    const suite: Suite = flags.includes('--unsafe') ? 'unsafe' : 'safe'
    const platform = flags.includes('--platform')
    const shape = flags.includes('--shape') ? flags[flags.indexOf('--shape') + 1] : undefined
    const sizes = shape === undefined ? n : shardSizes(shape)
    if (typeof sizes !== 'number' && sizes.length !== n)
      throw new Error(`--shape ${shape} is ${sizes.length} shards, not ${n}`)
    const shard = partition(testFiles(suite, platform), readWeights(suite, platform), sizes)[i - 1]!
    console.log(shard.map((f) => `tests/${f}`).join(' '))
  }
}
