// A task's output waits in a file until the logger prints it (M,
// 2026-11-25), and a long one is framed as it is read back, in pieces. The
// bytes are the frame a log held in memory printed: the same frame
// (`formatTaskBlock` over the whole output, each stream's secrets masked in
// its whole text) between the same lines, in every view that prints one.
import { expect, it } from 'bun:test'
import type { TaskNode, TaskOutcome } from '../src/graph/index.js'
import { formatTaskBlock } from '../src/report/framed-output.js'
import { defaultLogger, type OutputView } from '../src/report/logger.js'
import type { StatusStream } from '../src/ui/live-region.js'
import { maskStreams, rawEncode, secretMask } from '../src/util/index.js'

const SECRET = 'supersecretvalue123'

function pipe(): StatusStream & { bytes(): string } {
  const parts: Buffer[] = []
  return {
    isTTY: false,
    write(c: string | Uint8Array) {
      parts.push(typeof c === 'string' ? Buffer.from(c) : Buffer.from(c))
      return true
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
    config: { exec: { command: 'true', env: { define: { API_TOKEN: SECRET } } } },
  }) as unknown as TaskNode

type Chunk = { text: string; err: boolean }

/** Output of `kind`, about `size` characters, in the chunks a task's pipes gave. */
function output(kind: string, size: number): Chunk[] {
  const line = 'abcdefghijklmnopqrstuvwxyz0123456789 ✓ src/a.ts:1:2\n'
  const base = line.repeat(Math.max(1, Math.floor(size / line.length / 3)))
  switch (kind) {
    case 'streams':
      return [
        { text: base, err: false },
        { text: 'half a line, then stderr: ', err: false },
        { text: `rest\n${'err line\n'.repeat(500)}`, err: true },
        { text: base, err: false },
        { text: 'no newline at the end', err: false },
      ]
    // A value split across chunks, and across a write to the other stream.
    case 'secret':
      return [
        { text: `${base}token: supers`, err: false },
        { text: 'between', err: true },
        { text: `ecretvalue123 and ${SECRET}${SECRET}\n${base}`, err: false },
        { text: 'err supersecretvalue1', err: true },
        { text: `23\n${base}`, err: true },
        { text: SECRET, err: false },
      ]
    // A colour cut between two chunks, and one left on at the end.
    case 'styles':
      return [
        { text: `${base}\x1b[3`, err: false },
        { text: `1mred\n${base}`, err: false },
        { text: 'x\x1b[1mbold no reset', err: true },
        { text: base, err: true },
        { text: `${base}tail \x1b[3`, err: false },
        { text: '2m', err: false },
      ]
    // A raw byte's escape, a pair split between chunks, a BOM.
    case 'surrogates':
      return [
        { text: `${base}a\udc80b\ud83d`, err: false },
        { text: `\ude00 smile\n${base}`, err: false },
        { text: 'lone \ud800 high\n', err: true },
        { text: `﻿bom\n${base}`, err: false },
      ]
  }
  throw new Error(kind)
}

const COLORS = [{ enabled: false }, { enabled: true, level: 3 }] as const
const VIEWS: OutputView[] = [
  { mode: 'full' },
  { mode: 'full', gha: true },
  { mode: 'errors-only' },
  { mode: 'errors-only', gha: true, ci: true },
  { mode: 'broad' },
  { mode: 'focused' },
]

/** What the logger printed for task `a` writing `chunks`, beside a failed `b`. */
function printed(
  chunks: readonly Chunk[],
  view: OutputView,
  colors: (typeof COLORS)[number],
  status: TaskOutcome['status'],
): string {
  const out = pipe()
  const log = defaultLogger(colors, view, out, { forceFloorMs: 0 })
  const [a, b] = [node('p#a'), node('p#b')]
  log.runStart?.({ total: 2, requestedCount: 2 })
  log.taskStart?.(a)
  log.taskStart?.(b)
  for (const c of chunks) {
    ;(c.err ? log.taskStderr : log.taskStdout)(a, c.text)
    log.taskStdout(b, 'b\n')
  }
  log.taskComplete(a, {
    node: a,
    status,
    exitCode: status === 'failed' ? 1 : 0,
    durationMs: 5,
  } as TaskOutcome)
  log.taskComplete(b, { node: b, status: 'failed', exitCode: 2, durationMs: 3 } as TaskOutcome)
  log.runEnd?.()
  log.settle()
  return out
    .bytes()
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, 'TOKEN')
}

