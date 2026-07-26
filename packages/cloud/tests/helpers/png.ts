// A minimal PNG reader + pixel differ for the visual-regression suite.
//
// Deliberately dependency-free (the repo's standing rule — the same reason
// `tar.ts` parses tar headers and `sigv4.ts` signs by hand): we only ever read
// what headless Chromium writes, which is 8-bit non-interlaced truecolor
// (colorType 2 or 6) or grayscale (0/4). Anything else throws loudly rather
// than silently comparing garbage.

import { inflateSync } from 'node:zlib'

export interface DecodedPng {
  width: number
  height: number
  /** Row-major RGBA, 4 bytes per pixel. */
  rgba: Uint8Array
}

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** Bytes per pixel of the raw (pre-expansion) sample layout. */
function channelsOf(colorType: number): number {
  switch (colorType) {
    case 0:
      return 1 // grayscale
    case 2:
      return 3 // truecolor
    case 4:
      return 2 // grayscale + alpha
    case 6:
      return 4 // truecolor + alpha
    default:
      throw new Error(`png: unsupported color type ${colorType} (palette/indexed not handled)`)
  }
}

/** The Paeth predictor from the PNG spec (filter type 4). */
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  return pb <= pc ? b : c
}

export function decodePng(bytes: Uint8Array): DecodedPng {
  for (let i = 0; i < SIGNATURE.length; i++) {
    if (bytes[i] !== SIGNATURE[i]) throw new Error('png: bad signature')
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  let interlace = 0
  const idat: Uint8Array[] = []

  let off = 8
  while (off + 8 <= bytes.length) {
    const len = view.getUint32(off)
    const type = String.fromCharCode(
      bytes[off + 4]!,
      bytes[off + 5]!,
      bytes[off + 6]!,
      bytes[off + 7]!,
    )
    const body = bytes.subarray(off + 8, off + 8 + len)
    if (type === 'IHDR') {
      width = view.getUint32(off + 8)
      height = view.getUint32(off + 12)
      bitDepth = bytes[off + 16]!
      colorType = bytes[off + 17]!
      interlace = bytes[off + 20]!
    } else if (type === 'IDAT') {
      idat.push(body)
    } else if (type === 'IEND') {
      break
    }
    off += 12 + len // length + type + data + crc
  }

  if (bitDepth !== 8) throw new Error(`png: unsupported bit depth ${bitDepth}`)
  if (interlace !== 0) throw new Error('png: interlaced images are not supported')
  const channels = channelsOf(colorType)

  // One flat zlib stream split across the IDAT chunks.
  let total = 0
  for (const c of idat) total += c.length
  const stream = new Uint8Array(total)
  let at = 0
  for (const c of idat) {
    stream.set(c, at)
    at += c.length
  }
  // IDAT carries a zlib-wrapped stream (header + adler32), not raw deflate —
  // `Bun.inflateSync` is raw-only, so go through node:zlib.
  const raw = inflateSync(stream)

  const stride = width * channels
  const expected = (stride + 1) * height
  if (raw.length < expected) {
    throw new Error(`png: short pixel data (${raw.length} < ${expected})`)
  }

  // Un-filter in place into a contiguous sample buffer (no per-row copies).
  const samples = new Uint8Array(stride * height)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!
    const src = y * (stride + 1) + 1
    const dst = y * stride
    const up = dst - stride
    for (let x = 0; x < stride; x++) {
      const v = raw[src + x]!
      const a = x >= channels ? samples[dst + x - channels]! : 0
      const b = y > 0 ? samples[up + x]! : 0
      const c = x >= channels && y > 0 ? samples[up + x - channels]! : 0
      let out: number
      switch (filter) {
        case 0:
          out = v
          break
        case 1:
          out = v + a
          break
        case 2:
          out = v + b
          break
        case 3:
          out = v + ((a + b) >> 1)
          break
        case 4:
          out = v + paeth(a, b, c)
          break
        default:
          throw new Error(`png: unknown filter ${filter} on row ${y}`)
      }
      samples[dst + x] = out & 0xff
    }
  }

  // Expand to RGBA so every comparison speaks one layout.
  const rgba = new Uint8Array(width * height * 4)
  for (let p = 0; p < width * height; p++) {
    const s = p * channels
    const d = p * 4
    if (colorType === 6) {
      rgba[d] = samples[s]!
      rgba[d + 1] = samples[s + 1]!
      rgba[d + 2] = samples[s + 2]!
      rgba[d + 3] = samples[s + 3]!
    } else if (colorType === 2) {
      rgba[d] = samples[s]!
      rgba[d + 1] = samples[s + 1]!
      rgba[d + 2] = samples[s + 2]!
      rgba[d + 3] = 255
    } else if (colorType === 0) {
      const g = samples[s]!
      rgba[d] = g
      rgba[d + 1] = g
      rgba[d + 2] = g
      rgba[d + 3] = 255
    } else {
      const g = samples[s]!
      rgba[d] = g
      rgba[d + 1] = g
      rgba[d + 2] = g
      rgba[d + 3] = samples[s + 1]!
    }
  }
  return { width, height, rgba }
}

export interface PixelDiff {
  /** Fraction of pixels that differ beyond the tolerance, 0..1. */
  ratio: number
  differing: number
  total: number
  /** Set when the two images aren't the same size — ratio is then 1. */
  sizeMismatch?: { a: string; b: string }
}

/**
 * Compare two decoded images. `tolerance` is the per-channel 0-255 delta a
 * pixel may drift before it counts as different — small anti-aliasing jitter
 * shouldn't read as a regression, a moved element should.
 */
export function diffPixels(a: DecodedPng, b: DecodedPng, tolerance = 8): PixelDiff {
  if (a.width !== b.width || a.height !== b.height) {
    return {
      ratio: 1,
      differing: 0,
      total: 0,
      sizeMismatch: { a: `${a.width}x${a.height}`, b: `${b.width}x${b.height}` },
    }
  }
  const total = a.width * a.height
  let differing = 0
  for (let p = 0; p < total; p++) {
    const i = p * 4
    if (
      Math.abs(a.rgba[i]! - b.rgba[i]!) > tolerance ||
      Math.abs(a.rgba[i + 1]! - b.rgba[i + 1]!) > tolerance ||
      Math.abs(a.rgba[i + 2]! - b.rgba[i + 2]!) > tolerance ||
      Math.abs(a.rgba[i + 3]! - b.rgba[i + 3]!) > tolerance
    ) {
      differing++
    }
  }
  return { ratio: total === 0 ? 0 : differing / total, differing, total }
}
