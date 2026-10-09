// A streaming tar reader for the restore path. `Bun.Archive` needs the whole
// tar in memory and `.files()` copies every entry, so restoring a 150 MiB
// artifact peaked at 3.2× its size (measured 2026-09-03). This reads the
// tar as it streams out of the zstd decoder and hands each entry's body to
// the caller as chunks, so memory is bounded by one chunk, not the archive.
//
// Dialect: what libarchive (Bun.Archive) writes — ustar with the name/prefix
// split, pax extended headers (`x`: path, size) past ustar's limits — plus
// GNU long names (`L`) for foreign artifacts. Every header's checksum is
// verified; an archive that ends before its data does is an error, never a
// short entry. Non-regular entries are reported with their type and their
// bodies skipped; the caller decides what to materialise (nothing but `0`).

interface TarEntry {
  name: string
  size: number
  /** POSIX typeflag: '0' regular, '5' directory, '2' symlink, … */
  type: string
  /** Header mtime in ms (second precision — the sidecar carries the real one). */
  mtimeMs: number
  /** The entry's bytes, in stream order. Must be drained before the next entry. */
  body: AsyncIterable<Uint8Array>
}

export class TarFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TarFormatError'
  }
}

const BLOCK = 512
/**
 * An extended header's body is read whole, so its size is a claim on
 * memory the stream has not paid for: a 1 GiB pax header zstd-compresses
 * to ~32 KB and cost 2 GiB of RSS where a regular entry of that size
 * streams in 32 MiB (L-1). A real one holds a path (≤ PATH_MAX) and a few
 * numbers; a MiB is far past any writer's.
 */
const MAX_EXTENDED_HEADER = 1024 * 1024
// `ignoreBOM`: a default decoder drops a leading U+FEFF, and a name or
// prefix field that began with one read back without it.
const decoder = new TextDecoder('utf-8', { ignoreBOM: true })

function field(h: Uint8Array, off: number, len: number): string {
  let end = off
  while (end < off + len && h[end] !== 0) end++
  return decoder.decode(h.subarray(off, end))
}

function octal(h: Uint8Array, off: number, len: number): number {
  // GNU base-256 (high bit set) for sizes ≥ 8 GiB.
  if (h[off]! & 0x80) {
    let n = 0
    for (let i = off + 1; i < off + len; i++) n = n * 256 + h[i]!
    return n
  }
  const plain = plainOctal(h, off, len)
  if (plain !== null) return plain
  const s = field(h, off, len).trim()
  if (s === '') return 0
  // Every digit, not the longest parseable prefix: `parseInt` would read
  // a corrupt `5zz` as 5 and let the damage surface later, if at all.
  if (!/^[0-7]+$/.test(s)) throw new TarFormatError(`bad octal field: ${JSON.stringify(s)}`)
  return parseInt(s, 8)
}

/**
 * The field every writer emits — octal digits between ASCII spaces, ended
 * by a NUL or the field's end — read off the bytes; null for anything
 * else, which `octal` reads the slow way. Three fields a header through a
 * decoder and a regex were most of a small artifact's read (2026-10-02).
 */
function plainOctal(h: Uint8Array, off: number, len: number): number | null {
  const end = off + len
  let i = off
  while (i < end && h[i] === 0x20) i++
  let n = 0
  while (i < end && h[i]! >= 0x30 && h[i]! <= 0x37) n = n * 8 + (h[i++]! - 0x30)
  while (i < end && h[i] === 0x20) i++
  return i === end || h[i] === 0 ? n : null
}

function isZeroBlock(h: Uint8Array): boolean {
  for (let i = 0; i < BLOCK; i++) if (h[i] !== 0) return false
  return true
}

function checksumOk(h: Uint8Array): boolean {
  const stored = octal(h, 148, 8)
  // The checksum field counts as eight spaces.
  let sum = 8 * 32
  for (let i = 0; i < 148; i++) sum += h[i]!
  for (let i = 156; i < BLOCK; i++) sum += h[i]!
  return sum === stored
}

/** pax `x` body: `<len> <key>=<value>\n` records. */
function parsePax(body: Uint8Array): Map<string, string> {
  const out = new Map<string, string>()
  let i = 0
  while (i < body.byteLength) {
    let sp = i
    while (sp < body.byteLength && body[sp] !== 32) sp++
    const len = Number(decoder.decode(body.subarray(i, sp)))
    if (!Number.isInteger(len) || len <= 0 || i + len > body.byteLength) {
      throw new TarFormatError('malformed pax record')
    }
    const rec = decoder.decode(body.subarray(sp + 1, i + len - 1))
    const eq = rec.indexOf('=')
    if (eq > 0) out.set(rec.slice(0, eq), rec.slice(eq + 1))
    i += len
  }
  return out
}

