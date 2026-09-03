// Cache hot-path performance baselines.
//
// Each test pins a wall-clock budget for one step on the cache-hit
// path. Budgets are deliberately ~3-5× the observed p99 on the dev
// box where they were calibrated (2026-05) — generous enough to
// absorb CI-runner variance, tight enough to fail loud when something
// regresses (e.g. an accidental switch back to a slower hash, an
// O(N²) accidentally introduced into `Cache.key`, etc).
//
// We use **median** over N iterations as the test signal, not p99 —
// the median is the most robust noise-resistant measure and answers
// the question we actually care about ("did the typical-case cost
// move?"). p99 / tail samples get logged for diagnostics on failure.
//
// `VX_PERF_SCALE` env var multiplies every budget — set it to 2 if
// CI starts flaking, then investigate. CI sets it automatically via
// `CI=true` detection below: shared GitHub-Actions runners are ~3×
// slower than a dev box and have noisier I/O.
// `VX_PERF=0` skips the whole suite (use during local dev when you
// don't care about timing).

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { scanArtifact } from '../src/cache/archive.js'
import { streamOf } from './helpers/stream.js'
import { Cache } from '../src/cache/cache.js'
import { xxh3, xxh3hex } from '../src/util/hash.js'

// CI auto-scales budgets ~3× to cover shared-runner variance; dev
// runs the calibration-tight values unless VX_PERF_SCALE is set
// explicitly.
const DEFAULT_SCALE = process.env.CI === 'true' ? 3 : 1
const SCALE = Number(process.env.VX_PERF_SCALE ?? String(DEFAULT_SCALE))
const SKIP = process.env.VX_PERF === '0'

/** Run `fn` `iters` times after `warmup` warmup iterations. Returns median + p99 ns. */
async function bench(
  iters: number,
  fn: () => void | Promise<void>,
  warmup = 5,
): Promise<{ medianNs: number; p99Ns: number; minNs: number; maxNs: number }> {
  for (let i = 0; i < warmup; i++) await fn()
  const samples: number[] = []
  for (let i = 0; i < iters; i++) {
    const t0 = Bun.nanoseconds()
    await fn()
    samples.push(Bun.nanoseconds() - t0)
  }
  samples.sort((a, b) => a - b)
  return {
    medianNs: samples[Math.floor(samples.length / 2)]!,
    p99Ns: samples[Math.floor(samples.length * 0.99)]!,
    minNs: samples[0]!,
    maxNs: samples[samples.length - 1]!,
  }
}

function budgetUs(name: string, baseUs: number): number {
  return baseUs * SCALE
}

/**
 * Min-of-N interleaved trials for RATIO guards. A ratio of two single-window
 * medians multiplies both windows' noise — a lucky-fast denominator inflates
 * it exactly like an unlucky-slow numerator — and the CI budget SCALE can't
 * absorb it (ratios are scale-free by design); this false-redded main twice
 * on shared runners. Noise only ever ADDS time, so the min median across
 * trials is the robust per-side estimate; interleaving A/B cancels drift.
 */
async function benchRatioSides(
  sideA: () => Promise<{ medianNs: number }>,
  sideB: () => Promise<{ medianNs: number }>,
  trials = 3,
): Promise<{ aMinNs: number; bMinNs: number }> {
  let aMin = Infinity
  let bMin = Infinity
  for (let t = 0; t < trials; t++) {
    aMin = Math.min(aMin, (await sideA()).medianNs)
    bMin = Math.min(bMin, (await sideB()).medianNs)
  }
  return { aMinNs: aMin, bMinNs: bMin }
}

/** Pretty-print a sample summary on failure so the diagnostic is actionable. */
function diag(
  r: { medianNs: number; p99Ns: number; minNs: number; maxNs: number },
  budgetUs: number,
) {
  return (
    `median=${(r.medianNs / 1000).toFixed(2)}µs ` +
    `(budget=${budgetUs}µs, ` +
    `p99=${(r.p99Ns / 1000).toFixed(2)}µs, ` +
    `min=${(r.minNs / 1000).toFixed(2)}µs, ` +
    `max=${(r.maxNs / 1000).toFixed(2)}µs)`
  )
}

