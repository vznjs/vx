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

export interface TarEntry {
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
const decoder = new TextDecoder()

function field(h: Uint8Array, off: number, len: number): string {
  let end = off
  while (end < off + len && h[end] !== 0) end++
  return decoder.decode(h.subarray(off, end))
}

function octal(h: Uint8Array, off: number, len: number): number {
  const s = field(h, off, len).trim()
  if (s === '') return 0
  // GNU base-256 (high bit set) for sizes ≥ 8 GiB.
  if (h[off]! & 0x80) {
    let n = 0
    for (let i = off + 1; i < off + len; i++) n = n * 256 + h[i]!
    return n
  }
  const n = parseInt(s, 8)
  if (!Number.isFinite(n)) throw new TarFormatError(`bad octal field: ${JSON.stringify(s)}`)
  return n
}

function checksumOk(h: Uint8Array): boolean {
  const stored = octal(h, 148, 8)
  let sum = 0
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : h[i]!
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

/**
 * Iterate a tar stream entry by entry. Each entry's `body` MUST be fully
 * consumed (or the iterator drains it) before the next entry is read.
 */
export async function* tarEntries(stream: ReadableStream<Uint8Array>): AsyncGenerator<TarEntry> {
  const src = new Source(stream[Symbol.asyncIterator]())
  let pendingPath: string | undefined
  let pendingSize: number | undefined
  let zeroBlocks = 0
  for (;;) {
    const h = await src.exact(BLOCK, 'a header')
    if (h === null) {
      if (zeroBlocks === 0) throw new TarFormatError('archive has no end-of-archive marker')
      return
    }
    if (h.every((b) => b === 0)) {
      zeroBlocks++
      if (zeroBlocks >= 2) return
      continue
    }
    zeroBlocks = 0
    if (!checksumOk(h)) throw new TarFormatError('header checksum mismatch')
    const type = h[156] === 0 ? '0' : String.fromCharCode(h[156]!)
    const size = pendingSize ?? octal(h, 124, 12)
    const mtimeMs = octal(h, 136, 12) * 1000
    const padded = Math.ceil(size / BLOCK) * BLOCK
    const magic = field(h, 257, 6)
    const prefix = magic.startsWith('ustar') ? field(h, 345, 155) : ''
    const rawName = field(h, 0, 100)
    let name = pendingPath ?? (prefix ? `${prefix}/${rawName}` : rawName)
    pendingPath = undefined
    pendingSize = undefined

    if (type === 'x' || type === 'L') {
      // Extended header: applies to the NEXT entry only.
      const body = await src.exact(padded, 'an extended header')
      if (body === null) throw new TarFormatError('archive ends inside an extended header')
      if (type === 'x') {
        const pax = parsePax(body.subarray(0, size))
        const p = pax.get('path')
        if (p !== undefined) pendingPath = p
        const s = pax.get('size')
        if (s !== undefined) pendingSize = Number(s)
      } else {
        pendingPath = field(body, 0, size)
      }
      continue
    }
    if (type === 'g') {
      // pax global header: not used by Bun.Archive; skip its body.
      await src.exact(padded, 'a global header')
      continue
    }
    name = name.replace(/\/+$/, type === '5' ? '/' : '')

    let drained = false
    const body = (async function* (): AsyncIterable<Uint8Array> {
      if (size > 0) for await (const c of src.take(size, `entry ${name}`)) yield c
      const pad = padded - size
      if (pad > 0 && (await src.exact(pad, `padding after ${name}`)) === null) {
        throw new TarFormatError(`archive ends inside padding after ${name}`)
      }
      drained = true
    })()
    yield { name, size, type, mtimeMs, body }
    if (!drained) {
      // The caller skipped this body: drain it so the next header lines up.
      for await (const _ of body) {
        // discard
      }
    }
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
  body: Blob | Uint8Array | string
}

const encoder = new TextEncoder()

function writeOctal(h: Uint8Array, off: number, len: number, n: number): void {
  const digits = n.toString(8).padStart(len - 1, '0')
  if (digits.length > len - 1)
    throw new TarFormatError(`value ${n} does not fit a ${len}-byte field`)
  h.set(encoder.encode(digits), off)
  h[off + len - 1] = 0
}

function header(name: string, size: number, type: string, mode: number, mtime: number): Uint8Array {
  const h = new Uint8Array(BLOCK)
  const nameBytes = encoder.encode(name)
  if (nameBytes.byteLength <= 100) {
    h.set(nameBytes, 0)
  } else {
    // ustar prefix split: the longest tail that fits 100 bytes, split at
    // a `/`, with the head fitting 155. Anything else needs pax.
    const cut = splitForUstar(nameBytes)
    if (cut === null) throw new TarFormatError(`name too long for ustar: ${name}`)
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

/** The exact number of bytes `tarPack` writes for these inputs. */
export function tarSize(inputs: readonly TarInput[]): number {
  let size = BLOCK * 2
  for (const i of inputs) {
    if (needsPax(i.name)) size += BLOCK + padded(paxRecord('path', i.name).byteLength)
    size += BLOCK + padded(i.size)
  }
  return size
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
    const mode = input.mode ?? 0o644
    const mtime = input.mtime ?? 0
    let headerName = input.name
    if (needsPax(input.name)) {
      const pax = paxRecord('path', input.name)
      yield header('PaxHeaders/entry', pax.byteLength, 'x', 0o644, mtime)
      yield pax
      yield padding(pax.byteLength)
      headerName = input.name.slice(0, 100)
    }
    yield header(headerName, input.size, '0', mode, mtime)
    if (input.body instanceof Blob) {
      let n = 0
      for await (const chunk of input.body.stream()) {
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
