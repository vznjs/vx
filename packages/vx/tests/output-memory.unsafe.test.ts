// Memory invariants of the output layer.
//
// Both cases here are peak-RSS claims, so they are measured in a CHILD
// process: RSS never comes back down inside one process, so two modes
// measured in the same process would only ever report which ran first.
// Each child feeds a known volume through one surface and prints its own
// RSS; the assertions are DIFFERENTIAL — the bounded shape against the
// unbounded one, on the same machine, in the same test run — so they do
// not encode this container's absolute numbers.
//
// `.unsafe` (item 925): three times on Linux CI a shard hosting this file
// under the sandbox ended with no failed row, its last line strace's own
// `ptrace(PTRACE_LISTEN…): Input/output error`, each time right after the
// stream-capture row, where the four concurrent floods start and are
// SIGKILLed. A traced task's exit code is strace's, so strace's internal
// failure was the shard's. Not reproduced locally (11 runs, bare and
// sandboxed); what the flood does to strace is unproven. Nothing here
// needs the sandbox: every row is a child's RSS.

import path from 'node:path'
import { beforeAll, describe, expect, it } from 'bun:test'

const TIMEOUT = 60_000
const LOGGER = path.join(import.meta.dir, '..', 'src', 'report', 'logger.ts')
const RUNNER = path.join(import.meta.dir, '..', 'src', 'exec', 'runner.ts')
const CACHE = path.join(import.meta.dir, '..', 'src', 'cache', 'index.ts')

/** Run a probe script, awaited, and read back the `heap_mib=<n>` it prints. */
async function probeHeapMibAsync(script: string): Promise<number> {
  return Number(/heap_mib=(\d+)/.exec(await probeOut(script))![1])
}

/** What a probe script printed, once it printed a measurement. */
async function probeOut(script: string): Promise<string> {
  const p = Bun.spawn({ cmd: ['bun', '-e', script], stdout: 'pipe', stderr: 'pipe' })
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ])
  if (!out.includes('heap_mib='))
    throw new Error(`probe produced no measurement (exit ${code}): ${out}${err}`)
  return out
}

const CHUNK_BYTES = 4 * 1024 * 1024
const FEW_CHUNKS = 20
const MANY_CHUNKS = 60
/** Extra bytes the many-chunk run feeds over the few-chunk one. */
const EXTRA_MIB = ((MANY_CHUNKS - FEW_CHUNKS) * CHUNK_BYTES) / 1024 / 1024

/**
 * Feed `chunks` distinct multi-MB chunks through `defaultLogger` in one view
 * mode and report the heap after a full collection: while the task is still
 * in flight (`at: 'running'`), or once it failed and its frame waits for the
 * run's end (`at: 'deferred'`). The chunks are built inline so the probe
 * itself retains none of them.
 */
function loggerProbe(mode: string, chunks: number, at: 'running' | 'deferred' = 'running'): string {
  return `
    import { defaultLogger } from ${JSON.stringify(LOGGER)}
    const log = defaultLogger({ enabled: false }, { mode: ${JSON.stringify(mode)} }, { write: () => true })
    const node = { id: 'p#t', projectName: 'p', taskName: 't', requested: false, surfaced: false, deps: [], config: { exec: { command: 'noop' } } }
    for (let i = 0; i < ${chunks}; i++) log.taskStdout(node, i + ':' + 'x'.repeat(${CHUNK_BYTES}))
    if (${JSON.stringify(at)} === 'deferred') log.taskComplete(node, { node, status: 'failed', exitCode: 1, durationMs: 1 })
    Bun.gc(true)
    if (log === undefined) throw new Error('unreachable')
    const { readdirSync } = await import('node:fs')
    console.log('fds=' + readdirSync('/dev/fd').length)
    console.log('heap_mib=' + Math.round(process.memoryUsage().heapUsed / 1024 / 1024))
  `
}

