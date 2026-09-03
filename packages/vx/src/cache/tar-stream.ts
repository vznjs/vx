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