/** A byte source with exact-size reads over a stream of arbitrary chunks. */
class Source {
  private chunks: Uint8Array[] = []
  private head = 0
  private done = false
  constructor(private readonly reader: AsyncIterator<Uint8Array>) {}

  private async fill(): Promise<boolean> {
    if (this.done) return false
    const { done, value } = await this.reader.next()
    if (done === true || value === undefined) {
      this.done = true
      return false
    }
    if (value.byteLength > 0) this.chunks.push(value)
    return true
  }

  /** Exactly `n` bytes, or null at a clean end (nothing buffered), or a TarFormatError mid-entry. */
  async exact(n: number, what: string): Promise<Uint8Array | null> {
    // Within one chunk, a view: the copy below was a third of a small
    // artifact's read. Nothing writes to what this returns.
    const c0 = this.chunks[0]
    if (c0 !== undefined && c0.byteLength - this.head >= n) {
      const view = c0.subarray(this.head, this.head + n)
      this.head += n
      if (this.head === c0.byteLength) {
        this.chunks.shift()
        this.head = 0
      }
      return view
    }
    const out = new Uint8Array(n)
    let got = 0
    while (got < n) {
      if (this.chunks.length === 0 && !(await this.fill())) {
        if (got === 0) return null
        throw new TarFormatError(`archive ends inside ${what} (${got} of ${n} bytes)`)
      }
      const c = this.chunks[0]!
      const take = Math.min(n - got, c.byteLength - this.head)
      out.set(c.subarray(this.head, this.head + take), got)
      got += take
      this.head += take
      if (this.head === c.byteLength) {
        this.chunks.shift()
        this.head = 0
      }
    }
    return out
  }

  /** Up to `n` bytes as they arrive (never more), for streaming a body. */
  async *take(n: number, what: string): AsyncIterable<Uint8Array> {
    let left = n
    while (left > 0) {
      if (this.chunks.length === 0 && !(await this.fill())) {
        throw new TarFormatError(`archive ends inside ${what} (${n - left} of ${n} bytes)`)
      }
      const c = this.chunks[0]!
      const take = Math.min(left, c.byteLength - this.head)
      const piece = c.subarray(this.head, this.head + take)
      left -= take
      this.head += take
      if (this.head === c.byteLength) {
        this.chunks.shift()
        this.head = 0
      }
      yield piece
    }
  }
}

/** What one header block means, decided by `TarDecoder.header`. */
type HeaderStep =
  /** A zero block: the first half of the end marker. */
  | { kind: 'zero' }
  /** The second zero block in a row: the archive is over. */
  | { kind: 'end' }
  /** An extended header (`x`, `L`) or a global one (`g`); its padded body follows. */
  | { kind: 'extended'; type: 'x' | 'L' | 'g'; size: number; padded: number }
  /** An entry; its padded body follows. */
  | { kind: 'entry'; name: string; size: number; type: string; mtimeMs: number; padded: number }

const ZERO: HeaderStep = { kind: 'zero' }
const END: HeaderStep = { kind: 'end' }

/**
 * The dialect, decoded off whole blocks with no I/O: the one copy of the
 * header rules both readers run — `tarEntries` over a stream (restore,
 * ingest) and `tarEntriesSync` over a tar in memory (a save's own) — so
 * a name a save indexes is the name a restore reads.
 */
class TarDecoder {
  private pendingPath: string | undefined
  private pendingSize: number | undefined
  private zeroBlocks = 0

  /** The bytes ended at a header boundary: clean only after a zero block. */
  eof(): void {
    if (this.zeroBlocks === 0) throw new TarFormatError('archive has no end-of-archive marker')
  }

