// The run's last block repeats each failed task's last lines (item 706): a
// failure's frame prints when the task ends, thousands of lines above the
// end of a long CI log, and GitHub's API returns only a job log's last
// 5,000 lines.
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'bun:test'
import type { TaskNode, TaskOutcome } from '../src/graph/index.js'
import { appendRecapRing, createRecapRing, recapTail } from '../src/orchestrator/failure-recap.js'
import { defaultLogger, type OutputView } from '../src/orchestrator/logger.js'
import { addProject, makeWorkspace } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const GLYPH = '◼︎'
const TIMEOUT = 30_000

function vx(
  cwd: string,
  env: Record<string, string>,
  args: string[],
): { code: number; out: string } {
  const base: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && k !== 'NO_COLOR' && k !== 'FORCE_COLOR' && k !== 'GITHUB_ACTIONS') {
      base[k] = v
    }
  }
  const p = Bun.spawnSync({
    cmd: [process.execPath, BIN, ...args],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...base, CI: '1', ...env },
  })
  return { code: p.exitCode ?? 1, out: new TextDecoder().decode(p.stdout) }
}

const numbered = (from: number, to: number): string[] =>
  Array.from({ length: to - from + 1 }, (_, i) => `line ${from + i}`)

let root: string | undefined
afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function workspace(config: string): Promise<string> {
  root = await makeWorkspace({ prefix: 'vx-failure-recap-' })
  await addProject(root, 'app', { config })
  return root
}

describe('the run ends with each failed task’s last lines', () => {
  it(
    'a task printing 100 lines and exiting 3: lines 71–100, 70 earlier, exit 3',
    async () => {
      const ws = await workspace(`
        export default {
          tasks: {
            fail: { exec: { command: 'for i in $(seq 1 100); do echo line $i; done; exit 3' } },
          },
        }
      `)
      const r = vx(ws, {}, ['run', 'fail', '--all'])
      expect(r.code).toBe(1)
      const expected = [
        '',
        '  Failed:   1 task — the last lines it printed',
        '',
        `  ${GLYPH} app#fail — failed (exit 3)`,
        '  … 70 earlier lines',
        ...numbered(71, 100),
        '',
      ].join('\n')
      expect(r.out.slice(-expected.length)).toBe(expected)
    },
    TIMEOUT,
  )

  // CONTROL: the same output from a task that passes is not repeated; the
  // summary's last row ends the run.
  it(
    'a task that succeeds after printing a lot gets no recap',
    async () => {
      const ws = await workspace(`
        export default {
          tasks: {
            chatty: { exec: { command: 'for i in $(seq 1 100); do echo line $i; done' } },
          },
        }
      `)
      const r = vx(ws, {}, ['run', 'chatty', '--all'])
      expect(r.code).toBe(0)
      const lines = r.out.replace(/\n$/, '').split('\n')
      expect(lines.at(-1)).toMatch(/^ {2}time {6}\d/)
      expect(lines.filter((l) => l.startsWith('  Failed:'))).toEqual([])
    },
    TIMEOUT,
  )

  it(
    'seven failures: five tails, then the other two named by id',
    async () => {
      const ids = ['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7']
      const ws = await workspace(`
        export default {
          tasks: {
            ${ids.map((t) => `${t}: { exec: { command: 'echo out-${t}; exit 1' } },`).join('\n            ')}
          },
        }
      `)
      const r = vx(ws, {}, ['run', ...ids, '--all', '--continue'])
      expect(r.code).toBe(1)
      const recap = r.out.slice(r.out.lastIndexOf('\n  Failed:')).replace(/\n$/, '').split('\n')
      expect(recap[1]).toBe('  Failed:   7 tasks — the last lines each one printed')
      const tails = new Map<string, string[]>()
      let current: string[] = []
      for (const line of recap.slice(2, -2)) {
        const head = new RegExp(`^  ${GLYPH} app#(f\\d) — failed \\(exit 1\\)$`).exec(line)
        if (head !== null) tails.set(head[1]!, (current = []))
        else if (line !== '') current.push(line)
      }
      expect(tails.size).toBe(5)
      for (const [id, body] of tails) expect(body).toEqual([`out-${id}`])
      const more = /^ {2}… and 2 more failed: app#(f\d), app#(f\d)$/.exec(recap.at(-1)!)
      expect(more).not.toBeNull()
      expect([...tails.keys(), more![1]!, more![2]!].sort()).toEqual(ids)
    },
    TIMEOUT,
  )

  it(
    'on GitHub Actions the recap sits outside every group, its lines fenced',
    async () => {
      const ws = await workspace(`
        export default {
          tasks: {
            ok: { exec: { command: 'echo fine' } },
            fail: { exec: { command: 'for i in $(seq 1 100); do echo line $i; done; exit 3' } },
          },
        }
      `)
      const r = vx(ws, { GITHUB_ACTIONS: 'true' }, ['run', 'ok', 'fail', '--all', '--continue'])
      expect(r.code).toBe(1)
      const at = r.out.lastIndexOf('\n  Failed:')
      const before = r.out.slice(0, at)
      const recap = r.out.slice(at)
      const groups = (s: string) => (s.match(/^::group::/gm) ?? []).length
      const ends = (s: string) => (s.match(/^::endgroup::$/gm) ?? []).length
      // A group was opened and closed above, so the rule has something to hold.
      expect([groups(before), ends(before)]).toEqual([1, 1])
      expect([groups(recap), ends(recap)]).toEqual([0, 0])
      const token = /^::stop-commands::(.+)$/m.exec(recap)?.[1]
      expect(token).toBeDefined()
      expect(recap).toBe(
        [
          '',
          '  Failed:   1 task — the last lines it printed',
          '',
          `  ${GLYPH} app#fail — failed (exit 3)`,
          '  … 70 earlier lines',
          `::stop-commands::${token}`,
          ...numbered(71, 100),
          `::${token}::`,
          '',
        ].join('\n'),
      )
    },
    TIMEOUT,
  )
})