function assertBudget(
  r: { medianNs: number; p99Ns: number; minNs: number; maxNs: number },
  budgetUs: number,
) {
  const medianUs = r.medianNs / 1000
  if (medianUs >= budgetUs) {
    throw new Error(
      `perf regression: median ${medianUs.toFixed(2)}µs exceeds budget ${budgetUs}µs ` +
        `(p99=${(r.p99Ns / 1000).toFixed(2)}µs). ` +
        `If this is intentional, retune the budget in tests/cache-baseline.test.ts.`,
    )
  }
  // Sanity check the harness itself — if median is suspiciously zero it
  // probably means the benchmarked work got DCE'd to nothing.
  expect(r.medianNs).toBeGreaterThan(0)
}

const describePerf = SKIP ? describe.skip : describe

describePerf('cache baseline: hash primitives', () => {
  it('xxh3hex(64B string) — median < 3µs', async () => {
    const r = await bench(5000, () => {
      xxh3hex('a'.repeat(64))
    })
    const budget = budgetUs('xxh3hex 64B', 3)
    if (r.medianNs / 1000 >= budget) console.log(diag(r, budget))
    assertBudget(r, budget)
  })

  it('xxh3hex(64KB Uint8Array) — median < 100µs', async () => {
    const buf = new Uint8Array(65536)
    const r = await bench(1000, () => {
      xxh3hex(buf)
    })
    const budget = budgetUs('xxh3hex 64KB', 100)
    if (r.medianNs / 1000 >= budget) console.log(diag(r, budget))
    assertBudget(r, budget)
  })

  it('xxh3 seed-chain (10 fields) — median < 20µs', async () => {
    const r = await bench(5000, () => {
      let h = xxh3('a')
      for (let i = 0; i < 9; i++) h = xxh3(`field${i}`, h)
    })
    const budget = budgetUs('xxh3 chain x10', 20)
    if (r.medianNs / 1000 >= budget) console.log(diag(r, budget))
    assertBudget(r, budget)
  })
})

