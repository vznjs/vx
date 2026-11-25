// Where a task's output waits until the logger prints it or drops it: a
// file, never memory (M, 2026-11-25). Held whole in memory, 300 MB of output
// peaked vx at 1.93 GB under errors-only. Each task's chunks gather in a
// write buffer of at most 64 Ki characters, written in one write to a file
// the run's tasks share, and read back in pieces. A file per task cost a warm
// run of 200 hits 18-43 ms more than memory (an open, an unlink and a close
// each). The file lives in the run's cache directory (`os.tmpdir()` is RAM on
// many CI images), unlinked as soon as it is open, so a crash leaves nothing
// behind.

import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { hasEscape, leavesStyle, styleWatch } from '../ui/index.js'
import { MASKED, maskStreams, type SecretMask } from '../util/index.js'
import type { OutputChunk, OutputSource } from './framed-output.js'

/**
 * Past this, a spool whose records are at least half released is compacted
 * into a new file, so its disk tracks the output tasks still hold, not the
 * run's total. A spool no task holds is written from its start again, and
 * truncated past this.
 */
const COMPACT_BYTES = 64 * 1024 * 1024
/** What a task's write buffer holds before one write takes it to the file. */
const WRITE_CHARS = 64 * 1024
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

const wellFormed = (text: string): boolean =>
  (text as string & { isWellFormed(): boolean }).isWellFormed()

/** Chunks appended to an unlinked temporary file, read back in pieces. */
class RecordFile {
  size = 0
  // One buffer for writes and one for reads, up to READ_BYTES: a buffer each
  // took 50-100 µs a 100 KB log, in collection.
  private wbuf = Buffer.allocUnsafe(64 * 1024)
  private rbuf: Buffer | null = Buffer.allocUnsafe(64 * 1024)

  private constructor(
    private readonly fd: number,
    /** The directory it opened in. */
    readonly dir: string,
  ) {}

  /** A new file in the first of `dirs` that takes one; null where all refuse. */
  static open(dirs: readonly string[]): RecordFile | null {
    for (const at of dirs) {
      const file = path.join(at, `.vx-output-${process.pid}-${randomUUID()}`)
      try {
        fs.mkdirSync(at, { recursive: true })
        const fd = fs.openSync(file, 'wx+', 0o600)
        fs.unlinkSync(file)
        return new RecordFile(fd, at)
      } catch {}
    }
    return null
  }

  /** `dir`, else the temporary directory. */
  static in(dir: string | undefined): RecordFile | null {
    return RecordFile.open(dir === undefined ? [os.tmpdir()] : [dir, os.tmpdir()])
  }

  /** `chunks` in one write. False when the file refused it (a full disk); the file is as before. */
  append(chunks: readonly OutputChunk[]): boolean {
    let total = 0
    for (const c of chunks)
      total += HEAD_BYTES + Buffer.byteLength(c.text, wellFormed(c.text) ? 'utf8' : 'utf16le')
    if (total > this.wbuf.length)
      if (total > READ_BYTES) {
        // A long chunk (a hit's replayed log) is written as it is, not copied.
        const from = this.size
        for (const c of chunks)
          if (!this.append1(c)) {
            // The batch's records written before it would lie unread.
            this.size = from
            try {
              fs.ftruncateSync(this.fd, from)
            } catch {}
            return false
          }
        return true
      } else
        this.wbuf = Buffer.allocUnsafe(Math.min(READ_BYTES, Math.max(total, this.wbuf.length * 2)))
    const buf = this.wbuf
    let at = 0
    for (const c of chunks) {
      const wide = !wellFormed(c.text)
      buf[at] = (c.err ? ERR : 0) | (wide ? WIDE : 0)
      const n = buf.write(c.text, at + HEAD_BYTES, wide ? 'utf16le' : 'utf8')
      buf.writeUInt32LE(n, at + 1)
      at += HEAD_BYTES + n
    }
    return this.write(buf, total)
  }

  private append1(c: OutputChunk): boolean {
    const wide = !wellFormed(c.text)
    const enc = wide ? 'utf16le' : 'utf8'
    const n = Buffer.byteLength(c.text, enc)
    const buf = Buffer.allocUnsafe(HEAD_BYTES + n)
    buf[0] = (c.err ? ERR : 0) | (wide ? WIDE : 0)
    buf.writeUInt32LE(n, 1)
    buf.write(c.text, HEAD_BYTES, enc)
    return this.write(buf, buf.length)
  }

