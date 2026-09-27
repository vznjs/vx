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

const oneCall = spyOn(Bun, 'zstdDecompress')
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
    expect(oneCall).not.toHaveBeenCalled()
  })

  it('from a file too', async () => {
    const f = Bun.file(path.join(os.tmpdir(), `vx-zstd-frames-${process.pid}.zst`))
    await Bun.write(f, bomb)
    try {
      await expect(decode(f, 1000)).rejects.toBeInstanceOf(CorruptArtifactError)
      expect(oneCall).not.toHaveBeenCalled()
    } finally {
      await f.delete()
    }
  })

  it('under the cap decodes whole, as a stream', async () => {
    expect(await decode(bomb, 1_000_000)).toBe(50_100)
    expect(oneCall).not.toHaveBeenCalled()
  })
})

describe('one frame (control)', () => {
  it('takes the one call, small or of many blocks', async () => {
    const noise = crypto.getRandomValues(new Uint8Array(60_000))
    const big = concat(noise, noise, noise, noise, noise) // 300 KB: several 128 KiB blocks
    for (const body of [new Uint8Array(100), big]) {
      oneCall.mockClear()
      expect(await decode(Bun.zstdCompressSync(body), 10_000_000)).toBe(body.length)
      expect(oneCall).toHaveBeenCalledTimes(1)
    }
  })
})