describePerf('cache baseline: hashFile', () => {
  let tmpdir: string
  let cache: Cache
  let smallFile: string
  let largeFile: string

  beforeAll(async () => {
    tmpdir = await mkdtemp(path.join(os.tmpdir(), 'vx-perf-hashfile-'))
    cache = new Cache(path.join(tmpdir, '.vx-cache'))
    smallFile = path.join(tmpdir, 'small.txt')
    await writeFile(smallFile, 'x'.repeat(1024))
    largeFile = path.join(tmpdir, 'large.txt')
    await writeFile(largeFile, 'x'.repeat(1024 * 1024))
  })

  afterAll(async () => {
    cache.close()
    await rm(tmpdir, { recursive: true, force: true })
  })

  it('cold path (fresh 1KB file each call) — median < 8ms', async () => {
    // Each iteration creates a new file path so the mtime+size memo
    // can't hit. Measures the worst case: stat + read + xxh3 + INSERT.
    let i = 0
    const r = await bench(
      200,
      async () => {
        const f = path.join(tmpdir, `cold-${i++}.txt`)
        await writeFile(f, 'x'.repeat(1024))
        await cache.hashFile(f)
      },
      3,
    )
    const budget = budgetUs('hashFile cold 1KB', 8000)
    if (r.medianNs / 1000 >= budget) console.log(diag(r, budget))
    assertBudget(r, budget)
  })

  it('warm path (1KB, mtime+size fast-path hit) — median < 30µs', async () => {
    // Warm the row, then repeatedly hit it.
    await cache.hashFile(smallFile)
    const r = await bench(5000, async () => {
      await cache.hashFile(smallFile)
    })
    const budget = budgetUs('hashFile warm 1KB', 30)
    if (r.medianNs / 1000 >= budget) console.log(diag(r, budget))
    assertBudget(r, budget)
  })

  it('warm path (1MB, mtime+size fast-path hit) — median < 30µs', async () => {
    // Critically: the fast path returns the cached digest WITHOUT
    // reading the 1MB bytes. If this jumps to ~100µs+, someone broke
    // the fast-path early-return.
    await cache.hashFile(largeFile)
    const r = await bench(5000, async () => {
      await cache.hashFile(largeFile)
    })
    const budget = budgetUs('hashFile warm 1MB', 30)
    if (r.medianNs / 1000 >= budget) console.log(diag(r, budget))
    assertBudget(r, budget)
  })

  it('fast-path is meaningfully faster than cold path', async () => {
    // Relative check: catches "fast path accidentally degraded to
    // cold path" even if both paths slow down together. The threshold
    // here is deliberately loose (5×) because CI runners' file I/O
    // varies enough that a tighter ratio flakes — dev boxes see >100×.
    // 5× is enough to prove the mtime+size memo is still firing.
    // Min-of-3 interleaved: single-window ratios flake on shared runners.
    let i = 0
    const warmFile = path.join(tmpdir, 'rel-warm.txt')
    await writeFile(warmFile, 'x'.repeat(1024))
    await cache.hashFile(warmFile)
    const { aMinNs: coldMinNs, bMinNs: warmMinNs } = await benchRatioSides(
      () =>
        bench(
          100,
          async () => {
            const f = path.join(tmpdir, `rel-cold-${i++}.txt`)
            await writeFile(f, 'x'.repeat(1024))
            await cache.hashFile(f)
          },
          3,
        ),
      () => bench(2000, async () => void (await cache.hashFile(warmFile))),
    )
    const ratio = coldMinNs / warmMinNs
    expect(ratio).toBeGreaterThanOrEqual(5)
  })
})

describePerf('cache baseline: Cache.key', () => {
  let tmpdir: string
  let cache: Cache
  let baseInput: Parameters<Cache['key']>[0]

  async function makeInputFiles(label: string, n: number): Promise<string[]> {
    const dir = path.join(tmpdir, `inputs-${label}`)
    await mkdir(dir, { recursive: true })
    const files: string[] = []
    for (let i = 0; i < n; i++) {
      const f = path.join(dir, `f${i}.ts`)
      await writeFile(f, `export const x${i} = ${i};\n`)
      files.push(f)
    }
    // Pre-warm the fast-path memo.
    await Promise.all(files.map((f) => cache.hashFile(f)))
    return files
  }

  beforeAll(async () => {
    tmpdir = await mkdtemp(path.join(os.tmpdir(), 'vx-perf-key-'))
    cache = new Cache(path.join(tmpdir, '.vx-cache'))
    baseInput = {
      taskId: 'p#build',
      taskConfigHash: 'cfg',
      projectPackageJsonHash: 'pkg',
      envValues: [['NODE_ENV', 'production']],
      inputFiles: [],
      workspaceRoot: tmpdir,
      upstreamHashes: ['a', 'b', 'c'],
      workspaceFingerprint: 'fp',
      forwardArgs: [],
    }
  })

  afterAll(async () => {
    cache.close()
    await rm(tmpdir, { recursive: true, force: true })
  })

  it('empty inputs — median < 200µs', async () => {
    const r = await bench(2000, async () => {
      await cache.key({ ...baseInput, inputFiles: [] })
    })
    const budget = budgetUs('key empty', 200)
    if (r.medianNs / 1000 >= budget) console.log(diag(r, budget))
    assertBudget(r, budget)
  })

  it('10 files (warm) — median < 2ms', async () => {
    const files = await makeInputFiles('ten', 10)
    const r = await bench(1000, async () => {
      await cache.key({ ...baseInput, inputFiles: files })
    })
    const budget = budgetUs('key 10 files', 2000)
    if (r.medianNs / 1000 >= budget) console.log(diag(r, budget))
    assertBudget(r, budget)
  })

  it('100 files (warm) — median < 5ms', async () => {
    const files = await makeInputFiles('hundred', 100)
    const r = await bench(300, async () => {
      await cache.key({ ...baseInput, inputFiles: files })
    })
    const budget = budgetUs('key 100 files', 5000)
    if (r.medianNs / 1000 >= budget) console.log(diag(r, budget))
    assertBudget(r, budget)
  })

  it('1000 files (warm) — median < 35ms', async () => {
    const files = await makeInputFiles('thousand', 1000)
    const r = await bench(50, async () => {
      await cache.key({ ...baseInput, inputFiles: files })
    })
    const budget = budgetUs('key 1000 files', 35000)
    if (r.medianNs / 1000 >= budget) console.log(diag(r, budget))
    assertBudget(r, budget)
  })

  it('scales near-linearly in file count (1000 / 100 ratio ≤ 30×)', async () => {
    // The 100→1000 jump SHOULD be ~10× since `Cache.key` walks inputs
    // once. A ratio > 30 means quadratic blowup snuck in somewhere
    // (true quadratic reads ~100×). Min-of-3 interleaved — this guard
    // false-redded main twice on shared runners as a single-window ratio.
    const f100 = await makeInputFiles('lin-100', 100)
    const f1000 = await makeInputFiles('lin-1000', 1000)
    const { aMinNs, bMinNs } = await benchRatioSides(
      () => bench(50, async () => void (await cache.key({ ...baseInput, inputFiles: f100 }))),
      () => bench(20, async () => void (await cache.key({ ...baseInput, inputFiles: f1000 }))),
    )
    const ratio = bMinNs / aMinNs
    expect(ratio).toBeLessThanOrEqual(30)
  })
})