  header(h: Uint8Array): HeaderStep {
    if (isZeroBlock(h)) {
      this.zeroBlocks++
      return this.zeroBlocks >= 2 ? END : ZERO
    }
    this.zeroBlocks = 0
    if (!checksumOk(h)) throw new TarFormatError('header checksum mismatch')
    const type = h[156] === 0 ? '0' : String.fromCharCode(h[156]!)
    const size = this.pendingSize ?? octal(h, 124, 12)
    const mtimeMs = octal(h, 136, 12) * 1000
    const padded = Math.ceil(size / BLOCK) * BLOCK
    // POSIX `ustar\0` only: old GNU's `ustar  ` keeps atime and ctime at
    // 345, and `-G` fills them, so a prefix read there named every entry
    // `<atime>…/<name>`.
    const prefix = field(h, 257, 6) === 'ustar' ? field(h, 345, 155) : ''
    const rawName = field(h, 0, 100)
    const name = this.pendingPath ?? (prefix ? `${prefix}/${rawName}` : rawName)
    this.pendingPath = undefined
    this.pendingSize = undefined
    if (type === 'x' || type === 'L' || type === 'g') {
      if (size > MAX_EXTENDED_HEADER) {
        throw new TarFormatError(
          `extended header of ${size} bytes, past ${MAX_EXTENDED_HEADER} (a hostile archive?)`,
        )
      }
      return { kind: 'extended', type, size, padded }
    }
    const trimmed = name.replace(/\/+$/, type === '5' ? '/' : '')
    return { kind: 'entry', name: trimmed, size, type, mtimeMs, padded }
  }

  /** An `x` or `L` header's padded body: it applies to the NEXT entry only. */
  extended(type: 'x' | 'L', body: Uint8Array, size: number): void {
    if (type === 'L') {
      this.pendingPath = field(body, 0, size)
      return
    }
    const pax = parsePax(body.subarray(0, size))
    const p = pax.get('path')
    if (p !== undefined) this.pendingPath = p
    const s = pax.get('size')
    if (s !== undefined) {
      // Digits only: `Number` reads `0.5` and `-1`, and a fractional
      // size moved the reader to a fractional offset.
      if (!/^[0-9]+$/.test(s) || !Number.isSafeInteger(Number(s))) {
        throw new TarFormatError(`bad pax size: ${JSON.stringify(s)}`)
      }
      this.pendingSize = Number(s)
    }
  }
}

const extendedWhat = (type: 'x' | 'L' | 'g'): string =>
  type === 'g' ? 'a global header' : 'an extended header'

/**
 * Iterate a tar stream entry by entry. Each entry's `body` MUST be fully
 * consumed (or the iterator drains it) before the next entry is read.
 */
export async function* tarEntries(stream: ReadableStream<Uint8Array>): AsyncGenerator<TarEntry> {
  const src = new Source(stream[Symbol.asyncIterator]())
  const tar = new TarDecoder()
  for (;;) {
    const h = await src.exact(BLOCK, 'a header')
    if (h === null) return tar.eof()
    const step = tar.header(h)
    if (step.kind === 'end') return
    if (step.kind === 'zero') continue
    if (step.kind === 'extended') {
      const body = await src.exact(step.padded, extendedWhat(step.type))
      // pax global header: not used by Bun.Archive; its body is skipped.
      if (step.type === 'g') continue
      if (body === null) throw new TarFormatError('archive ends inside an extended header')
      tar.extended(step.type, body, step.size)
      continue
    }
    const { name, size, padded } = step
    let drained = false
    const body = (async function* (): AsyncIterable<Uint8Array> {
      if (size > 0) for await (const c of src.take(size, `entry ${name}`)) yield c
      const pad = padded - size
      if (pad > 0 && (await src.exact(pad, `padding after ${name}`)) === null) {
        throw new TarFormatError(`archive ends inside padding after ${name}`)
      }
      drained = true
    })()
    yield { name, size, type: step.type, mtimeMs: step.mtimeMs, body }
    if (!drained) {
      // The caller skipped this body: drain it so the next header lines up.
      for await (const _ of body) {
        // discard
      }
    }
  }
}

/** One entry of a tar in memory. `body()` is a view, checked against the tar's end when asked for. */
interface TarBytesEntry {
  name: string
  size: number
  type: string
  mtimeMs: number
  body(): Uint8Array
}

/**
 * `tarEntries` over a tar already in memory, synchronously, through the
 * same decoder. A body is checked against the tar's end when it is read,
 * as the stream reader checks it when it is drained, so the two refuse
 * a damaged archive with the same class at the same point.
 */