  private write(buf: Buffer, n: number): boolean {
    try {
      for (let at = 0; at < n;) at += fs.writeSync(this.fd, buf, at, n - at, this.size + at)
    } catch {
      try {
        fs.ftruncateSync(this.fd, this.size)
      } catch {}
      return false
    }
    this.size += n
    return true
  }

  /** The bytes `[from, to)` of `src` appended. False when either file refused. */
  copy(src: RecordFile, from: number, to: number): boolean {
    const buf = Buffer.allocUnsafe(Math.min(READ_BYTES, to - from))
    for (let at = from; at < to;) {
      const n = Math.min(buf.length, to - at)
      try {
        src.readAt(buf, n, at)
      } catch {
        return false
      }
      if (!this.write(buf, n)) return false
      at += n
    }
    return true
  }

  /**
   * The chunks between two sizes this file had, each in pieces of at most
   * `READ_BYTES`, records and their heads read in as few reads as fit. A
   * file that fails a read (EIO, cut short) ends the chunks with a line
   * saying so: observability never breaks a run.
   */
  *read(from: number, to: number): Generator<OutputChunk> {
    // The shared buffer while no other read holds it: two reads of one file
    // may be in flight at once.
    const own = this.rbuf
    this.rbuf = null
    let buf = own ?? Buffer.allocUnsafe(Math.min(READ_BYTES, to - from))
    let start = 0
    let end = 0
    const fill = (pos: number, need: number): void => {
      const n = Math.min(READ_BYTES, Math.max(need, to - pos))
      if (n > buf.length)
        buf = Buffer.allocUnsafe(Math.min(READ_BYTES, Math.max(n, buf.length * 2)))
      this.readAt(buf, Math.min(n, to - pos), pos)
      start = pos
      end = pos + Math.min(n, to - pos)
    }
    let at = from
    try {
      while (at < to) {
        let text: string
        let err: boolean
        try {
          if (at + HEAD_BYTES > end) fill(at, HEAD_BYTES)
          const flags = buf[at - start]!
          const len = buf.readUInt32LE(at - start + 1)
          err = (flags & ERR) !== 0
          const enc = (flags & WIDE) !== 0 ? 'utf16le' : 'utf8'
          const body = at + HEAD_BYTES
          const stop = body + len
          if (stop > end && HEAD_BYTES + len <= READ_BYTES) fill(at, HEAD_BYTES + len)
          if (stop <= end) {
            text = buf.toString(enc, body - start, stop - start)
            at = stop
          } else {
            // Longer than one read: in pieces, through a decoder that holds a
            // character cut between them. `ignoreBOM`: a chunk that starts with
            // U+FEFF keeps it.
            const utf8 = enc === 'utf8' ? new TextDecoder('utf-8', { ignoreBOM: true }) : null
            // What the head's read took of it already: UTF-16 whole units.
            let k = Math.max(0, end - body)
            if (utf8 === null) k &= ~1
            const first = buf.subarray(body - start, body - start + k)
            at = body + k
            if (k > 0) {
              const piece =
                utf8 === null ? first.toString('utf16le') : utf8.decode(first, { stream: true })
              if (piece.length > 0) yield { text: piece, err }
            }
            while (at < stop) {
              const n = Math.min(READ_BYTES, stop - at)
              if (n > buf.length) buf = Buffer.allocUnsafe(READ_BYTES)
              this.readAt(buf, n, at)
              at += n
              const piece =
                utf8 === null
                  ? buf.toString('utf16le', 0, n)
                  : utf8.decode(buf.subarray(0, n), { stream: at < stop })
              end = 0
              if (piece.length > 0) yield { text: piece, err }
            }
            continue
          }
        } catch (e) {
          yield {
            text: `\n[vx] the rest of this task's output could not be read back: ${(e as Error).message}\n`,
            err: true,
          }
          return
        }
        if (text.length > 0) yield { text, err }
      }
    } finally {
      if (own !== null) this.rbuf = buf.length <= READ_BYTES ? buf : own
    }
  }

  close(): void {
    fs.closeSync(this.fd)
  }