/** Task `a`'s frame over its whole output, as bytes, or '' where it is not printed. */
function frame(
  chunks: readonly Chunk[],
  colors: (typeof COLORS)[number],
  status: TaskOutcome['status'],
  forceCommand: boolean,
): string {
  const a = node('p#a')
  const mask = status === 'cache-hit' ? null : secretMask([process.env, { API_TOKEN: SECRET }])
  const block = formatTaskBlock(
    a,
    { node: a, status, exitCode: status === 'failed' ? 1 : 0, durationMs: 5 } as TaskOutcome,
    { output: mask === null ? chunks : maskStreams(chunks, mask) },
    colors,
    forceCommand,
  )
  return Buffer.from(rawEncode(block)).toString('latin1')
}

for (const kind of ['streams', 'secret', 'styles', 'surrogates'])
  it(`a long log prints the frame held whole printed (${kind})`, () => {
    for (const size of [200_000, 1_800_000])
      for (const colors of COLORS)
        for (const view of VIEWS)
          for (const status of ['success', 'failed', 'cache-hit'] as const) {
            const long = output(kind, size)
            const short = output(kind, 2000)
            const got = printed(long, view, colors, status)
            const want = printed(short, view, colors, status)
            // The requested task's frame shows its command in the views that
            // print it as requested; in the rest a failure's does.
            const force = view.mode === 'focused' || (view.mode === 'broad' && status !== 'failed')
            const blocks = [true, false].map((f) => [
              frame(long, colors, status, f),
              frame(short, colors, status, f),
            ])
            const [l, s] = blocks.find(([b]) => got.includes(b!)) ?? blocks[force ? 0 : 1]!
            const where = { kind, size, colors: colors.enabled, view, status }
            // Printed in the same views, once, between the same bytes.
            expect({ ...where, printed: got.includes(l!) }).toEqual({
              ...where,
              printed: want.includes(s!),
            })
            expect({ ...where, rest: got.replace(l!, '<frame>') }).toEqual({
              ...where,
              rest: want.replace(s!, '<frame>'),
            })
          }
  })

it('a masked value in a long log is masked across its chunks and streams', () => {
  const got = printed(output('secret', 1_800_000), { mode: 'errors-only' }, COLORS[0], 'failed')
  expect(got).toContain('token: ***')
  expect(got).toContain('err ***')
  expect(got).not.toContain('supers')
  expect(got).not.toContain('ecretvalue1')
})

it('a long log of nothing but a blank secret still frames its mask', () => {
  // A mask is content where the value it hides was blank: the frame held
  // whole printed `***` under OUTPUT.
  const out = pipe()
  const log = defaultLogger({ enabled: false }, { mode: 'full' }, out, { forceFloorMs: 0 })
  const blank = '\t'.repeat(8)
  const a = {
    ...node('p#a'),
    config: { exec: { command: 'true', env: { define: { API_TOKEN: blank } } } },
  } as unknown as TaskNode
  log.runStart?.({ total: 1 })
  log.taskStart?.(a)
  log.taskStdout(a, `${blank}\n`.repeat(200_000))
  log.taskComplete(a, { node: a, status: 'success', exitCode: 0, durationMs: 1 })
  log.runEnd?.()
  log.settle()
  expect(out.bytes()).toContain('OUTPUT')
  expect(out.bytes()).toContain('***')
})