describe('logger per-task output', () => {
  it(
    "no mode holds a task's output in memory: it waits in a file",
    async () => {
      // Assert on how the retained heap RESPONDS TO VOLUME, read after a full
      // collection. RSS was the allocator's high-water of the chunks the probe
      // builds, which JSC does not hand back. The heap after `Bun.gc(true)` is
      // exact: before the file (M, 2026-11-25) `full` and `errors-only` held
      // every chunk, 81 → 241 MiB, and a failure's frame until the run's end.
      const flatDelta = async (mode: string, at?: 'deferred'): Promise<number> =>
        (await probeHeapMibAsync(loggerProbe(mode, MANY_CHUNKS, at))) -
        (await probeHeapMibAsync(loggerProbe(mode, FEW_CHUNKS, at)))

      // Retention costs the FULL 160 MiB, 4× each line. The printing modes
      // keep the output in a file; a failed task's frame waits for the run's
      // end in one too.
      for (const [mode, at] of [
        ['full'],
        ['errors-only'],
        ['none'],
        ['hash-only'],
        ['errors-only', 'deferred'],
      ] as const)
        expect([mode, at, await flatDelta(mode, at)]).toSatisfy(
          ([, , delta]) => (delta as number) < EXTRA_MIB * 0.25,
        )

      // `none` and `hash-only` promise never to print task output, so a chunk
      // is dropped on arrival, not even written to a file: dropping
      // `hash-only` from `discardsOutput` once left the whole repo green. The
      // file is the one descriptor `full` holds that they do not.
      const fds = async (mode: string): Promise<number> =>
        Number(/fds=(\d+)/.exec(await probeOut(loggerProbe(mode, 2)))![1])
      const none = await fds('none')
      expect(await fds('full')).toBe(none + 1)
      expect(await fds('hash-only')).toBe(none)
    },
    TIMEOUT * 2,
  )
})

/**
 * Feed `mib` megabytes through `runCommand` and report RSS while the result
 * is still referenced — i.e. the peak `RunResult.stdout` is responsible for.
 * `retain` drives the `capture` option both ways.
 */
function capturedProbe(retain: boolean, mib: number): string {
  return `
    import { runCommand } from ${JSON.stringify(RUNNER)}
    const r = await runCommand({
      // No \`tr\` to make the bytes printable: it cost ten times what \`head\`
      // does here, and one more process per probe on a shared runner; the
      // claim is about volume, which NUL bytes carry the same (both 8-bit).
      command: 'head -c ' + (${mib} * 1024 * 1024) + ' /dev/zero',
      cwd: process.cwd(),
      env: process.env,
      capture: { stdout: ${retain}, stderr: ${retain} },
    })
    if (r.exitCode !== 0) throw new Error('probe exited ' + r.exitCode)
    // The heap after a full collection is what the result retains; RSS was
    // the allocator's high-water of the chunks pushed through, which a
    // loaded reader raised to 122 MiB of noise against a 120 MiB line (M-53).
    // A turn first: the reader's own turns (READER_TURN_MS) left a dead
    // 16 MiB string the stack scan still found, 1 in 8 runs (49 MiB, 33 after
    // one turn), which is no retention.
    await new Promise((resolve) => setTimeout(resolve, 0))
    Bun.gc(true)
    // Reference the result past the collection so a retained string cannot
    // be freed before the measurement: the control would read flat too.
    if (r.stdout.length < 0) throw new Error('unreachable')
    console.log('heap_mib=' + Math.round(process.memoryUsage().heapUsed / 1024 / 1024))
  `
}

// 40 → 160 MiB, sequentially through four probes, outran the 60 s timeout on
// a macOS runner holding six workers on three cores; the 4× margin over each
// line below rests on the ratio of volumes, not on their size.
const CAP_FEW_MIB = 20
const CAP_MANY_MIB = 80
const CAP_EXTRA_MIB = CAP_MANY_MIB - CAP_FEW_MIB

