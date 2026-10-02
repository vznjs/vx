// The tar reader reads a numeric field off its bytes when it is the plain
// shape every writer emits (octal digits between ASCII spaces, ended by a
// NUL or the field's end) and through the full parse otherwise. These rows
// hold each shape the full parse answers to that same answer, on one chunk
// (the in-memory read) and on 7-byte chunks (a header across chunks).

import { describe, expect, it } from 'bun:test'
import { tarEntries } from '../src/cache/tar-stream.js'
import { streamOf } from './helpers/stream.js'

const enc = new TextEncoder()

/** A ustar header whose size field is `sizeField`, checksummed after. */
function header(sizeField: Uint8Array): Uint8Array {
  const h = new Uint8Array(512)
  h.set(enc.encode('outputs/a'), 0)
  h.set(enc.encode('0000644\0'), 100)
  h.set(enc.encode('0000000\0'), 108)
  h.set(enc.encode('0000000\0'), 116)
  h.set(sizeField.subarray(0, 12), 124)
  h.set(enc.encode('00000000000\0'), 136)
  h[156] = '0'.charCodeAt(0)
  h.set(enc.encode('ustar\0'), 257)
  h.set(enc.encode('00'), 263)
  h.set(enc.encode('        '), 148)
  let sum = 0
  for (const b of h) sum += b
  h.set(enc.encode(sum.toString(8).padStart(6, '0') + '\0 '), 148)
  return h
}

async function read(sizeField: Uint8Array, chunk?: number): Promise<string> {
  // The payload block is NUL bytes, so a size-0 entry ends the archive there.
  const tar = new Uint8Array(512 * 4)
  tar.set(header(sizeField), 0)
  try {
    const sizes: number[] = []
    for await (const e of tarEntries(streamOf(tar, chunk))) {
      for await (const _ of e.body) {
        // drain
      }
      sizes.push(e.size)
    }
    return `size ${sizes.join(',')}`
  } catch (err) {
    return (err as Error).message
  }
}

const field = (...parts: Array<string | number[]>): Uint8Array => {
  const out = new Uint8Array(12)
  let at = 0
  for (const p of parts) {
    const bytes = typeof p === 'string' ? enc.encode(p) : Uint8Array.from(p)
    out.set(bytes, at)
    at += bytes.byteLength
  }
  return out
}

describe('a tar numeric field', () => {
  const rows: Array<[string, Uint8Array, string]> = [
    ['zero-padded, NUL-ended', field('00000000005\0'), 'size 5'],
    ['all twelve bytes digits, no NUL', field('000000000005'), 'size 5'],
    ['space-led', field('          5\0'), 'size 5'],
    ['space-ended before its NUL', field('5          \0'), 'size 5'],
    ['empty (all NUL)', field(''), 'size 0'],
    ['all spaces', field('           \0'), 'size 0'],
    ['tab-led: the full parse trims it', field('\t0000000005\0'), 'size 5'],
    ['NBSP-ended: the full parse trims it', field('000000005', [0xc2, 0xa0], '\0'), 'size 5'],
    ['digits split by a space', field('0 5        \0'), 'bad octal field: "0 5"'],
    ['a non-octal digit', field('00000000008\0'), 'bad octal field: "00000000008"'],
  ]
  for (const [what, bytes, answer] of rows) {
    it(`${what}: ${answer}`, async () => {
      expect(await read(bytes)).toBe(answer)
      expect(await read(bytes, 7)).toBe(answer)
    })
  }
})
