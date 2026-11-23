// The weighted shard dealer (scripts/test-shard.ts): every core test file
// lands in exactly one shard, the deal is deterministic, and the recorded
// weights name files that exist — a renamed file must take its weight
// with it, or it silently falls to the median.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { partition, readWeights, shardSizes, testFiles } from '../scripts/test-shard.js'
import {
  PLATFORM_SHARD_COUNT,
  PLATFORM_UNSAFE_SHARD_COUNT,
  SHARD_COUNT,
  SHARD_SHAPE,
  UNSAFE_SHARD_COUNT,
} from '../vx.config.js'

describe('weighted test shards', () => {
  const files = testFiles()
  const weights = readWeights()
  const sizes = shardSizes(SHARD_SHAPE)

  it('deals every non-unsafe test file exactly once across the configured shards', () => {
    const bins = partition(files, weights, sizes)
    expect(bins).toHaveLength(SHARD_COUNT)
    expect(bins.flat().sort()).toEqual([...files].sort())
    for (const bin of bins) expect(bin.length).toBeGreaterThan(0)
  })

  it('is deterministic', () => {
    expect(partition(files, weights, sizes)).toEqual(partition(files, weights, sizes))
  })

  it('balances the recorded load for each size: heaviest within 1.25× of the lightest', () => {
    const known = Object.values(weights).sort((a, b) => a - b)
    const median = known[known.length >> 1]!
    const loads = partition(files, weights, sizes).map(
      (bin, i) => bin.reduce((s, f) => s + (weights[f] ?? median), 0) / sizes[i]!,
    )
    expect(Math.max(...loads)).toBeLessThanOrEqual(Math.min(...loads) * 1.25)
  })

  // Equal shards on CI's 36 cores were two waves of one length: the second
  // began with half the run gone, and a slow runner's ended the run. The
  // big ones go first by their rank; the small ones fill the end.
  it('deals unequal shards by a shape, biggest first, each loaded for its size', () => {
    expect(shardSizes('2x4,1x2,3x1')).toEqual([4, 4, 2, 1, 1, 1])
    const w = Object.fromEntries(Array.from({ length: 130 }, (_, i) => [`f${i}.test.ts`, 100]))
    const bins = partition(Object.keys(w), w, shardSizes('2x4,1x2,3x1'))
    expect(bins.map((b) => b.length)).toEqual([40, 40, 20, 10, 10, 10])
    // CONTROL: the same files by a count are dealt evenly.
    expect(partition(Object.keys(w), w, 5).map((b) => b.length)).toEqual([26, 26, 26, 26, 26])
    // The configured shape is as many shards as the config generates tasks.
    expect(sizes).toHaveLength(SHARD_COUNT)
    expect(sizes).toEqual([...sizes].sort((a, b) => b - a))
  })

  it('refuses a shape that is not counts and sizes, and one of another count', () => {
    for (const bad of ['24', '24x', 'x4', '0x4', '2x0', '2x4;1x1', ''])
      expect(() => shardSizes(bad)).toThrow(
        `--shape is counts and sizes such as 24x4,12x2,24x1: not ${bad}`,
      )
    const run = Bun.spawnSync(
      [process.execPath, 'scripts/test-shard.ts', '1', '5', '--shape', '2x2,2x1'],
      { cwd: path.join(import.meta.dir, '..'), stderr: 'pipe' },
    )
    expect(run.exitCode).not.toBe(0)
    expect(run.stderr.toString()).toContain('--shape 2x2,2x1 is 4 shards, not 5')
  })

  // The balance test above can PASS while the suite's wall time is stuck: a
  // single file is indivisible, so once its own weight passes the ideal
  // per-shard load (total / SHARD_COUNT) no deal can place it anywhere
  // cheaper, and the dealer is powerless — the fix then is splitting the
  // file, not re-dealing. At 1.2× ideal the ratio above is still ~1.22×, so
  // that test would not say a word.
  //
  // Measured 2026-09-19 (item 370) over 37 gate runs: shard medians spread
  // 3.06× (21.2 s to 64.7 s) on the container, while the recorded deal is
  // even — shard 1 carries 13,622 against an ideal 13,262. The spread is the
  // runtime, not the deal (its heaviest file's tests fail by TIMEOUT below
  // the Bun floor and burn their full windows). What the measurement did
  // surface is how close the bound is: `watch-loop-uncached.test.ts` sits at
  // 79% of ideal, so a quarter more and no dealer can help.
  //
  // Weighed again 2026-11-18, the suite a third cheaper without strace:
  // `signal-handling.test.ts` was 44.7 s of an ideal 44.5 s, and its Ctrl-Z
  // tests moved to `signal-tstp.test.ts`. `cache-clean.test.ts` is next, at 83%.
  //
  // Unequal since 2026-11-18: the bound is the biggest shard's share, 45.6 s,
  // and the heaviest file, `cache-clean.test.ts`, is 81% of it.
  it('no single file outweighs the biggest shard — the dealer cannot split one', () => {
    const total = files.reduce((s, f) => s + (weights[f] ?? 0), 0)
    const ideal = (total * sizes[0]!) / sizes.reduce((a, b) => a + b, 0)
    const heaviest = files
      .map((f) => ({ file: f, weight: weights[f] ?? 0 }))
      .sort((a, b) => b.weight - a.weight)[0]!
    expect({ over: heaviest.weight > ideal, file: heaviest.file }).toEqual({
      over: false,
      file: heaviest.file,
    })
  })

  it('names only files that exist — a rename carries its weight', () => {
    const stale = Object.keys(weights).filter((f) => !files.includes(f))
    expect(stale).toEqual([])
  })

  it('a file the table does not know gets the median, not zero', () => {
    const bins = partition(['a.test.ts', 'b.test.ts', 'c.test.ts'], { 'b.test.ts': 100 }, 2)
    // With b=100 and a,c at the median (100), LPT lands two on one side and one on the other.
    expect(bins.map((b) => b.length).sort((x, y) => x - y)).toEqual([1, 2])
  })
})

