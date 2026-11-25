// A frame read back from its file is written as fast as stdout's reader
// takes it: Bun queues what a pipe refuses, so a frame written without a
// pause sat whole in that queue (+299 MiB for 300 MB of a failed task's
// output on CI). What the logger prints after waits its turn: the bytes are
// those a reader that never pauses gets.
import { expect, it } from 'bun:test'
import type { TaskNode, TaskOutcome } from '../src/graph/index.js'
import { defaultLogger, type OutputView } from '../src/report/logger.js'
import type { StatusStream } from '../src/ui/live-region.js'

const HIGH_WATER = 64 * 1024

/** A pipe whose reader takes what is queued only when `take` is called; `slow` refuses past HIGH_WATER. */
function pipe(slow: boolean) {
  const parts: Buffer[] = []
  const listeners = new Map<string, Set<() => void>>()
  let queued = 0
  let most = 0
  const stream = {
    isTTY: false,
    write(c: string | Uint8Array) {
      const b = Buffer.from(c)
      parts.push(b)
      queued += b.length
      most = Math.max(most, queued)
      return !slow || queued < HIGH_WATER
    },
    once(event: string, f: () => void) {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event)!.add(f)
    },
    off(event: string, f: () => void) {
      listeners.get(event)?.delete(f)
    },
  }
  return {
    stream: stream as unknown as StatusStream,
    /** The reader takes everything queued; a refused writer hears `drain`. */
    take() {
      queued = 0
      const fs = [...(listeners.get('drain') ?? [])]
      listeners.get('drain')?.clear()
      for (const f of fs) f()
    },
    get most() {
      return most
    },
    bytes: () => Buffer.concat(parts).toString('latin1'),
  }
}

const node = (id: string): TaskNode =>
  ({
    id,
    projectName: 'p',
    taskName: id,
    requested: true,
    deps: [],
    projectDir: '/nowhere',
    config: { exec: { command: 'true' } },
  }) as unknown as TaskNode

const LINE = 'abcdefghijklmnopqrstuvwxyz0123456789 ✓ src/a.ts:1:2\n'

/** A run of `a` printing ~20 MB, then `b` and `c` a line each, read by `p`'s reader. */
async function run(p: ReturnType<typeof pipe>, view: OutputView, status: 'success' | 'failed') {
  const log = defaultLogger({ enabled: false }, view, p.stream, { forceFloorMs: 0 })
  const [a, b, c] = [node('p#a'), node('p#b'), node('p#c')]
  const done = (n: TaskNode, s: TaskOutcome['status']): void =>
    log.taskComplete(n, {
      node: n,
      status: s,
      exitCode: s === 'failed' ? 1 : 0,
      durationMs: 1,
    } as TaskOutcome)
  log.runStart?.({ total: 3, requestedCount: 3 })
  for (const n of [a, b, c]) log.taskStart?.(n)
  for (let i = 0; i < 400; i++) log.taskStdout(a, LINE.repeat(1000))
  log.taskStdout(b, 'b says\n')
  log.taskStdout(c, 'c says\n')
  done(a, status)
  done(b, 'failed')
  log.status('a line logged after')
  done(c, 'success')
  log.runEnd?.()
  log.runDone?.()
  log.settle()
  let gone = false
  const drained = log.drained().then(() => (gone = true))
  // The reader takes what is queued, a tick at a time, until the run is drained.
  while (!gone) {
    await new Promise((r) => setImmediate(r))
    p.take()
  }
  await drained
  return p.bytes()
}

for (const view of [{ mode: 'full' }, { mode: 'errors-only' }] as OutputView[])
  for (const status of ['success', 'failed'] as const)
    it(`a slow reader paces a long frame and what follows it (${view.mode}, ${status})`, async () => {
      const fast = pipe(false)
      const slow = pipe(true)
      const want = await run(fast, view, status)
      const got = await run(slow, view, status)
      if (view.mode === 'full' || status === 'failed') expect(fast.most).toBeGreaterThan(20e6)
      // At most a few MiB queued at once, however long the frame.
      expect(slow.most).toBeLessThan(4 * 1024 * 1024)
      // Every byte, in the order a reader that never pauses read them.
      expect(got.length).toBe(want.length)
      expect(got === want).toBe(true)
      expect(got.indexOf('a line logged after')).toBeGreaterThan(got.lastIndexOf(LINE))
    })
