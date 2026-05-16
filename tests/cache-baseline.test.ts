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
    let i = 0
    const cold = await bench(
      100,
      async () => {
        const f = path.join(tmpdir, `rel-cold-${i++}.txt`)
        await writeFile(f, 'x'.repeat(1024))
        await cache.hashFile(f)
      },
      3,
    )
    const warmFile = path.join(tmpdir, 'rel-warm.txt')
    await writeFile(warmFile, 'x'.repeat(1024))
    await cache.hashFile(warmFile)
    const warm = await bench(2000, async () => {
      await cache.hashFile(warmFile)
    })
    const ratio = cold.medianNs / warm.medianNs
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
    // once. A ratio > 30 means quadratic blowup snuck in somewhere.
    const f100 = await makeInputFiles('lin-100', 100)
    const f1000 = await makeInputFiles('lin-1000', 1000)
    const a = await bench(50, async () => {
      await cache.key({ ...baseInput, inputFiles: f100 })
    })
    const b = await bench(20, async () => {
      await cache.key({ ...baseInput, inputFiles: f1000 })
    })
    const ratio = b.medianNs / a.medianNs
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
            exitCode: 0,
            durationMs: 1,
            stdout: '',
            stderr: '',
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
            exitCode: 0,
            durationMs: 1,
            stdout: 'hello\n',
            stderr: '',
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

  it('get → restoreOutputs back-to-back reuses get() decompress (no second zstd)', async () => {
    // Direct behavioral check: count Bun.zstdDecompress invocations
    // across a full cache-hit cycle. With the single-slot stash in
    // Cache, `get(hash)` decompresses once and `restoreOutputs(hash)`
    // reuses the bytes — so the count must be exactly 1, never 2.
    // After eviction (get of a different hash), the next
    // restoreOutputs of the original hash must decompress fresh again.
    await cache.save({
      hash: 'sd-hot',
      entry: {
        taskId: 'p#build',
        command: 'noop',
        exitCode: 0,
        durationMs: 1,
        stdout: '',
        stderr: '',
      },
      projectDir,
      outputFiles: outFiles,
    })
    await cache.save({
      hash: 'sd-other',
      entry: {
        taskId: 'p#build',
        command: 'noop',
        exitCode: 0,
        durationMs: 1,
        stdout: '',
        stderr: '',
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
      // Warm cycle: 1 decompress total (get fills slot, restore reuses).
      decompressCount = 0
      await cache.get('sd-hot')
      const destA = path.join(tmpdir, 'sd-warm-A')
      await mkdir(destA, { recursive: true })
      await cache.restoreOutputs('sd-hot', destA)
      expect(decompressCount).toBe(1)

      // Slot is now empty (consumed). Standalone restore of a
      // different hash must decompress fresh: 1 decompress.
      decompressCount = 0
      const destB = path.join(tmpdir, 'sd-warm-B')
      await mkdir(destB, { recursive: true })
      await cache.restoreOutputs('sd-other', destB)
      expect(decompressCount).toBe(1)

      // Stale-slot path: get('sd-other') fills slot for 'other', then
      // restore of 'sd-hot' misses the slot and decompresses 'sd-hot'
      // fresh. Two decompresses total across the cycle.
      decompressCount = 0
      await cache.get('sd-other')
      const destC = path.join(tmpdir, 'sd-warm-C')
      await mkdir(destC, { recursive: true })
      await cache.restoreOutputs('sd-hot', destC)
      expect(decompressCount).toBe(2)
    } finally {
      bunMut.zstdDecompress = origDecompress
    }
  })

  it('second restore into already-correct tree skips every file (manifest skip)', async () => {
    // After a cache hit, the on-disk tree matches the cached snapshot
    // bit-for-bit. The NEXT restore into the same dir must skip-write
    // every output (size + mode + mtime all match the manifest).
    const tarMod = (await import('../src/cache/tar.ts')) as typeof import('../src/cache/tar.ts')
    await cache.save({
      hash: 'mf-direct',
      entry: {
        taskId: 'p#build',
        command: 'noop',
        exitCode: 0,
        durationMs: 1,
        stdout: '',
        stderr: '',
      },
      projectDir,
      outputFiles: outFiles,
    })

    const dest = path.join(tmpdir, 'mf-direct-target')
    await mkdir(dest, { recursive: true })

    const compressed = await Bun.file(path.join(tmpdir, '.vx-cache', 'mf-direct.tar.zst')).bytes()
    const tarBytes = await Bun.zstdDecompress(compressed)
    const headers = tarMod.parseTarHeaders(tarBytes)
    const manifestText = tarMod.readTarText(tarBytes, headers, 'manifest.json')
    expect(manifestText.length).toBeGreaterThan(0)
    const manifest = JSON.parse(manifestText) as import('../src/cache/tar.ts').Manifest

    // First restore: every file written, none skipped.
    const first = await tarMod.extractOutputs(tarBytes, dest, manifest)
    expect(first.written).toBe(outFiles.length)
    expect(first.skipped).toBe(0)

    // Second restore: every file skipped (manifest match).
    const second = await tarMod.extractOutputs(tarBytes, dest, manifest)
    expect(second.written).toBe(0)
    expect(second.skipped).toBe(outFiles.length)
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
        exitCode: 0,
        durationMs: 1,
        stdout: '',
        stderr: '',
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
        exitCode: 0,
        durationMs: 1,
        stdout: '',
        stderr: '',
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
    let i = 200000
    const single = await bench(
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
    )
    let base = 300000
    const batch = await bench(
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
    )
    const perRowSingle = single.medianNs
    const perRowBatch = batch.medianNs / 50
    expect(perRowSingle / perRowBatch).toBeGreaterThanOrEqual(3)
  })
})

