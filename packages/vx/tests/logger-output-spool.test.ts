// The file a run's task output waits in (src/report/task-output.ts): where
// it lives, how much disk it takes, how often it is written and read, what a
// failing read prints, and that it closes with the run. The descriptor rows
// read /proc, so they are Linux's; the CI gate runs Linux.
import { afterEach, expect, it, spyOn } from 'bun:test'
import fs, { mkdtempSync, readdirSync, readlinkSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { TaskNode, TaskOutcome } from '../src/graph/index.js'
import { defaultLogger, type OutputView } from '../src/report/logger.js'
import { OutputSpool, TaskOutput } from '../src/report/task-output.js'
import type { SecretMask } from '../src/util/index.js'
import type { StatusStream } from '../src/ui/live-region.js'

const linux = process.platform === 'linux'
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function pipe(): StatusStream & { text(): string } {
  const parts: string[] = []
  return {
    isTTY: false,
    write(c: string | Uint8Array) {
      parts.push(typeof c === 'string' ? c : Buffer.from(c).toString())
      return true
    },
    text: () => parts.join(''),
  }
}

const node = (id: string, extra: object = {}): TaskNode =>
  ({
    id,
    projectName: 'p',
    taskName: id,
    requested: true,
    deps: [],
    projectDir: '/nowhere',
    config: { exec: { command: 'true', ...extra } },
  }) as unknown as TaskNode

const open = (): Set<number> => new Set(spools().map(([fd]) => fd))

const done = (n: TaskNode, status: TaskOutcome['status']): TaskOutcome =>
  ({ node: n, status, exitCode: status === 'failed' ? 1 : 0, durationMs: 1 }) as TaskOutcome

function logger(view: OutputView, dir?: string) {
  const out = pipe()
  const log = defaultLogger({ enabled: false }, view, out, { forceFloorMs: 0 })
  if (dir !== undefined) log.spoolIn(dir)
  log.runStart?.({ total: 1000, requestedCount: 2 })
  return { log, out }
}

/**
 * This process's descriptors open on a spool file, [fd, where it was],
 * past those in `before`: other files' loggers in this process may leave
 * theirs open.
 */
function spools(before: ReadonlySet<number> = new Set()): [number, string][] {
  const found: [number, string][] = []
  for (const fd of readdirSync('/proc/self/fd')) {
    let to = ''
    try {
      to = readlinkSync(`/proc/self/fd/${fd}`)
    } catch {}
    if (to.includes('.vx-output-') && !before.has(Number(fd))) found.push([Number(fd), to])
  }
  return found
}

it.skipIf(!linux)('the spool and the deferred frames close when the run is done', () => {
  // A logger per run: `vx watch` left one unlinked file open a cycle.
  const before = spools().length
  const { log } = logger({ mode: 'errors-only' })
  const a = node('p#a')
  log.taskStart?.(a)
  log.taskStdout(a, 'x\n'.repeat(100_000))
  log.taskComplete(a, done(a, 'failed'))
  const b = node('p#b')
  log.taskStart?.(b)
  log.taskStdout(b, 'y\n'.repeat(100_000))
  expect(spools().length).toBe(before + 2)
  log.runEnd?.()
  log.runDone?.()
  log.settle()
  expect(spools().length).toBe(before)
})

it.skipIf(!linux)("the spool lives in the run's cache directory, unlinked", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vx-spool-'))
  dirs.push(dir)
  const before = open()
  const { log } = logger({ mode: 'full' }, path.join(dir, 'cache'))
  const a = node('p#a')
  log.taskStart?.(a)
  log.taskStdout(a, 'x\n'.repeat(100_000))
  const [[, at]] = spools(before) as [[number, string]]
  expect(at.startsWith(path.join(dir, 'cache', '.vx-output-'))).toBe(true)
  expect(at.endsWith(' (deleted)')).toBe(true)
  log.taskComplete(a, done(a, 'success'))
  log.runDone?.()
})

it.skipIf(!linux)("a task that runs long keeps only its own output on disk, not the run's", () => {
  // 256 MiB of others' output ends while one task keeps running: the file
  // grew with all of it, written from its start again only once no task held it.
  const before = open()
  const { log } = logger({ mode: 'errors-only' })
  const long = node('p#long')
  log.taskStart?.(long)
  log.taskStdout(long, 'still running\n'.repeat(10_000))
  const mib = 'z'.repeat(1024 * 1024 - 1) + '\n'
  for (let i = 0; i < 256; i++) {
    const t = node(`p#t${i}`)
    log.taskStart?.(t)
    log.taskStdout(t, mib)
    log.taskComplete(t, done(t, 'success'))
  }
  const sizes = spools(before).map(([fd]) => fs.fstatSync(fd).size)
  expect(sizes.length).toBe(1)
  expect(sizes[0]!).toBeLessThan(80 * 1024 * 1024)
  log.taskComplete(long, done(long, 'failed'))
  log.runEnd?.()
  log.runDone?.()
})