  /** Written from the start again: nothing in it is read any more. */
  reset(): void {
    if (this.size > COMPACT_BYTES)
      try {
        fs.ftruncateSync(this.fd, 0)
      } catch {}
    this.size = 0
  }

  readAt(buf: Buffer, n: number, at: number): void {
    for (let got = 0; got < n;) {
      const r = fs.readSync(this.fd, buf, got, n - got, at + got)
      if (r === 0) throw new Error('the file ended early')
      got += r
    }
  }
}

/**
 * The one file a logger's tasks write their output to, opened at the first
 * write (`none` and `hash-only` drop their chunks, and open none). Each
 * task holding records in it is a holder; with none it is written from its
 * start again, and once the run is over (`end`) closed.
 */
export class OutputSpool {
  private file: RecordFile | null | undefined
  private readonly holders = new Set<TaskOutput>()
  // Bytes of the file the holders' records take: the rest is released.
  private live = 0
  /** Reads in flight: a paced frame is read while the run writes on, and a compaction would close its file. */
  reading = 0
  // The size past which the file is compacted: after a compaction the disk
  // refused, twice the size then, or every 64 KiB written asked it again.
  private compactPast = COMPACT_BYTES
  private ended = false
  private dir: string | undefined

  /** Opens its file (and the deferred frames') in `dir`, from the next open. */
  in(dir: string): void {
    this.dir = dir
  }

  /** Where a new file opens. */
  get where(): string | undefined {
    return this.dir
  }

  /** The file, `task` a holder of it; null where none can be opened. */
  hold(task: TaskOutput): RecordFile | null {
    if (this.file === undefined) this.file = RecordFile.in(this.dir)
    if (this.file !== null) this.holders.add(task)
    return this.file
  }

  /** The file a holder's records are in. */
  get current(): RecordFile {
    return this.file!
  }

  /** A holder wrote `n` bytes: past COMPACT_BYTES, a file at least half released is compacted. */
  wrote(n: number): void {
    this.live += n
    const file = this.file!
    if (
      this.reading === 0 &&
      file.size > this.compactPast &&
      (file.size - this.live) * 2 >= file.size
    )
      this.compact()
  }

  free(task: TaskOutput): void {
    if (!this.holders.delete(task)) return
    this.live -= task.bytes
    if (this.holders.size > 0) return
    this.live = 0
    this.compactPast = COMPACT_BYTES
    if (!this.ended) this.file!.reset()
    else this.close()
  }

  /** The run is over: the file closes now if no task holds it, else when the last lets go. */
  end(): void {
    this.ended = true
    if (this.holders.size === 0) this.close()
  }

  private close(): void {
    this.file?.close()
    this.file = undefined
  }

  /** Each holder's records copied, back to back, into a new file that replaces this one. */
  private compact(): void {
    // Where the file is: never memory (os.tmpdir() on many CI images) for a disk that is full.
    const next = RecordFile.open([this.file!.dir])
    const refused = (): void => {
      this.compactPast = this.file!.size * 2
    }
    if (next === null) return refused()
    const moved = new Map<TaskOutput, number[]>()
    for (const t of this.holders) {
      const at = next.size
      for (let i = 0; i < t.runs.length; i += 2)
        if (!next.copy(this.file!, t.runs[i]!, t.runs[i + 1]!)) {
          next.close()
          return refused()
        }
      moved.set(t, at === next.size ? [] : [at, next.size])
    }
    for (const [t, runs] of moved) t.runs = runs
    this.file!.close()
    this.file = next
    this.live = next.size
    this.compactPast = COMPACT_BYTES
  }
}

/**
 * One task's output while it runs: a bounded write buffer, then the spool,
 * where its records lie in runs back to back. What the frame needs to know
 * before it reads the output back is counted as it arrives.
 */
