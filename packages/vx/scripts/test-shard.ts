// Deal the core test files across N shards by MEASURED weight, not by count.
//
// `bun test --shard=i/n` deals files round-robin by sorted name, so the
// shards' loads are whatever the alphabet made them: on 2026-09-10 the
// heaviest shard ran 24 s and the lightest 10 s, and the gate's wall time
// is the heaviest. Longest-processing-time-first over a recorded weight
// per file evens them to within a second. A file the table does not know
// gets the table's median, so a new file costs nothing to add.
//
//   bun scripts/test-shard.ts <i> <n>        the files for shard i of n
//   bun scripts/test-shard.ts --weigh <dir>  refresh tests/shard-weights.json
//                                            from the JUnit reports in <dir>
//                                            (`bun test --reporter=junit
//                                            --reporter-outfile=<dir>/s<i>.xml`)

import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const here = path.dirname(new URL(import.meta.url).pathname)
const TESTS = path.join(here, '..', 'tests')
const TABLE = path.join(TESTS, 'shard-weights.json')

export function testFiles(): string[] {
  return readdirSync(TESTS)
    .filter((f) => f.endsWith('.test.ts') && !f.endsWith('.unsafe.test.ts'))
    .sort()
}

export function readWeights(): Record<string, number> {
  return JSON.parse(readFileSync(TABLE, 'utf8')) as Record<string, number>
}

/** Deterministic LPT: heaviest first, ties by name, each into the lightest bin. */
export function partition(
  files: readonly string[],
  weights: Readonly<Record<string, number>>,
  n: number,
): string[][] {
  const known = Object.values(weights).sort((a, b) => a - b)
  const median = known.length === 0 ? 1 : (known[known.length >> 1] ?? 1)
  const weightOf = (f: string): number => weights[f] ?? median
  const order = [...files].sort((a, b) => weightOf(b) - weightOf(a) || a.localeCompare(b))
  const bins: Array<{ load: number; files: string[] }> = Array.from({ length: n }, () => ({
    load: 0,
    files: [],
  }))
  for (const f of order) {
    let target = bins[0]!
    for (const b of bins) if (b.load < target.load) target = b
    target.load += weightOf(f)
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
    const table = weighJunit(b)
    writeFileSync(TABLE, `${JSON.stringify(table, null, 2)}\n`)
    console.error(
      `${Object.keys(table).length} files weighed into ${path.relative(process.cwd(), TABLE)}`,
    )
  } else {
    const i = Number(a)
    const n = Number(b)
    if (!Number.isInteger(i) || !Number.isInteger(n) || i < 1 || i > n) {
      throw new Error('usage: test-shard.ts <i> <n>  (1 ≤ i ≤ n)')
    }
    const shard = partition(testFiles(), readWeights(), n)[i - 1]!
    console.log(shard.map((f) => `tests/${f}`).join(' '))
  }
}
