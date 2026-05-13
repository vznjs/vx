// Ring-buffer + render helper for the TUI's sparklines. Pure data
// math; no terminal awareness. Each metric (throughput, CPU %, remote
// ops/s, parallel %) owns one buffer and gets sampled at 1 Hz from the
// renderer's tick.

const BLOCKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇'] as const

export interface SparklineBuf {
  samples: Float32Array
  /** Index of the NEXT write slot. After capacity is reached, wraps. */
  head: number
  /** Saturates at samples.length once the buffer is full. */
  len: number
}

export function newSparklineBuf(capacity: number): SparklineBuf {
  return {
    samples: new Float32Array(Math.max(0, capacity)),
    head: 0,
    len: 0,
  }
}

/**
 * Push a single sample. NaN/negative values are clamped to 0 — they
 * blow up scaling otherwise (the renderer divides by `max - min`).
 */
export function pushSample(buf: SparklineBuf, value: number): void {
  const cap = buf.samples.length
  if (cap === 0) return
  const v = Number.isFinite(value) && value > 0 ? value : 0
  buf.samples[buf.head] = v
  buf.head = (buf.head + 1) % cap
  if (buf.len < cap) buf.len++
}

/**
 * Read the buffer oldest-first as a plain array. Useful for tests +
 * for renderers that want to walk the data without dealing with the
 * wrap index themselves.
 */
export function readOldestToNewest(buf: SparklineBuf): number[] {
  const cap = buf.samples.length
  if (cap === 0 || buf.len === 0) return []
  const start = (buf.head - buf.len + cap) % cap
  const out = Array.from({ length: buf.len }, () => 0)
  for (let i = 0; i < buf.len; i++) {
    out[i] = buf.samples[(start + i) % cap] ?? 0
  }
  return out
}

/**
 * Render the buffer as a width-bounded unicode sparkline string.
 *
 * - `width` defaults to `buf.samples.length`. If `len < width`, the
 *   result is left-padded with spaces (oldest-first), so the latest
 *   sample is always at the right edge — the convention every
 *   dashboard uses.
 * - If `len > width`, we drop the oldest `len - width` samples; the
 *   rightmost `width` survive.
 * - The lowest sample maps to `▁`, the highest to `▇`. A flat series
 *   (max === min) renders entirely as `▁`. (`█` is reserved — full-
 *   height blocks can clip into the next row in some terminals.)
 */
export function renderSparkline(buf: SparklineBuf, width?: number): string {
  if (buf.len === 0) return ''
  const data = readOldestToNewest(buf)
  // Default: render exactly `len` chars (no padding). Pass an explicit
  // width to align with a fixed-width column.
  const w = width === undefined ? data.length : width
  if (w <= 0) return ''

  // Truncate to the rightmost `w` samples when we overflow.
  const slice = data.length > w ? data.slice(data.length - w) : data
  const min = Math.min(...slice)
  const max = Math.max(...slice)
  const range = max - min
  const chars: string[] = []
  for (const v of slice) {
    const idx = range === 0 ? 0 : Math.round(((v - min) / range) * (BLOCKS.length - 1))
    chars.push(BLOCKS[idx] ?? BLOCKS[0]!)
  }
  // Left-pad with spaces if the data is shorter than the requested width.
  const padding = w - chars.length
  return padding > 0 ? ' '.repeat(padding) + chars.join('') : chars.join('')
}
