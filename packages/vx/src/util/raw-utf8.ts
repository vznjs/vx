// A task's output is bytes, and vx handles it as text (masking, framing,
// bounds, readyWhen). A plain UTF-8 decode turns each byte that is not
// UTF-8 into U+FFFD, so the terminal and the cached replay got bytes the
// task never wrote. Here each such byte becomes a lone surrogate
// U+DC80..U+DCFF (Python's `surrogateescape`), which no UTF-8 decode can
// produce, and `rawBytes` turns it back into its byte where text becomes
// bytes again. Valid UTF-8 takes the native decoder alone: the escape walk
// runs only when it refused the bytes.

const LOSSY = new TextDecoder('utf-8', { ignoreBOM: true })
const FATAL = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const ENCODER = new TextEncoder()
const REPLACEMENT = Uint8Array.of(0xef, 0xbf, 0xbd)

/** The length of the valid UTF-8 sequence at `i`, or 0 when its first byte is not one. */
function sequenceAt(b: Uint8Array, i: number): number {
  const c = b[i]!
  if (c < 0x80) return 1
  const cont = (j: number, lo = 0x80, hi = 0xbf): boolean => {
    const x = b[i + j]
    return x !== undefined && x >= lo && x <= hi
  }
  if (c >= 0xc2 && c <= 0xdf) return cont(1) ? 2 : 0
  if (c >= 0xe0 && c <= 0xef) {
    const lo = c === 0xe0 ? 0xa0 : 0x80
    const hi = c === 0xed ? 0x9f : 0xbf
    return cont(1, lo, hi) && cont(2) ? 3 : 0
  }
  if (c >= 0xf0 && c <= 0xf4) {
    const lo = c === 0xf0 ? 0x90 : 0x80
    const hi = c === 0xf4 ? 0x8f : 0xbf
    return cont(1, lo, hi) && cont(2) && cont(3) ? 4 : 0
  }
  return 0
}

function escapeDecode(b: Uint8Array): string {
  let out = ''
  let run = 0
  let i = 0
  while (i < b.length) {
    const n = sequenceAt(b, i)
    if (n > 0) {
      i += n
      continue
    }
    if (i > run) out += LOSSY.decode(b.subarray(run, i))
    out += String.fromCharCode(0xdc00 + b[i]!)
    i++
    run = i
  }
  return run === 0 ? LOSSY.decode(b) : out + LOSSY.decode(b.subarray(run))
}

/** `bytes` as text, each byte that is not UTF-8 kept as its escape. */
export function decodeRaw(bytes: Uint8Array): string {
  // The fatal decoder, not a U+FFFD search after a lossy one: the search
  // scans every decoded string, a sixth again of the decode's time.
  try {
    return FATAL.decode(bytes)
  } catch {
    return escapeDecode(bytes)
  }
}

/**
 * Where the incomplete sequence `bytes` ends on starts, or `bytes.length`
 * when it ends on a whole one: its lead byte, at most three back, with only
 * continuation bytes after it and too few of them.
 */
function incompleteTail(b: Uint8Array): number {
  for (let i = b.length - 1; i >= 0 && i >= b.length - 3; i--) {
    const c = b[i]!
    if (c >= 0x80 && c <= 0xbf) continue
    const need = c >= 0xf0 && c <= 0xf4 ? 4 : c >= 0xe0 ? 3 : c >= 0xc2 && c <= 0xdf ? 2 : 1
    return i + need > b.length ? i : b.length
  }
  return b.length
}

/** `decodeRaw` over a stream: a sequence split across two chunks is held for the next. */
export class RawUtf8Decoder {
  private held: Uint8Array | null = null

  decode(chunk?: Uint8Array, opts?: { stream?: boolean }): string {
    let b = chunk ?? new Uint8Array(0)
    if (this.held !== null) {
      const joined = new Uint8Array(this.held.byteLength + b.byteLength)
      joined.set(this.held)
      joined.set(b, this.held.byteLength)
      b = joined
      this.held = null
    }
    if (opts?.stream === true) {
      const end = incompleteTail(b)
      if (end < b.length) {
        this.held = b.slice(end)
        b = b.subarray(0, end)
      }
    }
    return b.byteLength === 0 ? '' : decodeRaw(b)
  }
}

/**
 * `text` as the bytes to write: itself when well-formed, else its UTF-8
 * with each escape back as its byte (any other lone surrogate as U+FFFD,
 * as a string write encodes it).
 */
export function rawBytes(text: string): string | Uint8Array {
  if ((text as string & { isWellFormed(): boolean }).isWellFormed()) return text
  return rawEncode(text)
}

/** `text` as UTF-8 bytes, each escape back as its byte. */
export function rawEncode(text: string): Uint8Array {
  if ((text as string & { isWellFormed(): boolean }).isWellFormed()) return ENCODER.encode(text)
  const parts: Uint8Array[] = []
  let size = 0
  const add = (p: Uint8Array): void => {
    parts.push(p)
    size += p.byteLength
  }
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c < 0xd800 || c > 0xdfff) continue
    if (c <= 0xdbff) {
      const d = text.charCodeAt(i + 1)
      if (d >= 0xdc00 && d <= 0xdfff) {
        i++
        continue
      }
    }
    if (i > start) add(ENCODER.encode(text.slice(start, i)))
    add(c >= 0xdc80 && c <= 0xdcff ? Uint8Array.of(c - 0xdc00) : REPLACEMENT)
    start = i + 1
  }
  if (start < text.length) add(ENCODER.encode(text.slice(start)))
  const out = new Uint8Array(size)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.byteLength
  }
  return out
}