function sink(): { write(c: string): boolean } {
  return { write: () => true }
}

function node(id: string, requested = false): TaskNode {
  const [projectName, taskName] = id.split('#')
  return {
    id,
    projectName,
    taskName,
    requested,
    surfaced: false,
    deps: [],
    config: { exec: { command: 'noop' } },
  } as unknown as TaskNode
}

function outcome(n: TaskNode, status: TaskOutcome['status'], exitCode = 1): TaskOutcome {
  return { node: n, status, exitCode, durationMs: 5 }
}

const NO_COLORS = { enabled: false }

function recapOf(view: OutputView, feed: (log: ReturnType<typeof defaultLogger>) => void) {
  const log = defaultLogger(NO_COLORS, view, sink())
  feed(log)
  return log.failureRecap()
}

const header = (id: string, label = 'failed (exit 1)'): string[] => [
  '',
  '  Failed:   1 task — the last lines it printed',
  '',
  `  ${GLYPH} ${id} — ${label}`,
]

describe('the recap’s tail', () => {
  it('cuts one 20 KiB line to its last 8 KiB, and says so', () => {
    const n = node('p#t')
    const recap = recapOf({ mode: 'full' }, (log) => {
      log.taskStdout(n, `${'a'.repeat(12_288)}${'b'.repeat(8192)}\n`)
      log.taskComplete(n, outcome(n, 'failed'))
    })
    expect(recap).toEqual([
      ...header('p#t'),
      '  … 12,288 bytes cut from the start of the line below',
      'b'.repeat(8192),
    ])
  })

  it('thirty long lines over 8 KiB: whole lines above the cut are counted, then the bytes', () => {
    const n = node('p#t')
    const line = (k: number) => String(k).padStart(999, '-') // 1,000 bytes with its newline
    const recap = recapOf({ mode: 'full' }, (log) => {
      for (let k = 1; k <= 40; k++) log.taskStdout(n, `${line(k)}\n`)
      log.taskComplete(n, outcome(n, 'failed'))
    })
    // Lines 11–40 are 29,999 bytes; the last 8,192 start 807 bytes into line 32.
    expect(recap).toEqual([
      ...header('p#t'),
      '  … 31 earlier lines, and 807 bytes cut from the start of the line below',
      line(32).slice(807),
      ...Array.from({ length: 8 }, (_, i) => line(33 + i)),
    ])
  })

  // Two-byte characters: the ring's 8,193 characters hold more than 8 KiB, so
  // the byte cut, not the ring, decides where the tail starts.
  it('the byte cut counts the whole lines it removes, then the bytes of the next', () => {
    const n = node('p#t')
    const line = (k: number) => `${'é'.repeat(497)}${String(k).padStart(2, '0')}` // 996 bytes
    const recap = recapOf({ mode: 'full' }, (log) => {
      for (let k = 1; k <= 40; k++) log.taskStdout(n, `${line(k)}\n`)
      log.taskComplete(n, outcome(n, 'failed'))
    })
    // Line 40 and seven 997-byte lines above it are 7,975 bytes; the other
    // 217 are the end of line 32 and its newline, 780 bytes into it.
    expect(recap).toEqual([
      ...header('p#t'),
      '  … 31 earlier lines, and 780 bytes cut from the start of the line below',
      `${'é'.repeat(107)}32`,
      ...Array.from({ length: 8 }, (_, i) => line(33 + i)),
    ])
  })

  it('cuts on a character boundary, counting bytes', () => {
    const n = node('p#t')
    // 10,000 two-byte characters: the last 8,192 bytes are 4,096 of them.
    const recap = recapOf({ mode: 'full' }, (log) => {
      log.taskStdout(n, `${'é'.repeat(10_000)}\n`)
      log.taskComplete(n, outcome(n, 'failed'))
    })
    expect(recap).toEqual([
      ...header('p#t'),
      '  … 11,808 bytes cut from the start of the line below',
      'é'.repeat(4096),
    ])
  })

  it('a cut that lands inside a character moves past it', () => {
    const n = node('p#t')
    // 8,191 two-byte characters and an `a` are 16,383 bytes: the last 8,192
    // would start on the second byte of an é, so the tail starts one later.
    const recap = recapOf({ mode: 'full' }, (log) => {
      log.taskStdout(n, `${'é'.repeat(9000)}a\n`)
      log.taskComplete(n, outcome(n, 'failed'))
    })
    expect(recap).toEqual([
      ...header('p#t'),
      '  … 9,810 bytes cut from the start of the line below',
      `${'é'.repeat(4095)}a`,
    ])
  })

  it('reads stdout then stderr, as the frame does, and passes colour codes through', () => {
    const n = node('p#t')
    const recap = recapOf({ mode: 'full' }, (log) => {
      log.taskStderr(n, 'err\n')
      log.taskStdout(n, '\x1b[31mred\x1b[0m')
      log.taskComplete(n, outcome(n, 'failed', 2))
    })
    expect(recap).toEqual([...header('p#t', 'failed (exit 2)'), '\x1b[31mred\x1b[0m', 'err'])
  })

  it('names a timeout by its kind, and a task that printed nothing says so', () => {
    const n = node('p#t')
    const recap = recapOf({ mode: 'full' }, (log) => {
      log.taskComplete(n, { ...outcome(n, 'failed', 143), timedOut: true })
    })
    expect(recap).toEqual([...header('p#t', 'failed (timed out, exit 143)'), '  (no output)'])
  })

  it('a live-streamed task keeps both streams in the ring, in the order they arrived', () => {
    const n = node('p#t', true)
    const recap = recapOf({ mode: 'focused' }, (log) => {
      log.runStart?.({ total: 1, requestedCount: 1 })
      log.taskStart?.(n)
      for (const line of numbered(1, 40)) {
        if (line === 'line 20') log.taskStderr(n, `${line}\n`)
        else log.taskStdout(n, `${line}\n`)
      }
      log.taskComplete(n, outcome(n, 'failed'))
    })
    expect(recap).toEqual([...header('p#t'), '  … 10 earlier lines', ...numbered(11, 40)])
  })

  it('a persistent task that fails before ready says what its bounded capture dropped', () => {
    const n = node('p#dev')
    ;(n.config.exec as { persistent?: object }).persistent = {}
    const LINE = `${'x'.repeat(999)}\n`
    const recap = recapOf({ mode: 'full' }, (log) => {
      log.taskStart?.(n)
      // 70,000 characters in 1,000-character chunks: the 64 KiB capture
      // evicts five whole chunks.
      for (let i = 0; i < 70; i++) log.taskStdout(n, LINE)
      log.taskComplete(n, outcome(n, 'failed'))
    })
    expect(recap).toEqual([
      ...header('p#dev'),
      "  … 56 earlier lines, and 807 bytes cut from the start of the line below, and the capture dropped 5,000 characters of the task's output",
      'x'.repeat(192),
      ...Array.from({ length: 8 }, () => 'x'.repeat(999)),
    ])
  })

  it('every mode that prints task output recaps; the two that promise none do not', () => {
    const recaps = (['full', 'errors-only', 'broad', 'focused', 'none', 'hash-only'] as const).map(
      (mode) =>
        recapOf({ mode }, (log) => {
          const n = node('p#t')
          log.taskStdout(n, 'boom\n')
          log.taskComplete(n, outcome(n, 'failed'))
        }).length,
    )
    expect(recaps).toEqual([5, 5, 5, 5, 0, 0])
  })

  it('a task that passes leaves nothing to recap', () => {
    const n = node('p#t')
    const recap = recapOf({ mode: 'full' }, (log) => {
      log.taskStdout(n, 'fine\n')
      log.taskComplete(n, outcome(n, 'success', 0))
    })
    expect(recap).toEqual([])
  })
})