describe('runCommand stream capture', () => {
  it(
    'an opted-down stream does not grow with the volume the child writes',
    async () => {
      // Assert on how the retained heap RESPONDS TO VOLUME, never on an
      // absolute figure. The retaining control runs FIRST, so a harness that
      // measured nothing fails here rather than passing vacuously on the
      // opted-down side.
      const keepFew = await probeHeapMibAsync(capturedProbe(true, CAP_FEW_MIB))
      const keepMany = await probeHeapMibAsync(capturedProbe(true, CAP_MANY_MIB))
      const dropFew = await probeHeapMibAsync(capturedProbe(false, CAP_FEW_MIB))
      const dropMany = await probeHeapMibAsync(capturedProbe(false, CAP_MANY_MIB))

      // Retaining is the documented default, and since 2026-09-16 what it
      // retains is BOUNDED (a head and a tail, `CAPTURE_*_CHARS`): the extra
      // 60 MiB the child writes must not cost the extra 60 MiB. Measured
      // 17 → 17 MiB (the two 8 MiB ends); full retention costs the whole
      // 60, 4× this line; 20 MiB still fills both ends.
      // `tests/capture-cap.test.ts` pins that the head and the tail are still
      // there.
      expect(keepMany - keepFew).toBeLessThan(CAP_EXTRA_MIB * 0.25)

      // Opted down, the stream is still fully drained, just not retained:
      // measured 1 → 1 MiB.
      expect(dropMany - dropFew).toBeLessThan(CAP_EXTRA_MIB * 0.25)
      // With retention bounded, volume alone cannot tell a dropped stream
      // from a kept one (a capture that ignored `false` held 17 → 17 and
      // passed the line above), so the opted-down side must hold less than
      // one 8 MiB end below what the retaining side holds.
      expect(keepFew - dropMany).toBeGreaterThan(8)
    },
    TIMEOUT,
  )
})

/**
 * Save `entries` hits whose logs are 4 MiB each, then probe them all in one
 * batch from a fresh `Cache`, as a warm run's short-circuit does, and report
 * the heap while the answers are still held. Half the logs compress to a few
 * hundred bytes, which the probe loads with the entry, and half barely
 * compress, which it leaves in the index: both must stay unread. `read`
 * takes every log too, the control: what holding them costs.
 */
function replayProbe(entries: number, read: boolean): string {
  return `
    import { randomBytes } from 'node:crypto'
    import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
    import os from 'node:os'
    import path from 'node:path'
    import { Cache } from ${JSON.stringify(CACHE)}
    const root = mkdtempSync(path.join(os.tmpdir(), 'vx-replay-memory-'))
    try {
      const projectDir = path.join(root, 'p')
      mkdirSync(projectDir)
      writeFileSync(path.join(projectDir, 'out.txt'), 'x')
      const hashes = Array.from({ length: ${entries} }, (_, i) => 'h' + i)
      const saving = new Cache(path.join(root, 'cache'))
      for (const [i, hash] of hashes.entries()) {
        const body = i % 2 === 0 ? 'x'.repeat(${CHUNK_BYTES}) : randomBytes(${CHUNK_BYTES / 2}).toString('hex')
        await saving.save({
          hash,
          projectDir,
          outputFiles: [path.join(projectDir, 'out.txt')],
          entry: { taskId: 'p#' + hash, command: 'c', durationMs: 1, stdout: hash + ':' + body },
        })
      }
      saving.close()
      const cache = new Cache(path.join(root, 'cache'))
      const hits = await cache.getMany(hashes)
      if (hits.size !== ${entries}) throw new Error('probe found ' + hits.size + ' hits')
      const logs = ${read} ? [...hits.values()].map((e) => e.stdout) : []
      Bun.gc(true)
      if (hits.size + logs.length < 0) throw new Error('unreachable')
      console.log('heap_mib=' + Math.round(process.memoryUsage().heapUsed / 1024 / 1024))
      cache.close()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  `
}

const REPLAY_FEW = 10
const REPLAY_MANY = 40
const REPLAY_EXTRA_MIB = ((REPLAY_MANY - REPLAY_FEW) * CHUNK_BYTES) / 1024 / 1024

