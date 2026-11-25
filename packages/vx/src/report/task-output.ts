// Where a task's output waits until the logger prints it or drops it: a
// file, not memory (M, 2026-11-25). Held whole in memory, 300 MB of output
// peaked vx at 1.39 GB under errors-only. Only a small head waits in memory,
// so a task that prints little costs no file; past it, every chunk goes to a
// file read back in pieces. A file is unlinked as soon as it is open, so a
// crash leaves nothing behind.

import { randomUUID } from 'node:crypto'
import { closeSync, ftruncateSync, openSync, readSync, unlinkSync, writeSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { hasEscape, leavesStyle } from '../ui/index.js'
import { MASKED, maskStreams, type SecretMask } from '../util/index.js'
import type { OutputChunk, OutputSource } from './framed-output.js'

/** What a task's output may hold in memory before it goes to a file. */
const SPILL_CHARS = 64 * 1024
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
    const buf = Buffer.allocUnsafe(HEAD_BYTES + n)
    buf[0] = (err ? ERR : 0) | (wide ? WIDE : 0)
    buf.writeUInt32LE(n, 1)
    buf.write(text, HEAD_BYTES, enc)
    try {
      for (let at = 0; at < buf.length;)
        at += writeSync(this.fd, buf, at, buf.length - at, this.size + at)
    } catch {
      try {
        ftruncateSync(this.fd, this.size)
      } catch {}
      return false
    }
    this.size += buf.length
    return true
  }

  /** The chunks between two sizes this file had, each in pieces of at most `READ_BYTES`. */
  *read(from: number, to: number): Generator<OutputChunk> {
    const head = Buffer.allocUnsafe(HEAD_BYTES)
    const buf = Buffer.allocUnsafe(Math.min(READ_BYTES, Math.max(0, to - from)))
    let at = from
    while (at < to) {
      this.readAt(head, HEAD_BYTES, at)
      at += HEAD_BYTES
      const err = (head[0]! & ERR) !== 0
      const wide = (head[0]! & WIDE) !== 0
      const end = at + head.readUInt32LE(1)
      // `ignoreBOM`: a chunk that starts with U+FEFF keeps it.
      const utf8 = wide ? null : new TextDecoder('utf-8', { ignoreBOM: true })
      while (at < end) {
        const n = Math.min(READ_BYTES, end - at)
        this.readAt(buf, n, at)
        at += n
        const text =
          utf8 === null
            ? buf.toString('utf16le', 0, n)
            : utf8.decode(buf.subarray(0, n), { stream: at < end })
        if (text.length > 0) yield { text, err }
      }
    }
  }

  close(): void {
    closeSync(this.fd)
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
 * One task's output while it runs: a head in memory, the rest in a file.
 * What the frame needs to know before it reads the output back is counted
 * as it arrives.
 */
export class TaskOutput {
  /** Characters pushed. */
  chars = 0
  /** Whether a chunk held more than whitespace. */
  content = false
  /** Whether the last chunk with an escape leaves a style on. */
  leaves = false
  private mem: OutputChunk[] = []
  private file: RecordFile | null = null
  // What memory holds after the file: what a file that could not be opened
  // or written refused. A log is never dropped for want of disk.
  private after: OutputChunk[] | null = null

  push(text: string, err: boolean): void {
    if (text.length === 0) return
    this.chars += text.length
    // `\S` is what `trim` keeps: the same whitespace.
    if (!this.content && /\S/.test(text)) this.content = true
    if (hasEscape(text)) this.leaves = leavesStyle(text)
    const c = { text, err }
    if (this.after !== null) this.after.push(c)
    else if (this.file !== null) {
      if (!this.file.append(text, err)) this.after = [c]
    } else {
      this.mem.push(c)
      if (this.chars > SPILL_CHARS) this.spill()
    }
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
    this.file?.close()
    this.file = null
    this.mem = []
    this.after = null
  }

  private spill(): void {
    const held = this.mem
    this.mem = []
    this.file = RecordFile.open()
    if (this.file === null) {
      this.after = held
      return
    }
    for (let i = 0; i < held.length; i++)
      if (!this.file.append(held[i]!.text, held[i]!.err)) {
        this.after = held.slice(i)
        return
      }
  }

  private *read(): Generator<OutputChunk> {
    yield* this.mem
    if (this.file !== null) yield* this.file.read(0, this.file.size)
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