describe('the ring is bounded however much a task prints', () => {
  // What the ring HOLDS, summed from its chunks — not `ring.chars`, the
  // count it keeps of them: with whole-chunk eviction gone the count still
  // read 8,193 while the chunks held 64,000 characters (item 765).
  const held = (ring: ReturnType<typeof createRecapRing>): number =>
    ring.chunks.reduce((n, c) => n + c.length, 0)
  const LINE = 'x'.repeat(99) // 100 bytes with its newline
  const CHUNK = `${LINE}\n`.repeat(640) // 64,000 bytes
  const CHUNKS = 800 // 51.2 MB

  it('50 MB in pipe-sized chunks: at most 8 KiB held, every line counted', () => {
    const ring = createRecapRing()
    let most = 0
    for (let i = 0; i < CHUNKS; i++) {
      appendRecapRing(ring, CHUNK)
      most = Math.max(most, held(ring))
    }
    expect(most).toBeLessThanOrEqual(8193)
    expect(ring.chars).toBe(held(ring))
    const tail = recapTail(ring)
    expect(tail.earlierLines).toBe(CHUNKS * 640 - 30)
    expect(tail.cutBytes).toBe(0)
    expect(tail.text).toBe(Array.from({ length: 30 }, () => LINE).join('\n'))
  })

  it('50 MB in one chunk (a buffered task’s whole stdout): the same bound', () => {
    const ring = createRecapRing()
    appendRecapRing(ring, CHUNK.repeat(CHUNKS))
    expect(held(ring)).toBeLessThanOrEqual(8193)
    expect(ring.chars).toBe(held(ring))
    expect(recapTail(ring).earlierLines).toBe(CHUNKS * 640 - 30)
  })

  it('a blank line opening the thirty is shown, not counted above them', () => {
    // Forty lines, the eleventh empty: the tail shows lines 11–40, so ten
    // are above it. Counting a newline AT the window's first character
    // read the empty line as an eleventh (item 765).
    const lines = numbered(1, 40)
    lines[10] = ''
    const ring = createRecapRing()
    for (const line of lines) appendRecapRing(ring, `${line}\n`)
    expect(recapTail(ring)).toEqual({
      text: lines.slice(10).join('\n'),
      earlierLines: 10,
      cutBytes: 0,
    })
  })

  // Evicting a big head chunk whole would have left 300 characters for a
  // recap that has thirty lines to show.
  it('a chunk is evicted whole only when the rest still fills the ring', () => {
    const ring = createRecapRing()
    const lines = Array.from({ length: 40 }, (_, i) => String(i + 1).padStart(199, '.'))
    appendRecapRing(ring, `${lines.join('\n')}\n`)
    appendRecapRing(ring, `${'z'.repeat(299)}\n`)
    expect(recapTail(ring)).toEqual({
      text: [...lines.slice(11), 'z'.repeat(299)].join('\n'),
      earlierLines: 11,
      cutBytes: 0,
    })
  })

  it('a line longer than the ring: the bytes cut from it are counted across chunks', () => {
    const ring = createRecapRing()
    appendRecapRing(ring, 'head\n')
    for (let i = 0; i < 5; i++) appendRecapRing(ring, 'y'.repeat(4096))
    const tail = recapTail(ring)
    expect(tail).toEqual({ text: 'y'.repeat(8192), earlierLines: 1, cutBytes: 5 * 4096 - 8192 })
  })
})
