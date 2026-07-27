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

const CHUNKS = 40
const CHUNK_BYTES = 4 * 1024 * 1024
const FED_MIB = (CHUNKS * CHUNK_BYTES) / 1024 / 1024

/**
 * Feed `CHUNKS` distinct multi-MB chunks through `defaultLogger` in one view
 * mode and report the process RSS while the task is still in flight — i.e.
 * the peak the logger's per-task buffers are responsible for. The chunks are
 * built inline so the probe itself retains none of them.
 */
function loggerProbe(mode: string): string {
  return `
    import { defaultLogger } from ${JSON.stringify(LOGGER)}
    const log = defaultLogger({ enabled: false }, { mode: ${JSON.stringify(mode)} }, { write: () => true })
    const node = { id: 'p#t', projectName: 'p', taskName: 't', requested: false, surfaced: false, deps: [], config: { exec: { command: 'noop' } } }
    for (let i = 0; i < ${CHUNKS}; i++) log.taskStdout(node, i + ':' + 'x'.repeat(${CHUNK_BYTES}))
    console.log('rss_mib=' + Math.round(process.memoryUsage().rss / 1024 / 1024))
  `
}

describe('logger per-task buffering', () => {
  it(
    '`none` discards chunks on arrival; the printing modes still buffer them',
    () => {
      // The control runs FIRST so a harness that measured nothing would show
      // it here rather than passing vacuously on the bounded side.
      const full = probeRssMib(loggerProbe('full'))
      const none = probeRssMib(loggerProbe('none'))

      // `full` prints this output, so it must still hold it — that is the
      // deliberate boundary, not an oversight: silently truncating a build
      // log is worse than the memory. Pinned so a future "bound everything"
      // change has to argue with this line.
      expect(full).toBeGreaterThan(FED_MIB * 0.75)

      // `none` guarantees "no per-task output at all", so it must not pay
      // for output it will never print. Before the fix both modes measured
      // identically (201 MiB each for 160 MiB fed).
      expect(none).toBeLessThan(full / 2)
    },
    TIMEOUT,
  )
})

/**
 * A persistent task whose `readyWhen` never matches, with no `exec.timeout`,
 * writing as fast as the shell can — the one task kind nothing bounds, since
 * a one-shot command's output ends when it exits.
 *
 * Both line shapes are measured because they exercise DIFFERENT accumulators:
 * `\n`-terminated output grows the pre-ready buffer and the logger's per-task
 * buffer, while `\r`-only output (a progress bar) additionally defeats the
 * ready-matcher's discard-complete-lines trim. Fixing only one leaves the
 * other reachable by a one-character change to the task's command.
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