// The unsafe suite is dealt by its own table, over its own files only.
describe('weighted unsafe shards', () => {
  const files = testFiles('unsafe')
  const weights = readWeights('unsafe')

  it('deals every unsafe test file exactly once, and no other file', () => {
    const bins = partition(files, weights, UNSAFE_SHARD_COUNT)
    expect(bins.flat().sort()).toEqual([...files].sort())
    expect(files.every((f) => f.endsWith('.unsafe.test.ts'))).toBe(true)
    for (const bin of bins) expect(bin.length).toBeGreaterThan(0)
  })

  it('names only unsafe files that exist', () => {
    expect(Object.keys(weights).filter((f) => !files.includes(f))).toEqual([])
  })
})

// The macOS run deals only the platform's files (`--platform`), from the
// same tables, so its shards come out as even as the full suite's.
describe('platform shards', () => {
  it('deal each platform file once, in both suites, and nothing else', () => {
    for (const [suite, n] of [
      ['safe', PLATFORM_SHARD_COUNT],
      ['unsafe', PLATFORM_UNSAFE_SHARD_COUNT],
    ] as const) {
      const files = testFiles(suite, true)
      const bins = partition(files, readWeights(suite, true), n)
      expect(bins.flat().sort()).toEqual(files)
      for (const bin of bins) expect(bin.length).toBeGreaterThan(0)
      expect(files.every((f) => testFiles(suite).includes(f))).toBe(true)
    }
    expect(testFiles('safe', true)).toContain('tar-stream.test.ts')
    expect(testFiles('safe', true)).not.toContain('status-line.test.ts')
    expect(testFiles('unsafe', true)).toContain('sandbox-runtime.unsafe.test.ts')
    expect(testFiles('unsafe', true)).not.toContain('skills-install.unsafe.test.ts')
  })

  // A file that branches on the host being a Mac says what a Mac must do;
  // dealt only to Linux, that branch never ran (a darwin-only describe ran
  // nowhere at all).
  it('deal every file that branches on darwin to the Mac', () => {
    const branches = /process\.platform\s*[!=]==?\s*'darwin'/
    for (const suite of ['safe', 'unsafe'] as const) {
      const mac = testFiles(suite, true)
      const missed = testFiles(suite).filter(
        (f) =>
          !mac.includes(f) && branches.test(readFileSync(path.join(import.meta.dir, f), 'utf8')),
      )
      expect([suite, missed]).toEqual([suite, []])
    }
  })

  // A Mac skips the Linux sandbox's tests and runs its own: dealt by the
  // Linux table, its six shards ran 57 to 84 s (2026-11-18), and the Mac
  // work ends a distributed run as often as the Linux work does.
  it("deals the Mac's shards by the Mac's own times", () => {
    const files = testFiles('safe', true)
    const own = JSON.parse(
      readFileSync(path.join(import.meta.dir, 'platform-shard-weights.json'), 'utf8'),
    ) as Record<string, number>
    // It names only the platform's files; one it does not know keeps the Linux time.
    expect(Object.keys(own).filter((f) => !files.includes(f))).toEqual([])
    expect(Object.keys(own).length).toBeGreaterThan(files.length / 2)
    const dealt = readWeights('safe', true)
    const loads = partition(files, dealt, PLATFORM_SHARD_COUNT).map((bin) =>
      bin.reduce((s, f) => s + (own[f] ?? dealt[f] ?? 0), 0),
    )
    expect(Math.max(...loads) / Math.min(...loads)).toBeLessThan(1.05)
  })
})