export function* tarEntriesSync(tar: Uint8Array): Generator<TarBytesEntry> {
  const dec = new TarDecoder()
  const len = tar.byteLength
  let off = 0
  for (;;) {
    if (off === len) return dec.eof()
    if (len - off < BLOCK) {
      throw new TarFormatError(`archive ends inside a header (${len - off} of ${BLOCK} bytes)`)
    }
    const step = dec.header(tar.subarray(off, off + BLOCK))
    off += BLOCK
    if (step.kind === 'end') return
    if (step.kind === 'zero') continue
    if (step.kind === 'extended') {
      const left = len - off
      if (left < step.padded) {
        if (left > 0) {
          throw new TarFormatError(
            `archive ends inside ${extendedWhat(step.type)} (${left} of ${step.padded} bytes)`,
          )
        }
        // At the very end a global header's body is skipped as absent, and
        // the end marker it lacks is what refuses the archive.
        if (step.type === 'g') continue
        throw new TarFormatError('archive ends inside an extended header')
      }
      if (step.type !== 'g')
        dec.extended(step.type, tar.subarray(off, off + step.padded), step.size)
      off += step.padded
      continue
    }
    const { name, size, padded } = step
    const at = off
    // The stream reader's messages, word for word: the parity rows compare them.
    const body = (): Uint8Array => {
      const left = len - at
      if (left < size) {
        throw new TarFormatError(`archive ends inside entry ${name} (${left} of ${size} bytes)`)
      }
      if (left < padded) {
        const pad = left - size
        throw new TarFormatError(
          pad === 0
            ? `archive ends inside padding after ${name}`
            : `archive ends inside padding after ${name} (${pad} of ${padded - size} bytes)`,
        )
      }
      return tar.subarray(at, at + size)
    }
    yield { name, size, type: step.type, mtimeMs: step.mtimeMs, body }
    // A body the caller skipped is still checked, as the stream drains it.
    body()
    off += padded
  }
}

// ─── Writer ───────────────────────────────────────────────────────────

/** One regular file to pack. `body` is read as it is written. */
export interface TarInput {
  name: string
  size: number
  /** Permission bits; the sidecar carries the exact value, this is for foreign readers. */
  mode?: number
  /** Seconds since epoch; the sidecar carries the millisecond value. */
  mtime?: number
  /** An iterable is read once, in order, as the entry is written (`size` is its length). */
  body: Blob | Uint8Array | string | AsyncIterable<Uint8Array>
}

const encoder = new TextEncoder()

function writeOctal(h: Uint8Array, off: number, len: number, n: number): void {
  const digits = n.toString(8).padStart(len - 1, '0')
  if (digits.length > len - 1)
    throw new TarFormatError(`value ${n} does not fit a ${len}-byte field`)
  h.set(encoder.encode(digits), off)
  h[off + len - 1] = 0
}

function header(
  name: string | Uint8Array,
  size: number,
  type: string,
  mode: number,
  mtime: number,
): Uint8Array {
  const h = new Uint8Array(BLOCK)
  const nameBytes = typeof name === 'string' ? encoder.encode(name) : name
  if (nameBytes.byteLength <= 100) {
    h.set(nameBytes, 0)
  } else {
    // ustar prefix split: the longest tail that fits 100 bytes, split at
    // a `/`, with the head fitting 155. Anything else needs pax.
    const cut = splitForUstar(nameBytes)
    if (cut === null)
      throw new TarFormatError(`name too long for ustar: ${decoder.decode(nameBytes)}`)
    h.set(nameBytes.subarray(cut + 1), 0)
    h.set(nameBytes.subarray(0, cut), 345)
  }
  writeOctal(h, 100, 8, mode & 0o7777)
  writeOctal(h, 108, 8, 0)
  writeOctal(h, 116, 8, 0)
  writeOctal(h, 124, 12, size)
  writeOctal(h, 136, 12, mtime)
  h[156] = type.charCodeAt(0)
  h.set(encoder.encode('ustar\0'), 257)
  h.set(encoder.encode('00'), 263)
  h.fill(32, 148, 156)
  let sum = 0
  for (let i = 0; i < BLOCK; i++) sum += h[i]!
  h.set(encoder.encode(sum.toString(8).padStart(6, '0')), 148)
  h[154] = 0
  h[155] = 32
  return h
}

/** Byte index of the `/` to split at, or null when no split satisfies both fields. */
function splitForUstar(name: Uint8Array): number | null {
  for (let i = name.byteLength - 1; i > 0; i--) {
    if (name[i] !== 47) continue
    const tail = name.byteLength - i - 1
    if (tail > 100) return null
    if (tail >= 1 && i <= 155) return i
  }
  return null
}

