// A task's output as a cache entry stores it: both streams in the order
// vx read them, so a hit replays what the run showed. One string, so every
// cache layer carries it as it carried stdout: the text as written, with
// RS (U+001E) + `e` / `o` where the stream switches to stderr / stdout, and
// a literal RS doubled. Output that never touched stderr is its own text.

import { BoundedCapture, type CapturedChunk } from '../exec/index.js'

const RS = '\x1e'

/** `chunks` as one stored string; it starts on stdout. */
export function encodeOutputLog(chunks: readonly CapturedChunk[]): string {
  let out = ''
  let err = false
  for (const c of chunks) {
    if (c.text.length === 0) continue
    if (c.err !== err) {
      out += RS + (c.err ? 'e' : 'o')
      err = c.err
    }
    out += c.text.replaceAll(RS, RS + RS)
  }
  return out
}

/** The chunks `encodeOutputLog` wrote, adjacent same-stream text joined. */
export function decodeOutputLog(log: string): CapturedChunk[] {
  if (!log.includes(RS)) return log.length === 0 ? [] : [{ text: log, err: false }]
  const chunks: CapturedChunk[] = []
  let err = false
  let text = ''
  const flush = (): void => {
    if (text.length > 0) chunks.push({ text, err })
    text = ''
  }
  let from = 0
  for (let at = log.indexOf(RS); at !== -1; at = log.indexOf(RS, from)) {
    text += log.slice(from, at)
    const next = log[at + 1]
    from = at + 2
    if (next === 'e' || next === 'o') {
      flush()
      err = next === 'e'
      continue
    }
    text += RS
    // A lone RS (at the end, or before any other character) is the text's own.
    if (next !== RS) from = at + 1
  }
  text += log.slice(from)
  flush()
  return chunks
}

// What a failed task reports of its output (`vx last`, an agent): the
// error is usually at the end, and a run's history keeps one per failure.
export const FAILED_OUTPUT_HEAD_CHARS = 8 * 1024
export const FAILED_OUTPUT_TAIL_CHARS = 56 * 1024

/** A failed attempt's capture, re-bounded to the failure's limits when it is the entry's. */
export function failedOutputLog(capture: BoundedCapture, entrySized: boolean): string {
  if (!entrySized) return encodeOutputLog(capture.chunks())
  const small = new BoundedCapture(FAILED_OUTPUT_HEAD_CHARS, FAILED_OUTPUT_TAIL_CHARS)
  for (const c of capture.chunks()) small.push(c.text, c.err)
  return encodeOutputLog(small.chunks())
}
