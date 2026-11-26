// Where output leaves vx: the only file outside the live region that writes
// to a stream. A screen is blocks (`print`), a line said mid-run (`say`), or
// data a program reads (`data`: JSON, a completion script, a file's bytes),
// which no component may restyle.

import { inline, render, tagged, wrap, type Block, type Inline } from './components.js'
import { detectColors, INDENT, type Tone } from './theme.js'
import { REAL_STDOUT_WRITE } from '../util/index.js'

export type StreamName = 'out' | 'err'

const streamOf = (s: StreamName): NodeJS.WriteStream =>
  s === 'out' ? process.stdout : process.stderr

/** Write the blocks to stdout (`out`) or stderr (`err`), coloured for that stream. */
export function print(stream: StreamName, ...blocks: Block[]): void {
  const s = streamOf(stream)
  s.write(render(blocks, detectColors(s)))
}

/** `tagged` on a stream (stderr unless told), coloured for it. */
export function say(t: Tone, line: string, stream: StreamName = 'err'): void {
  const s = streamOf(stream)
  s.write(`${tagged(t, line, detectColors(s))}\n`)
}

/**
 * Bytes a program reads, written as they are: `--format json`, a
 * completion script, a file `vx show` prints. Never a sentence for a person.
 */
export function data(stream: StreamName, bytes: string): void {
  dataWrite(stream, bytes)
}

/** A stream's write, past a redirect of stdout's (`stdoutToStderr`). */
function dataWrite(stream: StreamName, bytes: string): boolean {
  const s = streamOf(stream)
  const write = s.write as typeof s.write & { [REAL_STDOUT_WRITE]?: typeof s.write }
  return (write[REAL_STDOUT_WRITE] ?? write).call(s, bytes)
}

/**
 * `data` for bytes too many for one string, written piece by piece. A
 * pipe that reads slower than vx writes is waited on: unwaited, every
 * piece queues in memory until the reader catches up.
 */
export async function dataPieces(stream: StreamName, pieces: Iterable<string>): Promise<void> {
  const s = streamOf(stream)
  // A reader that left (EPIPE, `| head`) raises no drain: the wait ended
  // only with the loop, and an endless source wrote on for nobody.
  let gone = false
  const leave = (): void => {
    gone = true
  }
  s.once('error', leave)
  s.once('close', leave)
  try {
    for (const piece of pieces) {
      if (gone || s.destroyed || (s.errored ?? null) !== null) return
      if (dataWrite(stream, piece)) continue
      await new Promise<void>((resolve) => {
        const done = (): void => {
          s.off('drain', done)
          s.off('error', done)
          s.off('close', done)
          resolve()
        }
        s.once('drain', done)
        s.once('error', done)
        s.once('close', done)
      })
    }
  } finally {
    s.off('error', leave)
    s.off('close', leave)
  }
}

/** Whether a stream paints. */
export function colorsOf(stream: StreamName): ReturnType<typeof detectColors> {
  return detectColors(streamOf(stream))
}

/**
 * A line that stands while something runs and then goes (`vx init`'s
 * package install), on stdout's terminal only: piped, it is not written.
 * Wrapped, never cut. Returns the call that takes it back.
 */
export function transient(line: Inline): () => void {
  const s = process.stdout
  if (s.isTTY !== true) return () => {}
  const c = detectColors(s)
  const rows = wrap(`${INDENT}${inline(line, c)} …`, c.columns ?? 80)
  s.write(`\n${rows.join('\n')}`)
  return () => void s.write(`\r\x1b[2K${'\x1b[1A\x1b[2K'.repeat(rows.length - 1)}\x1b[1A`)
}
