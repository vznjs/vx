// Where output leaves vx: the only file outside the live region that writes
// to a stream. A screen is blocks (`print`), a line said mid-run (`say`), or
// data a program reads (`data`: JSON, a completion script, a file's bytes),
// which no component may restyle.

import { inline, render, tagged, wrap, type Block, type Inline } from './components.js'
import { detectColors, INDENT, type Tone } from './theme.js'

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
  streamOf(stream).write(bytes)
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
  const rows = wrap(`${INDENT}${inline(line, c)} …`, s.columns ?? 80)
  s.write(`\n${rows.join('\n')}`)
  return () => void s.write(`\r\x1b[2K${'\x1b[1A\x1b[2K'.repeat(rows.length - 1)}\x1b[1A`)
}
