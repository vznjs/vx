// Where a task's output waits until the logger prints it or drops it: a
// file, never memory (M, 2026-11-25). Held whole in memory, 300 MB of output
// peaked vx at 1.93 GB under errors-only. Every chunk goes to one file the
// run's tasks share, from the first byte, and is read back in pieces. A file
// per task cost a warm run of 200 hits 18-43 ms more than memory (an open, an
// unlink and a close each). The file is unlinked as soon as it is open, so a
// crash leaves nothing behind.

import { randomUUID } from 'node:crypto'
import { closeSync, ftruncateSync, openSync, readSync, unlinkSync, writeSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { hasEscape, leavesStyle } from '../ui/index.js'
import { MASKED, maskStreams, type SecretMask } from '../util/index.js'
import type { OutputChunk, OutputSource } from './framed-output.js'

/** A spool no task holds that has grown past this gives its disk back. */
const SHRINK_BYTES = 64 * 1024 * 1024
/**
 * The most of a file read back at once; even, so a UTF-16 piece never splits
 * a unit, and above the bytes of the longest log read back whole (1 Mi
 * characters), so its chunks read back as they were pushed.
 */
const READ_BYTES = 4 * 1024 * 1024
/** A record's head: flags, then the payload's byte length. */
const HEAD_BYTES = 5
const ERR = 1
// A string that is not well-formed (a lone surrogate, a raw byte's escape)
// is kept as UTF-16, so it reads back as it was written.
const WIDE = 2

/** Chunks appended to an unlinked temporary file, read back in pieces. */
class RecordFile {
  size = 0
  // One buffer for every write and read up to READ_BYTES: a buffer each
  // took 50-100 µs a 100 KB log, in collection. A read decodes what it read
  // before it yields, so readers in turn share it.
  private scratch = Buffer.allocUnsafe(64 * 1024)

  private constructor(private readonly fd: number) {}

  /** A new file, or null where the temporary directory refuses one. */
  static open(): RecordFile | null {
    const at = path.join(os.tmpdir(), `vx-output-${process.pid}-${randomUUID()}`)
    try {
      const fd = openSync(at, 'wx+', 0o600)
      unlinkSync(at)
      return new RecordFile(fd)
    } catch {
      return null
    }
  }

  /** False when the file refused it (a full disk); the file is as before. */
  append(text: string, err: boolean): boolean {
    const wide = !(text as string & { isWellFormed(): boolean }).isWellFormed()
    const enc = wide ? 'utf16le' : 'utf8'
    const n = Buffer.byteLength(text, enc)
    const buf = this.buffer(HEAD_BYTES + n)
    buf[0] = (err ? ERR : 0) | (wide ? WIDE : 0)
    buf.writeUInt32LE(n, 1)
    buf.write(text, HEAD_BYTES, enc)
    try {
      for (let at = 0; at < HEAD_BYTES + n;)
        at += writeSync(this.fd, buf, at, HEAD_BYTES + n - at, this.size + at)
    } catch {
      try {
        ftruncateSync(this.fd, this.size)
      } catch {}
      return false
    }
    this.size += HEAD_BYTES + n
    return true
  }

  /** The chunks between two sizes this file had, each in pieces of at most `READ_BYTES`. */
  *read(from: number, to: number): Generator<OutputChunk> {
    let at = from
    while (at < to) {
      const head = this.buffer(HEAD_BYTES)
      this.readAt(head, HEAD_BYTES, at)
      at += HEAD_BYTES
      const err = (head[0]! & ERR) !== 0
      const wide = (head[0]! & WIDE) !== 0
      const end = at + head.readUInt32LE(1)
      // A record read in one piece decodes whole; a longer one through a
      // decoder that holds a character cut between pieces. `ignoreBOM`: a
      // chunk that starts with U+FEFF keeps it.
      const utf8 =
        wide || end - at <= READ_BYTES ? null : new TextDecoder('utf-8', { ignoreBOM: true })
      while (at < end) {
        const n = Math.min(READ_BYTES, end - at)
        const buf = this.buffer(n)
        this.readAt(buf, n, at)
        at += n
        const text =
          utf8 !== null
            ? utf8.decode(buf.subarray(0, n), { stream: at < end })
            : buf.toString(wide ? 'utf16le' : 'utf8', 0, n)
        if (text.length > 0) yield { text, err }
      }
    }
  }

  close(): void {
    closeSync(this.fd)
  }

  /** Written from the start again: nothing in it is read any more. */
  reset(): void {
    if (this.size > SHRINK_BYTES)
      try {
        ftruncateSync(this.fd, 0)
      } catch {}
    this.size = 0
  }

  /** A buffer of at least `n` bytes: the shared one, grown up to READ_BYTES. */
  private buffer(n: number): Buffer {
    if (n <= this.scratch.length) return this.scratch
    if (n > READ_BYTES) return Buffer.allocUnsafe(n)
    this.scratch = Buffer.allocUnsafe(Math.min(READ_BYTES, Math.max(n, this.scratch.length * 2)))
    return this.scratch
  }

  private readAt(buf: Buffer, n: number, at: number): void {
    for (let got = 0; got < n;) {
      const r = readSync(this.fd, buf, got, n - got, at + got)
      if (r === 0) throw new Error('vx: a task output file ended early')
      got += r
    }
  }
}

/**
 * The one file a logger's tasks write their output to, opened at the first
 * chunk (`none` and `hash-only` drop theirs, and open none), written from
 * its start again whenever no task's output is in it.
 */
export class OutputSpool {
  private file: RecordFile | null | undefined
  private held = 0

  /** The file, held for a task until `free`; null where none can be opened. */
  take(): RecordFile | null {
    if (this.file === undefined) this.file = RecordFile.open()
    if (this.file !== null) this.held++
    return this.file
  }

  free(): void {
    if (--this.held === 0) this.file!.reset()
  }
}

/**
 * One task's output while it runs, in the spool: where its records lie,
 * runs of them back to back. What the frame needs to know before it reads
 * the output back is counted as it arrives.
 */
export class TaskOutput {
  /** Characters pushed. */
  chars = 0
  /** Whether a chunk held more than whitespace. */
  content = false
  /** Whether the last chunk with an escape leaves a style on. */
  leaves = false
  private file: RecordFile | null = null
  // [start, end) of each run of this task's records in the file.
  private runs: number[] = []
  // What memory holds after the file: what a file that could not be opened
  // or written refused. A log is never dropped for want of disk.
  private after: OutputChunk[] | null = null

  constructor(private readonly spool: OutputSpool) {}

  push(text: string, err: boolean): void {
    if (text.length === 0) return
    this.chars += text.length
    // `\S` is what `trim` keeps: the same whitespace.
    if (!this.content && /\S/.test(text)) this.content = true
    if (hasEscape(text)) this.leaves = leavesStyle(text)
    if (this.after === null) {
      if (this.file === null) this.file = this.spool.take()
      const file = this.file
      if (file !== null) {
        const at = file.size
        if (file.append(text, err)) {
          const n = this.runs.length
          if (n > 0 && this.runs[n - 1] === at) this.runs[n - 1] = file.size
          else this.runs.push(at, file.size)
          return
        }
      }
      this.after = []
    }
    this.after.push({ text, err })
  }

  /** Whether a chunk was pushed. */
  get any(): boolean {
    return this.chars > 0
  }

  /** The chunks in order, read back in pieces; each iteration starts over. */
  chunks(): Iterable<OutputChunk> {
    return { [Symbol.iterator]: () => this.read() }
  }

  /**
   * The output as a frame shows it: with `mask`, each stream's secrets
   * masked in its whole text, as `maskStreams` does, in two passes over
   * the file (where the values lie, then the text).
   */
  source(mask: SecretMask | null): OutputSource {
    if (mask === null)
      return { chunks: this.chunks(), content: this.content, leaves: () => this.leaves }
    const spans: [Array<[number, number]>, Array<[number, number]>] = [[], []]
    const finders = [mask.spanStream(), mask.spanStream()] as const
    for (const c of this.read()) spans[c.err ? 1 : 0].push(...finders[c.err ? 1 : 0].push(c.text))
    spans[0].push(...finders[0].end())
    spans[1].push(...finders[1].end())
    // A mask is never whitespace, so a masked value is content.
    const content = this.content || spans[0].length > 0 || spans[1].length > 0
    let leaves = false
    const read = (): Generator<OutputChunk> => {
      const style = styleTracker()
      leaves = false
      return (function* (chunks: Iterable<OutputChunk>) {
        for (const c of masked(chunks, spans)) {
          leaves = style.add(c)
          yield c
        }
        leaves = style.end()
      })(this.read())
    }
    return { chunks: { [Symbol.iterator]: read }, content, leaves: () => leaves }
  }

  /** In memory whole: a short output reads back as one array, masked as it always was. */
  held(mask: SecretMask | null): OutputChunk[] {
    const all = [...this.read()]
    return mask === null ? all : maskStreams(all, mask)
  }

  release(): void {
    if (this.file !== null) this.spool.free()
    this.file = null
    this.runs = []
    this.after = null
  }

  private *read(): Generator<OutputChunk> {
    for (let i = 0; i < this.runs.length; i += 2)
      yield* this.file!.read(this.runs[i]!, this.runs[i + 1]!)
    if (this.after !== null) yield* this.after
  }
}

/**
 * `chunks` with `spans` (each stream's, as offsets into that stream's
 * text) masked: the value's mask where it starts, its rest cut from the
 * chunks it reaches, as `maskStreams` places them.
 */
function* masked(
  chunks: Iterable<OutputChunk>,
  spans: readonly [ReadonlyArray<[number, number]>, ReadonlyArray<[number, number]>],
): Generator<OutputChunk> {
  const pos = [0, 0]
  const next = [0, 0]
  for (const c of chunks) {
    const k = c.err ? 1 : 0
    const own = spans[k]
    const at = pos[k]!
    const end = at + c.text.length
    pos[k] = end
    let i = next[k]!
    if (i >= own.length || own[i]![0] >= end) {
      yield c
      continue
    }
    let text = ''
    let from = at
    for (; i < own.length && own[i]![0] < end; i++) {
      const [s, e] = own[i]!
      if (s >= from) text += c.text.slice(from - at, s - at) + MASKED
      from = Math.max(from, Math.min(e, end))
      if (e > end) break
    }
    next[k] = i
    text += c.text.slice(from - at)
    if (text.length > 0) yield { text, err: c.err }
  }
}

/**
 * `leavesStyle` of the last run with an escape, a run being what
 * `maskStreams` returns: one stream's text between two switches. Read as
 * the pieces pass; only the last escape's 64 characters are kept.
 */
function styleTracker(): { add(c: OutputChunk): boolean; end(): boolean } {
  let leaves = false
  let err: boolean | undefined
  let esc = false
  let seg: string | null = null
  let tail = ''
  const close = (): void => {
    if (esc) leaves = seg !== null && leavesStyle(seg)
    esc = false
    seg = null
    tail = ''
  }
  return {
    add(c) {
      if (c.err !== err) {
        close()
        err = c.err
      }
      if (!esc && hasEscape(c.text)) esc = true
      if (esc) {
        const s = tail + c.text
        const at = s.lastIndexOf('\x1b[')
        if (at >= 0) seg = s.slice(at, at + 64)
        else if (seg !== null && seg.length < 64) seg += c.text.slice(0, 64 - seg.length)
        tail = s.slice(-64)
      }
      return leaves
    },
    end() {
      close()
      return leaves
    },
  }
}

/**
 * The failure frames a view prints at the run's end, rendered when each
 * task ended and kept in one file until then, in order.
 */
export class DeferredFrames {
  private file: RecordFile | null | undefined
  private entries: {
    from: number
    to: number
    chars: number
    after?: string[]
    note: string
  }[] = []

  get size(): number {
    return this.entries.length
  }

  /** A frame `render` writes, and the annotation that heads it. */
  add(note: string, render: (write: (piece: string) => void) => void): void {
    if (this.file === undefined) this.file = RecordFile.open()
    const file = this.file
    const entry: (typeof this.entries)[number] = {
      from: file?.size ?? 0,
      to: file?.size ?? 0,
      chars: 0,
      note,
    }
    render((piece) => {
      if (piece.length === 0) return
      entry.chars += piece.length
      if (entry.after === undefined && file !== null && file.append(piece, false)) {
        entry.to = file.size
        return
      }
      ;(entry.after ??= []).push(piece)
    })
    this.entries.push(entry)
  }

  /** Each frame in order: its note, length and text, read back in pieces. Then the file goes. */
  drain(each: (frame: { note: string; chars: number; pieces: Iterable<string> }) => void): void {
    const file = this.file
    for (const e of this.entries) {
      const pieces = (function* () {
        if (file != null) for (const c of file.read(e.from, e.to)) yield c.text
        if (e.after !== undefined) yield* e.after
      })()
      each({ note: e.note, chars: e.chars, pieces })
    }
    this.entries = []
    file?.close()
    this.file = undefined
  }
}