function paxRecord(key: string, value: string): Uint8Array {
  const body = encoder.encode(` ${key}=${value}\n`)
  let len = body.byteLength + 1
  while (String(len).length + body.byteLength !== len) len = String(len).length + body.byteLength
  const out = new Uint8Array(len)
  out.set(encoder.encode(String(len)), 0)
  out.set(body, String(len).length)
  return out
}

const padding = (size: number): Uint8Array => new Uint8Array((BLOCK - (size % BLOCK)) % BLOCK)
const padded = (size: number): number => size + ((BLOCK - (size % BLOCK)) % BLOCK)

/** Whether `name` needs a pax `path` record (fits neither ustar field). */
function needsPax(name: string): boolean {
  const bytes = encoder.encode(name)
  return bytes.byteLength > 100 && splitForUstar(bytes) === null
}

const isChunks = (b: TarInput['body']): b is AsyncIterable<Uint8Array> =>
  typeof b === 'object' && Symbol.asyncIterator in b

/** The exact number of bytes `tarPack` writes for these inputs. */
export function tarSize(inputs: readonly TarInput[]): number {
  let size = BLOCK * 2
  for (const i of inputs) {
    if (needsPax(i.name)) size += BLOCK + padded(paxRecord('path', i.name).byteLength)
    size += BLOCK + padded(i.size)
  }
  return size
}

/** An entry's blocks before its body: a pax `path` record when needed, then the ustar header. */
function entryHead(input: TarInput): Uint8Array[] {
  const mode = input.mode ?? 0o644
  const mtime = input.mtime ?? 0
  if (!needsPax(input.name)) return [header(input.name, input.size, '0', mode, mtime)]
  // Under a pax record the ustar name is a courtesy for readers that
  // ignore pax: its first 100 BYTES, never characters — a multibyte
  // name sliced by characters can be over 100 bytes again.
  const pax = paxRecord('path', input.name)
  return [
    header('PaxHeaders/entry', pax.byteLength, 'x', 0o644, mtime),
    pax,
    padding(pax.byteLength),
    header(encoder.encode(input.name).subarray(0, 100), input.size, '0', mode, mtime),
  ]
}

/**
 * `tarPack` of in-memory bodies, written into one buffer on this thread:
 * the same bytes, without a generator hop per block (the small-artifact
 * save, `packArtifactBytes`). Returns the bytes written.
 */
export function tarPackInto(
  inputs: readonly (TarInput & { body: Uint8Array | string })[],
  out: Uint8Array,
): number {
  let off = 0
  for (const input of inputs) {
    for (const block of entryHead(input)) {
      out.set(block, off)
      off += block.byteLength
    }
    const bytes = typeof input.body === 'string' ? encoder.encode(input.body) : input.body
    if (bytes.byteLength !== input.size)
      throw new TarFormatError(`${input.name}: ${bytes.byteLength} bytes, ${input.size} declared`)
    out.set(bytes, off)
    // `out` is zeroed: padding and the end marker are a skip.
    off += padded(input.size)
  }
  return off + BLOCK * 2
}

/**
 * Pack regular files as a tar stream: ustar with the name/prefix split,
 * a pax `path` record when a name fits neither field — exactly the
 * dialect `tarEntries` reads — and the two-block end marker. Bodies are
 * streamed, so memory is bounded by a chunk, never by an entry.
 */
export async function* tarPack(
  inputs: AsyncIterable<TarInput> | Iterable<TarInput>,
): AsyncGenerator<Uint8Array> {
  for await (const input of inputs) {
    yield* entryHead(input)
    if (input.body instanceof Blob || isChunks(input.body)) {
      let n = 0
      const chunks = input.body instanceof Blob ? input.body.stream() : input.body
      for await (const chunk of chunks) {
        n += chunk.byteLength
        yield chunk
      }
      if (n !== input.size)
        throw new TarFormatError(`${input.name}: ${n} bytes read, ${input.size} declared`)
    } else {
      const bytes = typeof input.body === 'string' ? encoder.encode(input.body) : input.body
      if (bytes.byteLength !== input.size)
        throw new TarFormatError(`${input.name}: ${bytes.byteLength} bytes, ${input.size} declared`)
      yield bytes
    }
    yield padding(input.size)
  }
  yield new Uint8Array(BLOCK * 2)
}