describePerf('cache baseline: save + restore', () => {
  let tmpdir: string
  let cache: Cache
  let projectDir: string
  let outFiles: string[]

  beforeAll(async () => {
    tmpdir = await mkdtemp(path.join(os.tmpdir(), 'vx-perf-saverestore-'))
    cache = new Cache(path.join(tmpdir, '.vx-cache'))
    projectDir = path.join(tmpdir, 'project')
    await mkdir(path.join(projectDir, 'dist'), { recursive: true })
    outFiles = []
    for (let i = 0; i < 10; i++) {
      const f = path.join(projectDir, 'dist', `out${i}.js`)
      await writeFile(f, `console.log(${i});\n`)
      outFiles.push(f)
    }
  })

  afterAll(async () => {
    cache.close()
    await rm(tmpdir, { recursive: true, force: true })
  })

  it('save (empty archive — no outputs) — median < 30ms', async () => {
    let i = 0
    const r = await bench(
      30,
      async () => {
        await cache.save({
          hash: `empty-${i++}`,
          entry: {
            taskId: 'p#build',
            command: 'noop',
            durationMs: 1,
            stdout: '',
          },
          projectDir,
          outputFiles: [],
        })
      },
      2,
    )
    const budget = budgetUs('save empty', 30000)
    if (r.medianNs / 1000 >= budget) console.log(diag(r, budget))
    assertBudget(r, budget)
  })

  it('save (10 small output files) — median < 30ms', async () => {
    let i = 0
    const r = await bench(
      30,
      async () => {
        await cache.save({
          hash: `out-${i++}`,
          entry: {
            taskId: 'p#build',
            command: 'noop',
            durationMs: 1,
            stdout: 'hello\n',
          },
          projectDir,
          outputFiles: outFiles,
        })
      },
      2,
    )
    const budget = budgetUs('save 10 outputs', 30000)
    if (r.medianNs / 1000 >= budget) console.log(diag(r, budget))
    assertBudget(r, budget)
  })

  it('get() never touches the artifact; only an actual restore decompresses', async () => {
    // Hit cost must not scale with artifact size: get() is pure SQL
    // (entries + output_files rows carry everything, stdout included
    // since schema v20). Decompression happens exactly once, inside
    // restoreOutputs, and only when extraction actually runs.
    await cache.save({
      hash: 'sd-hot',
      entry: {
        taskId: 'p#build',
        command: 'noop',
        durationMs: 1,
        stdout: 'hello from the build',
      },
      projectDir,
      outputFiles: outFiles,
    })

    const origDecompress = Bun.zstdDecompress
    let decompressCount = 0
    const bunMut = Bun as unknown as { zstdDecompress: typeof Bun.zstdDecompress }
    bunMut.zstdDecompress = ((input: Parameters<typeof Bun.zstdDecompress>[0]) => {
      decompressCount++
      return origDecompress(input)
    }) as typeof Bun.zstdDecompress
    try {
      decompressCount = 0
      const hit = await cache.get('sd-hot')
      expect(hit?.stdout).toBe('hello from the build') // served from SQL
      expect(hit?.outputFiles.length).toBeGreaterThan(0) // from output_files rows
      expect(decompressCount).toBe(0)

      const destA = path.join(tmpdir, 'sd-warm-A')
      await mkdir(destA, { recursive: true })
      await cache.restoreOutputs('sd-hot', destA)
      expect(decompressCount).toBe(1)
    } finally {
      bunMut.zstdDecompress = origDecompress
    }
  })

  it('save populates output_files rows; isOutputsCurrent matches on the restored tree', async () => {
    // v16: manifest data moved out of the tar into the SQLite
    // `output_files` table. Verify save() inserts rows and
    // isOutputsCurrent returns true after a cold restore (the tree
    // is then bit-identical to what save() recorded).
    await cache.save({
      hash: 'mf-direct',
      entry: {
        taskId: 'p#build',
        command: 'noop',
        durationMs: 1,
        stdout: '',
      },
      projectDir,
      outputFiles: outFiles,
    })

    // output_files rows exist for this entry.
    const rows = cache.loadOutputFilesBatch(['mf-direct']).get('mf-direct') ?? []
    expect(rows.length).toBe(outFiles.length)
    for (const r of rows) {
      expect(r.path.startsWith('dist/')).toBe(true)
      expect(r.size).toBeGreaterThan(0)
    }

    // Restore into a fresh dir; the tree is then bit-identical to
    // what save() recorded → isOutputsCurrent returns true.
    const dest = path.join(tmpdir, 'mf-direct-target')
    await mkdir(dest, { recursive: true })
    await cache.restoreOutputs('mf-direct', dest)
    expect(await cache.isOutputsCurrent(dest, rows)).toBe(true)

    // Corrupt one file → isOutputsCurrent flips to false.
    await Bun.write(path.join(dest, rows[0]!.path), 'tampered-different-size')
    expect(await cache.isOutputsCurrent(dest, rows)).toBe(false)
  })

  it('isOutputsCurrent catches a SAME-SIZE edit in the same SECOND (ms precision)', async () => {
    // The decision log carried "compares size+mode+second-mtime" as an open
    // item long after the check moved to millisecond precision with a
    // restore-time re-sync. Probed 2026-08-24: a same-size write landing in
    // the same SECOND but a different millisecond IS detected. This pins the
    // ms comparison so the closed gap cannot silently reopen — a stale hit
    // here replays wrong bytes under a green run.
    const { writeFile, utimes } = await import('node:fs/promises')
    await cache.save({
      hash: 'ms-precision',
      entry: { taskId: 'p#build', command: 'noop', durationMs: 1, stdout: '' },
      projectDir,
      outputFiles: [outFiles[0]!],
    })
    const rows = cache.loadOutputFilesBatch(['ms-precision']).get('ms-precision')!
    const dest = path.join(tmpdir, 'ms-precision-target')
    await mkdir(dest, { recursive: true })
    await cache.restoreOutputs('ms-precision', dest)
    expect(await cache.isOutputsCurrent(dest, rows)).toBe(true)

    // Same byte LENGTH, different content, written within the same second
    // (the write executes microseconds later; assert the precondition).
    const original = await Bun.file(path.join(dest, rows[0]!.path)).text()
    const sameSize = 'X'.repeat(original.length)
    await writeFile(path.join(dest, rows[0]!.path), sameSize)
    const s = await (await import('node:fs/promises')).stat(path.join(dest, rows[0]!.path))
    if (Math.floor(s.mtimeMs / 1000) === Math.floor(rows[0]!.mtimeMs / 1000)) {
      // precondition held: same second, different ms — must NOT be current
      expect(await cache.isOutputsCurrent(dest, rows)).toBe(false)
    }

    // The DOCUMENTED residual, pinned as the accepted trade rather than left
    // as folklore: a same-size edit with a FORGED identical mtime (touch -r)
    // passes — the blind spot every mtime-based skip check accepts (git's
    // index makes the same trade). If this ever flips to false, the check
    // grew content hashing and the comment + docs must change with it.
    await utimes(
      path.join(dest, rows[0]!.path),
      new Date(rows[0]!.mtimeMs),
      new Date(rows[0]!.mtimeMs),
    )
    expect(await cache.isOutputsCurrent(dest, rows)).toBe(true)
  })

  it('restoreOutputs round-trip via Cache: second restore touches no inodes', async () => {
    // End-to-end behavioral check: after a cold restore, set every
    // restored file's mtime/atime to a known-distant timestamp. A
    // second restoreOutputs() should skip every file (manifest match
    // on size + mode + mtime), so the timestamps stay where we set
    // them. If skip is broken, mtime moves to "now".
    const { stat, utimes } = await import('node:fs/promises')
    await cache.save({
      hash: 'e2e-mf',
      entry: {
        taskId: 'p#build',
        command: 'noop',
        durationMs: 1,
        stdout: '',
      },
      projectDir,
      outputFiles: outFiles,
    })

    const dest = path.join(tmpdir, 'e2e-mf-target')
    await mkdir(dest, { recursive: true })

    // Cold restore writes every file. Inspect one file's mtime —
    // it'll match the staged file's mtime (from save), NOT "now".
    await cache.restoreOutputs('e2e-mf', dest)
    const oneFile = path.join(dest, 'dist', 'out0.js')
    expect(await Bun.file(oneFile).exists()).toBe(true)
    const mtimeAfterCold = (await stat(oneFile)).mtimeMs

    // Wait > 1s so a re-write would produce a distinguishable
    // "now" mtime (utimes is seconds-resolution).
    await Bun.sleep(1100)

    // Second restore must skip — mtime unchanged means we didn't
    // write the file.
    await cache.restoreOutputs('e2e-mf', dest)
    const mtimeAfterSkip = (await stat(oneFile)).mtimeMs
    expect(Math.floor(mtimeAfterSkip / 1000)).toBe(Math.floor(mtimeAfterCold / 1000))

    // Negative control: corrupt the file. Third restore SHOULD
    // rewrite (size mismatch with manifest) and the mtime jumps to
    // the tar's stored mtime — same as mtimeAfterCold.
    await Bun.write(oneFile, 'corrupted-different-size')
    const corruptedSize = (await stat(oneFile)).size
    expect(corruptedSize).not.toBe((await stat(path.join(projectDir, 'dist', 'out0.js'))).size)
    await cache.restoreOutputs('e2e-mf', dest)
    const sizeAfterFix = (await stat(oneFile)).size
    expect(sizeAfterFix).not.toBe(corruptedSize)
    // (Use utimes import to keep the linter happy — utimes is the
    // implementation detail tested above via the timestamp invariant.)
    void utimes
  })

  it('restoreOutputs (10 small files) — median < 30ms', async () => {
    // Stage a single artifact, then restore it repeatedly into fresh
    // dirs so each iteration does real work (tar+zstd extract).
    await cache.save({
      hash: 'restore-fixture',
      entry: {
        taskId: 'p#build',
        command: 'noop',
        durationMs: 1,
        stdout: '',
      },
      projectDir,
      outputFiles: outFiles,
    })
    let i = 0
    const r = await bench(
      30,
      async () => {
        const dest = path.join(tmpdir, `restore-${i++}`)
        await mkdir(dest, { recursive: true })
        await cache.restoreOutputs('restore-fixture', dest)
      },
      2,
    )
    const budget = budgetUs('restore 10', 30000)
    if (r.medianNs / 1000 >= budget) console.log(diag(r, budget))
    assertBudget(r, budget)
  })
})