describe('cache hit replay', () => {
  it(
    'a batched probe holds no log: each is read when its hit replays',
    async () => {
      // A warm all-hit run probes every key in one batch, then replays the
      // hits as the scheduler reaches them. The batch held each hit's
      // decompressed log until its replay: 500 tasks printing 1 MiB peaked
      // at 3.4 GB RSS warm against 358 MB cold.
      //
      // The control runs FIRST: holding the logs grows with their volume.
      const readFew = await probeHeapMibAsync(replayProbe(REPLAY_FEW, true))
      const readMany = await probeHeapMibAsync(replayProbe(REPLAY_MANY, true))
      expect(readMany - readFew).toBeGreaterThan(REPLAY_EXTRA_MIB * 0.5)

      const heldFew = await probeHeapMibAsync(replayProbe(REPLAY_FEW, false))
      const heldMany = await probeHeapMibAsync(replayProbe(REPLAY_MANY, false))
      expect(heldMany - heldFew).toBeLessThan(REPLAY_EXTRA_MIB * 0.25)
    },
    TIMEOUT,
  )
})

/**
 * A persistent task whose `readyWhen` never matches, with no `exec.timeout`,
 * writing as fast as the shell can — the one task kind nothing bounds, since
 * a one-shot command's output ends when it exits.
 *
 * This probe drives `runPersistent` with NO logger attached, so it measures
 * what the RUNNER itself retains. That is now only the ready-matcher's
 * `fragment`, and the line shapes exercise it differently: `\n` and `\r`
 * (a progress bar) both end a line the matcher discards, while output with
 * no break at all is one endless line, which only the window bounds.
 */
function persistentProbe(seconds: number, terminator: '\\n' | '\\r' | ''): string {
  const printf = `%0200d${terminator === '' ? '' : `\\${terminator}`}`
  return `
    import { runPersistent } from ${JSON.stringify(RUNNER)}
    const spawned = runPersistent({
      command: "awk 'BEGIN{ for(;;) printf \\"${printf}\\", 1 }'",
      cwd: process.cwd(),
      env: process.env,
      readyWhen: 'NEVER-MATCHES-THIS-TOKEN',
    })
    spawned.ready.catch(() => {})
    await Bun.sleep(${seconds * 1000})
    spawned.child.kill('SIGKILL')
    // What the runner retains, not what the allocator holds: a 1 s probe's
    // RSS read 81 MiB beside eight busy loops and 41 idle, and a 3 s one
    // grew 82 MiB once, past the bound, with nothing retained (M-30).
    Bun.gc(true)
    const { heapStats } = await import('bun:jsc')
    const { heapSize, extraMemorySize } = heapStats()
    console.log('heap_mib=' + Math.round((heapSize + extraMemorySize) / 1024 / 1024))
    process.exit(0)
  `
}

describe('persistent task pre-ready buffering', () => {
  // The six floods run CONCURRENTLY: each is a fixed-duration child (1 s and
  // 3 s per line shape), so in sequence the file spent 8 s waiting, and the
  // claim — the retained heap does not grow with the duration — is about each child's own
  // bounded capture, not about throughput, so sharing the cores changes
  // nothing it asserts.
  const shapes = [
    ['newline-terminated', '\\n'],
    ['carriage-return only', '\\r'],
    ['no line break', ''],
  ] as const
  const readings = new Map<string, { short: number; long: number }>()
  beforeAll(async () => {
    const all = await Promise.all(
      shapes.flatMap(([, terminator]) => [
        probeHeapMibAsync(persistentProbe(1, terminator)),
        probeHeapMibAsync(persistentProbe(3, terminator)),
      ]),
    )
    shapes.forEach(([name], i) => readings.set(name, { short: all[i * 2]!, long: all[i * 2 + 1]! }))
  }, TIMEOUT)

  for (const [name] of shapes) {
    it(
      `stays flat while a never-ready task floods stdout (${name})`,
      () => {
        const { short, long } = readings.get(name)!
        // Unbounded growth ran ~100 MiB/s — through the real CLI, 6 s
        // measured 651 MiB (`\n`) and 488 MiB (`\r`) against ~280/370 MiB at
        // 2 s. A bounded capture makes the two durations indistinguishable,
        // so assert on the DIFFERENCE: it does not encode a machine's speed.
        // The heap after a full GC reads 1-2 MiB here at either duration, and
        // 180-1,290 MiB with every chunk kept (M-30).
        expect(long - short).toBeLessThan(64)
        expect(long).toBeLessThan(256)
      },
      TIMEOUT,
    )
  }
})