it("a piece's spans are kept however many: never spread as arguments", () => {
  // A piece holds up to 4 MiB, a span every 7 characters of it; spread, a
  // million of them overflowed the stack out of the frame.
  const many = Array.from({ length: 2_000_000 }, (): [number, number] => [0, 6])
  const mask = {
    spanStream: () => ({ push: () => many, end: () => many }),
  } as unknown as SecretMask
  const spool = new OutputSpool()
  const out = new TaskOutput(spool)
  out.push('abcdef\n', false)
  expect(out.source(mask).content).toBe(true)
  out.release()
  spool.end()
})

it('a long log with a secret on every line is masked', () => {
  const { log, out } = logger({ mode: 'full' })
  const a = node('p#a', { env: { define: { API_TOKEN: 'supersecretvalue123' } } })
  log.taskStart?.(a)
  log.taskStdout(a, 'k=supersecretvalue123\n'.repeat(100_000))
  log.taskComplete(a, done(a, 'failed'))
  log.runEnd?.()
  log.runDone?.()
  expect(out.text()).toContain('k=***\n')
  expect(out.text()).not.toContain('supersecret')
})

for (const lines of [20_000, 600_000])
  it.skipIf(!linux)(
    `a spool that fails a read closes the frame with a note (${lines} lines)`,
    () => {
      // Observability never breaks a run: a read that threw out of
      // taskComplete left the frame open and every later task unprinted.
      const before = open()
      const { log, out } = logger({ mode: 'full' })
      const a = node('p#a')
      log.taskStart?.(a)
      log.taskStdout(a, 'abc\n'.repeat(lines))
      const [[fd]] = spools(before) as [[number, string]]
      fs.ftruncateSync(fs.openSync(`/proc/self/fd/${fd}`, 'r+'), 0)
      log.taskComplete(a, done(a, 'failed'))
      log.runEnd?.()
      log.runDone?.()
      expect(out.text()).toContain("[vx] the rest of this task's output could not be read back")
      expect(out.text()).toContain('└─')
    },
  )

it('tiny chunks reach the spool in one write and come back in one read', () => {
  // One write a chunk: a task printing a line at a time wrote each line.
  const writes = spyOn(fs, 'writeSync')
  const reads = spyOn(fs, 'readSync')
  try {
    const { log, out } = logger({ mode: 'full' })
    const a = node('p#a')
    log.taskStart?.(a)
    for (let i = 0; i < 1000; i++) log.taskStdout(a, `line ${i}\n`)
    log.taskComplete(a, done(a, 'success'))
    expect(out.text()).toContain('line 999')
    expect(writes.mock.calls.length).toBe(1)
    // Each record's head and body were two reads.
    expect(reads.mock.calls.length).toBe(1)
    log.runDone?.()
  } finally {
    writes.mockRestore()
    reads.mockRestore()
  }
})

it("broad reads a ready server's log once", () => {
  // Read and masked for the check whether it printed anything, then again
  // for its frame.
  const { log } = logger({ mode: 'broad' })
  const server = node('p#dev', { persistent: { readyWhen: 'ready' } })
  log.taskStart?.(server)
  log.taskStdout(server, 'Local: http://localhost:3000\n'.repeat(5000))
  const reads = spyOn(fs, 'readSync')
  try {
    log.taskComplete(server, done(server, 'success'))
    expect(reads.mock.calls.length).toBe(1)
  } finally {
    reads.mockRestore()
  }
  log.runDone?.()
})

it('a frame read while others write reads its own output, not a compacted file', () => {
  // A paced frame is read a piece at a time while the run goes on: a
  // compaction meanwhile closed the file under the read.
  const spool = new OutputSpool()
  const a = new TaskOutput(spool)
  const line = 'a'.repeat(1023) + '\n'
  for (let i = 0; i < 16 * 1024; i++) a.push(line, false)
  const reading = a.chunks()[Symbol.iterator]()
  let got = reading.next().value!.text
  const mib = 'z'.repeat(1024 * 1024 - 1) + '\n'
  for (let i = 0; i < 128; i++) {
    const t = new TaskOutput(spool)
    t.push(mib, false)
    t.push(mib, false)
    t.release()
  }
  for (let r = reading.next(); r.done !== true; r = reading.next()) got += r.value.text
  expect(got.length).toBe(16 * 1024 * 1024)
  expect(got === line.repeat(16 * 1024)).toBe(true)
  a.release()
  spool.end()
})