export class TaskOutput {
  /** Characters pushed. */
  chars = 0
  /** Whether a chunk held more than whitespace. */
  content = false
  /** Whether the last chunk with an escape leaves a style on. */
  leaves = false
  /** Bytes of its records in the spool. */
  bytes = 0
  /** [start, end) of each run of its records in the spool's file. */
  runs: number[] = []
  private pending: OutputChunk[] = []
  private pendingChars = 0
  private holding = false
  // Releases still owed: a frame waiting its turn to be written keeps one.
  private kept = 1
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
    if (this.after !== null) {
      this.after.push({ text, err })
      return
    }
    this.pending.push({ text, err })
    this.pendingChars += text.length
    if (this.pendingChars >= WRITE_CHARS) this.flush()
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
    // Appended one by one: a spread of every span a piece holds passed
    // 64 Ki arguments for a long log with a secret on every line.
    const add = (k: 0 | 1, found: Array<[number, number]>): void => {
      for (const f of found) spans[k].push(f)
    }
    for (const c of this.read()) add(c.err ? 1 : 0, finders[c.err ? 1 : 0].push(c.text))
    add(0, finders[0].end())
    add(1, finders[1].end())
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

  /** One more `release` before its records go: a frame still to read them. */
  keep(): void {
    this.kept++
  }

  /** Its records released at the last `release` owed; what its buffer holds was never read, and is dropped unwritten. */
  release(): void {
    if (--this.kept > 0) return
    this.pending = []
    this.pendingChars = 0
    if (this.holding) this.spool.free(this)
    this.holding = false
    this.runs = []
    this.bytes = 0
    this.after = null
  }

  private flush(): void {
    if (this.pending.length === 0) return
    const chunks = this.pending
    this.pending = []
    this.pendingChars = 0
    const file = this.spool.hold(this)
    this.holding ||= file !== null
    const at = file?.size ?? 0
    if (file === null || !file.append(chunks)) {
      this.after = chunks
      return
    }
    const n = this.runs.length
    if (n > 0 && this.runs[n - 1] === at) this.runs[n - 1] = file.size
    else this.runs.push(at, file.size)
    this.bytes += file.size - at
    this.spool.wrote(file.size - at)
  }

  private *read(): Generator<OutputChunk> {
    this.flush()
    // Read off the runs as they are now: others append meanwhile, past them,
    // and no compaction moves them.
    const runs = this.runs
    this.spool.reading++
    try {
      for (let i = 0; i < runs.length; i += 2)
        yield* this.spool.current.read(runs[i]!, runs[i + 1]!)
    } finally {
      this.spool.reading--
    }
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
  let run: ReturnType<typeof styleWatch> | null = null
  const close = (): void => {
    if (run !== null) leaves = run.leaves()
    run = null
  }
  return {
    add(c) {
      if (c.err !== err) {
        close()
        err = c.err
      }
      // Watched from the run's first escape on: a run with none leaves the last verdict.
      if (run === null && hasEscape(c.text)) run = styleWatch()
      run?.add(c.text)
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

  constructor(private readonly spool: OutputSpool) {}

  get size(): number {
    return this.entries.length
  }

  /** A frame's `pieces`, and the annotation that heads it. */
  add(note: string, pieces: Iterable<string>): void {
    if (this.file === undefined) this.file = RecordFile.in(this.spool.where)
    const file = this.file
    const entry: (typeof this.entries)[number] = {
      from: file?.size ?? 0,
      to: file?.size ?? 0,
      chars: 0,
      note,
    }
    // Pieces gather to WRITE_CHARS, one write each: a frame is written a line at a time.
    let pending: OutputChunk[] = []
    let pendingChars = 0
    const flush = (): void => {
      if (pending.length === 0) return
      if (entry.after === undefined && file !== null && file.append(pending)) entry.to = file.size
      else for (const c of pending) (entry.after ??= []).push(c.text)
      pending = []
      pendingChars = 0
    }
    for (const piece of pieces) {
      if (piece.length === 0) continue
      entry.chars += piece.length
      pending.push({ text: piece, err: false })
      pendingChars += piece.length
      if (pendingChars >= WRITE_CHARS) flush()
    }
    flush()
    this.entries.push(entry)
  }

  /** Each frame in order: its note, length, and its text read back in pieces when asked, until `close`. */
  frames(): { note: string; chars: number; pieces: () => Iterable<string> }[] {
    const file = this.file
    return this.entries.map((e) => ({
      note: e.note,
      chars: e.chars,
      *pieces() {
        if (file != null) for (const c of file.read(e.from, e.to)) yield c.text
        if (e.after !== undefined) yield* e.after
      },
    }))
  }

  /** Its file closed, frames never printed dropped. */
  close(): void {
    this.entries = []
    this.file?.close()
    this.file = undefined
  }
}