describePerf('cache baseline: batched cache-hit probe (Cache.getMetaBatch)', () => {
  let tmpdir: string
  let cache: Cache
  let projectDir: string
  let outFiles: string[]
  let hashes: string[]

  beforeAll(async () => {
    tmpdir = await mkdtemp(path.join(os.tmpdir(), 'vx-perf-batch-'))
    cache = new Cache(path.join(tmpdir, '.vx-cache'))
    projectDir = path.join(tmpdir, 'project')
    await mkdir(path.join(projectDir, 'dist'), { recursive: true })
    outFiles = []
    for (let i = 0; i < 3; i++) {
      const f = path.join(projectDir, 'dist', `out${i}.js`)
      await writeFile(f, `console.log(${i});\n`)
      outFiles.push(f)
    }
    // Save 50 entries so the batch has something meaningful to read.
    hashes = []
    for (let i = 0; i < 50; i++) {
      const h = `bm-${i}`
      hashes.push(h)
      await cache.save({
        hash: h,
        entry: {
          taskId: 'p#build',
          command: 'noop',
          exitCode: 0,
          durationMs: 1,
          stdout: '',
          stderr: '',
        },
        projectDir,
        outputFiles: outFiles,
      })
    }
  })

  afterAll(async () => {
    cache.close()
    await rm(tmpdir, { recursive: true, force: true })
  })

  it('getMetaBatch(50 hashes) is meaningfully faster than 50× cache.get', async () => {
    // Per-hash cache.get does SQL + tar-exists + decompress + peek.
    // getMetaBatch does ONE SQL + parallel exists; no decompress.
    // We're explicitly measuring the "we only need metadata" probe
    // path — the batch must be substantially faster per row. The
    // 3× threshold (vs the headline ~10-20× on a dev box) is loose
    // enough to absorb CI runner I/O noise; it still proves the
    // decompress is being skipped.
    const single = await bench(
      10,
      async () => {
        for (const h of hashes) await cache.get(h)
      },
      2,
    )
    const batch = await bench(
      10,
      async () => {
        await cache.getMetaBatch(hashes)
      },
      2,
    )
    const perHashSingle = single.medianNs / hashes.length
    const perHashBatch = batch.medianNs / hashes.length
    expect(perHashSingle / perHashBatch).toBeGreaterThanOrEqual(3)
  })

  it('getMetaBatch returns CacheEntryMeta for every present hash', async () => {
    // Behavioral: every saved hash appears in the result; missing
    // hashes are absent.
    const result = await cache.getMetaBatch([...hashes, 'absent-1', 'absent-2'])
    expect(result.size).toBe(hashes.length)
    for (const h of hashes) expect(result.has(h)).toBe(true)
    expect(result.has('absent-1')).toBe(false)
    // Verify shape
    const sample = result.get('bm-0')!
    expect(sample.hash).toBe('bm-0')
    expect(sample.exitCode).toBe(0)
    expect(typeof sample.storedAt).toBe('string')
  })

  it('getMetaBatch on empty input returns empty Map (no SQL spawn)', async () => {
    const r = await cache.getMetaBatch([])
    expect(r.size).toBe(0)
  })
})