describePerf('cache baseline: SQLite writes', () => {
  let tmpdir: string
  let cache: Cache

  beforeAll(async () => {
    tmpdir = await mkdtemp(path.join(os.tmpdir(), 'vx-perf-runs-'))
    cache = new Cache(path.join(tmpdir, '.vx-cache'))
  })

  afterAll(async () => {
    cache.close()
    await rm(tmpdir, { recursive: true, force: true })
  })

  it('recordRun single — median < 5ms', async () => {
    let i = 0
    const r = await bench(
      200,
      () => {
        cache.recordRun({
          hash: `run-${i++}`,
          project: 'p',
          task: 'build',
          status: 'success',
          exitCode: 0,
          durationMs: 1,
          startedAt: Date.now(),
          endedAt: Date.now(),
        })
      },
      5,
    )
    const budget = budgetUs('recordRun', 5000)
    if (r.medianNs / 1000 >= budget) console.log(diag(r, budget))
    assertBudget(r, budget)
  })

  it('recordRuns batched (50 rows) — median < 30ms', async () => {
    let base = 100000
    const r = await bench(
      30,
      () => {
        const rows = Array.from({ length: 50 }, (_, j) => ({
          hash: `batch-${base + j}`,
          project: 'p',
          task: 'build',
          status: 'success' as const,
          exitCode: 0,
          durationMs: 1,
          startedAt: Date.now(),
          endedAt: Date.now(),
        }))
        base += 50
        cache.recordRuns(rows)
      },
      3,
    )
    const budget = budgetUs('recordRuns x50', 30000)
    if (r.medianNs / 1000 >= budget) console.log(diag(r, budget))
    assertBudget(r, budget)
  })

  it('batched recordRuns is ≥ 3× faster per row than single recordRun', async () => {
    // The batch path's win is one transaction vs N. Catches accidental
    // "for (r of rows) recordRun(r)" replacements. The bar isn't huge
    // because WAL + synchronous=NORMAL already amortizes fsync;
    // most of the savings come from transaction + lock overhead.
    // Min-of-3 interleaved: single-window ratios flake on loaded machines.
    let i = 200000
    let base = 300000
    const { aMinNs: singleMinNs, bMinNs: batchMinNs } = await benchRatioSides(
      () =>
        bench(
          100,
          () => {
            cache.recordRun({
              hash: `sb-${i++}`,
              project: 'p',
              task: 'build',
              status: 'success',
              exitCode: 0,
              durationMs: 1,
              startedAt: Date.now(),
              endedAt: Date.now(),
            })
          },
          3,
        ),
      () =>
        bench(
          20,
          () => {
            const rows = Array.from({ length: 50 }, (_, j) => ({
              hash: `bb-${base + j}`,
              project: 'p',
              task: 'build',
              status: 'success' as const,
              exitCode: 0,
              durationMs: 1,
              startedAt: Date.now(),
              endedAt: Date.now(),
            }))
            base += 50
            cache.recordRuns(rows)
          },
          3,
        ),
    )
    const perRowSingle = singleMinNs
    const perRowBatch = batchMinNs / 50
    expect(perRowSingle / perRowBatch).toBeGreaterThanOrEqual(3)
  })
})

