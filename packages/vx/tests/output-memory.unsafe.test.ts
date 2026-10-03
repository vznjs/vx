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
const LOGGER = path.join(import.meta.dir, '..', 'src', 'orchestrator', 'logger.ts')
const RUNNER = path.join(import.meta.dir, '..', 'src', 'exec', 'runner.ts')

/** Run a probe script, awaited, and read back the `heap_mib=<n>` it prints. */
async function probeHeapMibAsync(script: string): Promise<number> {
  const p = Bun.spawn({ cmd: ['bun', '-e', script], stdout: 'pipe', stderr: 'pipe' })
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ])
  const m = /heap_mib=(\d+)/.exec(out)
  if (m === null) throw new Error(`probe produced no measurement (exit ${code}): ${out}${err}`)
  return Number(m[1])
}

const CHUNK_BYTES = 4 * 1024 * 1024
const FEW_CHUNKS = 20
const MANY_CHUNKS = 60
/** Extra bytes the many-chunk run feeds over the few-chunk one. */
const EXTRA_MIB = ((MANY_CHUNKS - FEW_CHUNKS) * CHUNK_BYTES) / 1024 / 1024

/**
 * Feed `chunks` distinct multi-MB chunks through `defaultLogger` in one view
 * mode and report the heap after a full collection while the task is still in
 * flight — what the logger's per-task buffers retain. The chunks are built
 * inline so the probe itself retains none of them.
 */
function loggerProbe(mode: string, chunks: number): string {
  return `
    import { defaultLogger } from ${JSON.stringify(LOGGER)}
    const log = defaultLogger({ enabled: false }, { mode: ${JSON.stringify(mode)} }, { write: () => true })
    const node = { id: 'p#t', projectName: 'p', taskName: 't', requested: false, surfaced: false, deps: [], config: { exec: { command: 'noop' } } }
    for (let i = 0; i < ${chunks}; i++) log.taskStdout(node, i + ':' + 'x'.repeat(${CHUNK_BYTES}))
    Bun.gc(true)
    if (log === undefined) throw new Error('unreachable')
    console.log('heap_mib=' + Math.round(process.memoryUsage().heapUsed / 1024 / 1024))
  `
}

describe('logger per-task buffering', () => {
  it(
    '`none` discards chunks on arrival; the printing modes still buffer them',
    async () => {
      // Assert on how the retained heap RESPONDS TO VOLUME, read after a full
      // collection. RSS was the allocator's high-water of the chunks the probe
      // builds, which JSC does not hand back: it passed at 85 vs 201 MiB here,
      // failed at 129 vs 206 on a CI runner, and reached 88 against an 80 MiB
      // line under a full gate (2026-09-20) before a min-of-2 reading papered
      // over it. The heap after `Bun.gc(true)` is exact: `full` 81 → 241 MiB,
      // `none` and `hash-only` 1 → 1 (M-53).
      //
      // The control runs FIRST so a harness that measured nothing would show it
      // here rather than passing vacuously on the bounded side.
      const fullFew = await probeHeapMibAsync(loggerProbe('full', FEW_CHUNKS))
      const fullMany = await probeHeapMibAsync(loggerProbe('full', MANY_CHUNKS))
      const flatDelta = async (mode: string): Promise<number> =>
        (await probeHeapMibAsync(loggerProbe(mode, MANY_CHUNKS))) -
        (await probeHeapMibAsync(loggerProbe(mode, FEW_CHUNKS)))

      // `full` prints this output, so it must still hold it — the deliberate
      // boundary, not an oversight: silently truncating a build log is worse
      // than the memory. Pinned so a future "bound everything" change has to
      // argue with this line. It grows with the volume it is holding.
      expect(fullMany - fullFew).toBeGreaterThan(EXTRA_MIB * 0.5)

      // `none` guarantees "no per-task output at all", so it must not pay for
      // output it will never print: tripling the volume must not move it.
      // Retention costs the FULL 160 MiB, 4× this line.
      expect(await flatDelta('none')).toBeLessThan(EXTRA_MIB * 0.25)

      // `hash-only` is the OTHER half of the same boundary — the set is
      // exactly {none, hash-only}, the two modes whose contract promises
      // never to print task output — and only `none` was asserted, so
      // dropping `hash-only` from `discardsOutput` left the whole repo
      // green. It prints one audit line per task and no log bytes ever,
      // so no behaviour row can see it retain them; this measurement is
      // the only thing that can.
      expect(await flatDelta('hash-only')).toBeLessThan(EXTRA_MIB * 0.25)
    },
    TIMEOUT,
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
      command: 'head -c ' + (${mib} * 1024 * 1024) + ' /dev/zero | tr "\\\\0" "a"',
      cwd: process.cwd(),
      env: process.env,
      capture: { stdout: ${retain}, stderr: ${retain} },
    })
    if (r.exitCode !== 0) throw new Error('probe exited ' + r.exitCode)
    // The heap after a full collection is what the result retains; RSS was
    // the allocator's high-water of the chunks pushed through, which a
    // loaded reader raised to 122 MiB of noise against a 120 MiB line (M-53).
    Bun.gc(true)
    // Reference the result past the collection so a retained string cannot
    // be freed before the measurement: the control would read flat too.
    if (r.stdout.length < 0) throw new Error('unreachable')
    console.log('heap_mib=' + Math.round(process.memoryUsage().heapUsed / 1024 / 1024))
  `
}

const CAP_FEW_MIB = 40
const CAP_MANY_MIB = 160
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
      // 120 MiB the child writes must not cost the extra 120 MiB. Measured
      // 17 → 17 MiB (the two 8 MiB ends); full retention costs the whole
      // 120, 4× this line. `tests/capture-cap.test.ts` pins that the head
      // and the tail are still there.
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
