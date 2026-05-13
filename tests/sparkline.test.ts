// Sparkline ring-buffer + render tests.

import { describe, expect, it } from 'bun:test'
import {
  pushSample,
  renderSparkline,
  newSparklineBuf,
  readOldestToNewest,
} from '../src/tui/primitives/sparkline.ts'

describe('SparklineBuf', () => {
  it('starts empty', () => {
    const b = newSparklineBuf(8)
    expect(b.len).toBe(0)
    expect(readOldestToNewest(b)).toEqual([])
  })

  it('grows up to its capacity then wraps oldest-first', () => {
    const b = newSparklineBuf(4)
    pushSample(b, 1)
    pushSample(b, 2)
    pushSample(b, 3)
    expect(b.len).toBe(3)
    expect(readOldestToNewest(b)).toEqual([1, 2, 3])

    pushSample(b, 4)
    expect(b.len).toBe(4)
    expect(readOldestToNewest(b)).toEqual([1, 2, 3, 4])

    // 5th: oldest (1) is overwritten; len stays 4.
    pushSample(b, 5)
    expect(b.len).toBe(4)
    expect(readOldestToNewest(b)).toEqual([2, 3, 4, 5])

    pushSample(b, 6)
    expect(readOldestToNewest(b)).toEqual([3, 4, 5, 6])
  })

  it('handles zero capacity gracefully (no-op buffer)', () => {
    const b = newSparklineBuf(0)
    pushSample(b, 1)
    pushSample(b, 2)
    expect(b.len).toBe(0)
    expect(readOldestToNewest(b)).toEqual([])
  })
})

describe('renderSparkline', () => {
  it('returns empty when the buffer is empty', () => {
    const b = newSparklineBuf(8)
    expect(renderSparkline(b)).toBe('')
  })

  it('maps a single sample to the bottom block', () => {
    const b = newSparklineBuf(8)
    pushSample(b, 0)
    // With max === min, all samples map to the lowest block.
    expect(renderSparkline(b)).toBe('▁')
  })

  it('maps the highest sample to ▇ (block 7) — the second-highest unicode bar (full block triggers row clipping in narrow lines)', () => {
    const b = newSparklineBuf(4)
    pushSample(b, 0)
    pushSample(b, 1)
    pushSample(b, 2)
    pushSample(b, 3)
    const rendered = renderSparkline(b)
    expect(rendered.length).toBe(4)
    // First (min) sample is ▁; last (max) is ▇.
    expect(rendered[0]).toBe('▁')
    expect(rendered.at(-1)).toBe('▇')
  })

  it('truncates the oldest samples when width is smaller than len', () => {
    const b = newSparklineBuf(8)
    for (let i = 0; i < 6; i++) pushSample(b, i)
    // Width 3 ⇒ render only the last three samples (3, 4, 5).
    const r = renderSparkline(b, 3)
    expect(r.length).toBe(3)
    // Last char (highest) is the max block.
    expect(r.at(-1)).toBe('▇')
  })

  it('left-pads with spaces when len is smaller than width', () => {
    const b = newSparklineBuf(8)
    pushSample(b, 0)
    pushSample(b, 1)
    const r = renderSparkline(b, 5)
    expect(r.length).toBe(5)
    expect(r.startsWith('   ')).toBe(true) // 3 spaces + 2 samples
    expect(r.endsWith('▇')).toBe(true)
  })

  it('treats NaN / negative samples as 0 for scaling', () => {
    const b = newSparklineBuf(4)
    pushSample(b, 0)
    pushSample(b, NaN)
    pushSample(b, -1)
    pushSample(b, 10)
    const r = renderSparkline(b)
    expect(r.length).toBe(4)
    // Max (10) → ▇; the others → ▁.
    expect(r.at(-1)).toBe('▇')
  })
})