describePerf('scanArtifact — foreign tar dialects', () => {
  /**
   * PAX extended-header records (typeflag 'x' / 'g') are what BSD tar —
   * the macOS default — emits per entry for xattrs and nanosecond
   * mtimes. A hand-rolled reader had to recognise and skip them or they
   * showed up as `PaxHeaders/<name>` junk files in restored trees; this
   * pins that the streaming reader skips them for an artifact produced
   * by some OTHER tar.
   *
   * The bytes are constructed directly rather than shelled out to,
   * because which dialect the host `tar` speaks is exactly the variable
   * under test.
   */
  function octal(n: number, width: number): string {
    return n.toString(8).padStart(width - 1, '0') + '\0'
  }

  function makeHeader(opts: {
    name: string
    size: number
    mode?: number
    typeFlag: string
  }): Uint8Array {
    const buf = new Uint8Array(512)
    const enc = new TextEncoder()
    enc.encodeInto(opts.name, buf.subarray(0, 100))
    enc.encodeInto(octal(opts.mode ?? 0o644, 8), buf.subarray(100, 108))
    enc.encodeInto(octal(0, 8), buf.subarray(108, 116))
    enc.encodeInto(octal(0, 8), buf.subarray(116, 124))
    enc.encodeInto(octal(opts.size, 12), buf.subarray(124, 136))
    enc.encodeInto(octal(0, 12), buf.subarray(136, 148))
    for (let i = 148; i < 156; i++) buf[i] = 0x20
    buf[156] = opts.typeFlag.charCodeAt(0)
    enc.encodeInto('ustar\0', buf.subarray(257, 263))
    enc.encodeInto('00', buf.subarray(263, 265))
    let cksum = 0
    for (let i = 0; i < 512; i++) cksum += buf[i]!
    enc.encodeInto(octal(cksum, 7), buf.subarray(148, 155))
    buf[155] = 0x20
    return buf
  }

  function makeDataBlock(bytes: Uint8Array): Uint8Array {
    const padded = Math.ceil(bytes.length / 512) * 512
    const out = new Uint8Array(padded)
    out.set(bytes, 0)
    return out
  }

  function concat(parts: Uint8Array[]): Uint8Array {
    const total = parts.reduce((n, p) => n + p.length, 0)
    const out = new Uint8Array(total)
    let off = 0
    for (const p of parts) {
      out.set(p, off)
      off += p.length
    }
    return out
  }

  it('reads past per-entry PAX records and yields only the real files', async () => {
    const paxBody = new TextEncoder().encode('30 mtime=1716913200.123456789\n')
    const realBody = new TextEncoder().encode('console.log("hi")\n')

    const { entries } = await scanArtifact(
      streamOf(
        concat([
          makeHeader({ name: 'PaxHeaders/main.js', size: paxBody.length, typeFlag: 'x' }),
          makeDataBlock(paxBody),
          makeHeader({ name: 'outputs/main.js', size: realBody.length, typeFlag: '0' }),
          makeDataBlock(realBody),
          new Uint8Array(1024),
        ]),
      ),
    )

    expect(entries.map((e) => e.name)).toEqual(['outputs/main.js'])
    expect(entries[0]!.size).toBe(realBody.length)
    // No sidecar in a foreign artifact: a readable-but-not-executable
    // default, never a failure to produce the bytes.
    expect(entries[0]!.mode).toBe(0o644)
  })

  it('reads past a global PAX record (typeflag g) too', async () => {
    const globalPax = new TextEncoder().encode('25 comment=globaljunk\n')
    const realBody = new TextEncoder().encode('x')
    const { entries } = await scanArtifact(
      streamOf(
        concat([
          makeHeader({ name: 'pax_global_header', size: globalPax.length, typeFlag: 'g' }),
          makeDataBlock(globalPax),
          makeHeader({ name: 'outputs/a.txt', size: realBody.length, typeFlag: '0' }),
          makeDataBlock(realBody),
          new Uint8Array(1024),
        ]),
      ),
    )
    expect(entries.map((e) => e.name)).toEqual(['outputs/a.txt'])
  })
})
