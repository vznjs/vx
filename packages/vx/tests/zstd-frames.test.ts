// The one-call decode is for ONE whole zstd frame (A-5). The size gate read
// the first frame's declaration alone and `Bun.zstdDecompress` decodes every
// frame there is: a 100-byte frame with more appended passed the ceiling and
// expanded whole in memory — 2 GiB from a 32 KB remote body under a 64 MiB
// cap — before the result's length was checked. Anything but one frame now
// decodes as a stream under the running count, and vx's own artifacts,
// single frames, keep the one call.

import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import { CorruptArtifactError } from '../src/cache/layer.js'
import { decodedTar } from '../src/cache/zstd.js'

// The one call is the async decoder, or the calling thread's for a small frame.
const asyncCall = spyOn(Bun, 'zstdDecompress')
const syncCall = spyOn(Bun, 'zstdDecompressSync')
const oneCall = {
  calls: (): number => asyncCall.mock.calls.length + syncCall.mock.calls.length,
  mockClear(): void {
    asyncCall.mockClear()
    syncCall.mockClear()
  },
}
afterEach(() => oneCall.mockClear())

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

async function decode(bytes: Uint8Array | Bun.BunFile, cap: number): Promise<number> {
  const s = await decodedTar(bytes, 'h', cap)
  return (await new Response(s).arrayBuffer()).byteLength
}

describe('a body of more than one zstd frame', () => {
  const small = Bun.zstdCompressSync(new Uint8Array(100))
  const bomb = concat(small, Bun.zstdCompressSync(new Uint8Array(50_000)))

  it('is refused by the running count, never handed whole to the one-call decoder', async () => {
    let refused: unknown
    await decode(bomb, 1000).catch((err: unknown) => (refused = err))
    expect(refused).toBeInstanceOf(CorruptArtifactError)
    expect((refused as Error).message).toContain('decompresses past 1000 bytes')
    expect(oneCall.calls()).toBe(0)
  })

  it('from a file too', async () => {
    const f = Bun.file(path.join(os.tmpdir(), `vx-zstd-frames-${process.pid}.zst`))
    await Bun.write(f, bomb)
    try {
      await expect(decode(f, 1000)).rejects.toBeInstanceOf(CorruptArtifactError)
      expect(oneCall.calls()).toBe(0)
    } finally {
      await f.delete()
    }
  })

  it('under the cap decodes whole, as a stream', async () => {
    expect(await decode(bomb, 1_000_000)).toBe(50_100)
    expect(oneCall.calls()).toBe(0)
  })

  it('at exactly the cap decodes whole: the count refuses past it, not at it', async () => {
    expect(await decode(bomb, 50_100)).toBe(50_100)
    await expect(decode(bomb, 50_099)).rejects.toBeInstanceOf(CorruptArtifactError)
  })
})

describe('one frame (control)', () => {
  it('takes the one call, small or of many blocks', async () => {
    const noise = crypto.getRandomValues(new Uint8Array(60_000))
    const big = concat(noise, noise, noise, noise, noise) // 300 KB: several 128 KiB blocks
    for (const body of [new Uint8Array(100), big]) {
      oneCall.mockClear()
      expect(await decode(Bun.zstdCompressSync(body), 10_000_000)).toBe(body.length)
      expect(oneCall.calls()).toBe(1)
    }
  })

  it('decodes a small frame on the calling thread and a large one off it', async () => {
    // A thread-pool round trip cost more CPU than decoding a one-file
    // artifact (Q-1); a large one keeps the pool.
    const large = crypto.getRandomValues(new Uint8Array(300_000))
    for (const [body, onThread] of [
      [new Uint8Array(100), 1],
      [large, 0],
    ] as const) {
      oneCall.mockClear()
      expect(await decode(Bun.zstdCompressSync(body), 10_000_000)).toBe(body.length)
      expect([syncCall.mock.calls.length, asyncCall.mock.calls.length]).toEqual([
        onThread,
        1 - onThread,
      ])
    }
  })

  it('takes the one call through RLE blocks, a content checksum, and an empty body', async () => {
    // Each shape walks a different step of the frame check: an RLE block
    // holds one byte whatever it expands to, a checksum is four bytes past
    // the last block, and an empty body's last block header ends the buffer.
    const runs = new Uint8Array(300_000).fill(7)
    const rle = Bun.zstdCompressSync(runs)
    const body = new Uint8Array(100).fill(3)
    const plain = Bun.zstdCompressSync(body)
    const sum = Number(Bun.hash.xxHash64(body) & 0xffffffffn)
    const checked = concat(plain, new Uint8Array(new Uint32Array([sum]).buffer))
    checked[4] = checked[4]! | 0b100
    const cases: Array<[Uint8Array, number]> = [
      [rle, runs.length],
      [checked, body.length],
      [Bun.zstdCompressSync(new Uint8Array(0)), 0],
    ]
    for (const [frame, size] of cases) {
      oneCall.mockClear()
      expect(await decode(frame, 10_000_000)).toBe(size)
      expect(oneCall.calls()).toBe(1)
    }
  })

  it('refuses a large file by its declaration, before decoding a byte', async () => {
    // Past the stream threshold the file is read as a stream, but its
    // first bytes are still asked for the declared size.
    const noise = concat(
      ...Array.from({ length: 80 }, () => crypto.getRandomValues(new Uint8Array(65_536))),
    )
    const frame = Bun.zstdCompressSync(noise)
    expect(frame.length).toBeGreaterThan(4 * 1024 * 1024) // CONTROL: the stream path
    const f = Bun.file(path.join(os.tmpdir(), `vx-zstd-large-${process.pid}.zst`))
    await Bun.write(f, frame)
    try {
      await expect(decode(f, 1_000_000)).rejects.toThrow(
        `declares ${noise.length} decompressed bytes (> 1000000 cap)`,
      )
    } finally {
      await f.delete()
    }
  })
})
