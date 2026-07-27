// Memory invariants of the output layer.
//
// Both cases here are peak-RSS claims, so they are measured in a CHILD
// process: RSS never comes back down inside one process, so two modes
// measured in the same process would only ever report which ran first.
// Each child feeds a known volume through one surface and prints its own
// RSS; the assertions are DIFFERENTIAL — the bounded shape against the
// unbounded one, on the same machine, in the same test run — so they do
// not encode this container's absolute numbers.

import path from 'node:path'
import { describe, expect, it } from 'bun:test'

const TIMEOUT = 60_000
const LOGGER = path.join(import.meta.dir, '..', 'src', 'orchestrator', 'logger.ts')
const RUNNER = path.join(import.meta.dir, '..', 'src', 'exec', 'runner.ts')

/** Run a probe script and read back the `rss_mib=<n>` it prints. */
function probeRssMib(script: string): number {
  const p = Bun.spawnSync({
    cmd: ['bun', '-e', script],
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const out = new TextDecoder().decode(p.stdout)
  const err = new TextDecoder().decode(p.stderr)
  const m = /rss_mib=(\d+)/.exec(out)
  if (m === null)
    throw new Error(`probe produced no measurement (exit ${p.exitCode}): ${out}${err}`)
  return Number(m[1])
}

const CHUNK_BYTES = 4 * 1024 * 1024
const FEW_CHUNKS = 20
const MANY_CHUNKS = 60
/** Extra bytes the many-chunk run feeds over the few-chunk one. */
const EXTRA_MIB = ((MANY_CHUNKS - FEW_CHUNKS) * CHUNK_BYTES) / 1024 / 1024

/**
 * Feed `chunks` distinct multi-MB chunks through `defaultLogger` in one view
 * mode and report the process RSS while the task is still in flight — i.e.
 * the peak the logger's per-task buffers are responsible for. The chunks are
 * built inline so the probe itself retains none of them.
 */
function loggerProbe(mode: string, chunks: number): string {
  return `
    import { defaultLogger } from ${JSON.stringify(LOGGER)}
    const log = defaultLogger({ enabled: false }, { mode: ${JSON.stringify(mode)} }, { write: () => true })
    const node = { id: 'p#t', projectName: 'p', taskName: 't', requested: false, surfaced: false, deps: [], config: { exec: { command: 'noop' } } }
    for (let i = 0; i < ${chunks}; i++) log.taskStdout(node, i + ':' + 'x'.repeat(${CHUNK_BYTES}))
    console.log('rss_mib=' + Math.round(process.memoryUsage().rss / 1024 / 1024))
  `
}

describe('logger per-task buffering', () => {
  it(
    '`none` discards chunks on arrival; the printing modes still buffer them',
    () => {
      // Assert on how RSS RESPONDS TO VOLUME, not on either absolute figure.
      // Comparing the two modes at one volume looked like the obvious test and
      // is not: building each chunk allocates it, so a run's peak also carries
      // whatever transient garbage GC has not reclaimed yet, and how much that
      // is differs per machine. It passed here (85 vs 201 MiB) and failed on a
      // CI runner at 129 vs 206 — where the fix was plainly working, since 129
      // is far below what 160 MiB of retained chunks costs. Feeding two volumes
      // to the SAME mode cancels that: the baseline and the garbage are common
      // to both, so the difference is what the buffers actually retained.
      //
      // The control runs FIRST so a harness that measured nothing would show it
      // here rather than passing vacuously on the bounded side.
      const fullFew = probeRssMib(loggerProbe('full', FEW_CHUNKS))
      const fullMany = probeRssMib(loggerProbe('full', MANY_CHUNKS))
      const noneFew = probeRssMib(loggerProbe('none', FEW_CHUNKS))
      const noneMany = probeRssMib(loggerProbe('none', MANY_CHUNKS))

      // `full` prints this output, so it must still hold it — the deliberate
      // boundary, not an oversight: silently truncating a build log is worse
      // than the memory. Pinned so a future "bound everything" change has to
      // argue with this line. It grows with the volume it is holding.
      expect(fullMany - fullFew).toBeGreaterThan(EXTRA_MIB * 0.5)

      // `none` guarantees "no per-task output at all", so it must not pay for
      // output it will never print: tripling the volume must not move it. The
      // slack covers GC noise while staying far under the 160 MiB the extra
      // chunks would cost if they were retained (before the fix both modes
      // grew together).
      expect(noneMany - noneFew).toBeLessThan(EXTRA_MIB * 0.25)
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
    // Reference the result so a retained string cannot be collected before
    // the measurement — otherwise the control could read as flat too.
    if (r.stdout.length < 0) throw new Error('unreachable')
    console.log('rss_mib=' + Math.round(process.memoryUsage().rss / 1024 / 1024))
  `
}

const CAP_FEW_MIB = 40
const CAP_MANY_MIB = 160
const CAP_EXTRA_MIB = CAP_MANY_MIB - CAP_FEW_MIB

describe('runCommand stream capture', () => {
  it(
    'an opted-down stream does not grow with the volume the child writes',
    () => {
      // Same differential shape as the logger test above: assert on how RSS
      // RESPONDS TO VOLUME, never on an absolute figure, so the bound does
      // not encode this container's speed or GC timing.
      //
      // The retaining control runs FIRST, so a harness that measured nothing
      // fails here rather than passing vacuously on the opted-down side.
      const keepFew = probeRssMib(capturedProbe(true, CAP_FEW_MIB))
      const keepMany = probeRssMib(capturedProbe(true, CAP_MANY_MIB))
      const dropFew = probeRssMib(capturedProbe(false, CAP_FEW_MIB))
      const dropMany = probeRssMib(capturedProbe(false, CAP_MANY_MIB))

      // Retaining is the documented default: `RunResult.stdout` holds what
      // the child wrote, so it MUST grow with the volume. Pinned so that
      // "just stop capturing everywhere" has to argue with this line.
      expect(keepMany - keepFew).toBeGreaterThan(CAP_EXTRA_MIB * 0.5)

      // Opted down, the same 120 MiB of extra output must not move it: the
      // stream is still fully drained, just not retained. Measured 102→243
      // MiB retaining vs 50→51 MiB not.
      expect(dropMany - dropFew).toBeLessThan(CAP_EXTRA_MIB * 0.25)
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
 * `fragment`, and the two line shapes exercise it differently: `\r`-only
 * output (a progress bar) is one endless line, which defeats the
 * discard-complete-lines trim that `\n`-terminated output relies on.
 */
function persistentProbe(seconds: number, terminator: '\\n' | '\\r'): string {
  const printf = terminator === '\\n' ? '%0200d\\\\n' : '%0200d\\\\r'
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
    console.log('rss_mib=' + Math.round(process.memoryUsage().rss / 1024 / 1024))
    process.exit(0)
  `
}

describe('persistent task pre-ready buffering', () => {
  for (const [name, terminator] of [
    ['newline-terminated', '\\n'],
    ['carriage-return only', '\\r'],
  ] as const) {
    it(
      `stays flat while a never-ready task floods stdout (${name})`,
      () => {
        const short = probeRssMib(persistentProbe(2, terminator))
        const long = probeRssMib(persistentProbe(6, terminator))
        // Unbounded growth ran ~100 MiB/s — through the real CLI, 6 s
        // measured 651 MiB (`\n`) and 488 MiB (`\r`) against ~280/370 MiB at
        // 2 s. A bounded capture makes the two durations indistinguishable,
        // so assert on the DIFFERENCE: it does not encode a machine's speed.
        expect(long - short).toBeLessThan(64)
        expect(long).toBeLessThan(256)
      },
      TIMEOUT,
    )
  }
})
