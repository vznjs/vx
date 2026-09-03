// The streaming tar reader behind a bounded-memory restore. Pinned against
// what Bun.Archive writes (ustar with the name/prefix split; pax past its
// limits), hand-built pax and GNU long-name headers, a corrupt checksum and
// a truncated archive — the two shapes that must be errors, never short
// entries.

import { describe, expect, it } from 'bun:test'
import { TarFormatError, tarEntries, tarPack, tarSize } from '../src/cache/tar-stream.js'
import { streamOf } from './helpers/stream.js'

const enc = new TextEncoder()

async function collect(bytes: Uint8Array, chunk?: number) {
  const out: Array<{ name: string; size: number; type: string; text: string }> = []
  for await (const e of tarEntries(streamOf(bytes, chunk))) {
    const parts: Uint8Array[] = []
    for await (const c of e.body) parts.push(new Uint8Array(c))
    out.push({
      name: e.name,
      size: e.size,
      type: e.type,
      text: new TextDecoder().decode(Buffer.concat(parts)),
    })
  }
  return out
}

function header(fields: { name: string; size: number; type: string; prefix?: string }): Uint8Array {
  const h = new Uint8Array(512)
  h.set(enc.encode(fields.name).subarray(0, 100), 0)
  h.set(enc.encode('0000644\0'), 100)
  h.set(enc.encode('0000000\0'), 108)
  h.set(enc.encode('0000000\0'), 116)
  h.set(enc.encode(fields.size.toString(8).padStart(11, '0') + '\0'), 124)
  h.set(enc.encode('00000000000\0'), 136)
  h[156] = fields.type.charCodeAt(0)
  h.set(enc.encode('ustar\0'), 257)
  h.set(enc.encode('00'), 263)
  if (fields.prefix) h.set(enc.encode(fields.prefix).subarray(0, 155), 345)
  h.set(enc.encode('        '), 148)
  let sum = 0
  for (const b of h) sum += b
  h.set(enc.encode(sum.toString(8).padStart(6, '0') + '\0 '), 148)
  return h
}
const padTo512 = (b: Uint8Array): Uint8Array => {
  const out = new Uint8Array(Math.ceil(b.byteLength / 512) * 512)
  out.set(b)
  return out
}
const concat = (...parts: Uint8Array[]): Uint8Array => new Uint8Array(Buffer.concat(parts))
const EOF_BLOCKS = new Uint8Array(1024)

describe('tarEntries', () => {
  it('round-trips what Bun.Archive writes, across chunk boundaries of every size', async () => {
    const long = 'outputs/' + 'd'.repeat(120) + '/' + 'f'.repeat(90) + '.txt' // uses the prefix field
    const veryLong = 'outputs/' + 'x'.repeat(300) + '.txt' // past ustar: pax header
    const big = 'a'.repeat(1234)
    const tar = await new Bun.Archive({
      'outputs/short.txt': 'hi',
      [long]: 'deep',
      [veryLong]: 'far',
      'outputs/big.txt': big,
      '.vx-meta.json': '{}',
    }).bytes()
    for (const chunk of [1, 7, 512, 1000, 1 << 20]) {
      const got = await collect(tar, chunk)
      expect(got.map((e) => [e.name, e.size, e.text.length])).toEqual([
        ['outputs/short.txt', 2, 2],
        [long, 4, 4],
        [veryLong, 3, 3],
        ['outputs/big.txt', 1234, 1234],
        ['.vx-meta.json', 2, 2],
      ])
      expect(got[3]!.text).toBe(big)
    }
  })

  it('a pax header (x) overrides the path and size of the entry that follows it', async () => {
    const name = 'outputs/' + 'p'.repeat(300) + '.txt'
    const rec = (k: string, v: string): string => {
      // `<len> <k>=<v>\n` where len counts itself.
      let len = k.length + v.length + 3
      len += String(len).length
      if (String(len).length !== String(len - 1).length) len++
      return `${len} ${k}=${v}\n`
    }
    const pax = enc.encode(rec('path', name) + rec('size', '5'))
    const tar = concat(
      header({ name: 'PaxHeader/x', size: pax.byteLength, type: 'x' }),
      padTo512(pax),
      header({ name: 'outputs/x', size: 0, type: '0' }), // ustar size lies; pax wins
      padTo512(enc.encode('hello')),
      EOF_BLOCKS,
    )
    expect(await collect(tar)).toEqual([{ name, size: 5, type: '0', text: 'hello' }])
  })

  it('a GNU long-name header (L) names the entry that follows it', async () => {
    const name = 'outputs/' + 'g'.repeat(180) + '.txt'
    const tar = concat(
      header({ name: '././@LongLink', size: name.length, type: 'L' }),
      padTo512(enc.encode(name)),
      header({ name: name.slice(0, 100), size: 5, type: '0' }),
      padTo512(enc.encode('hello')),
      EOF_BLOCKS,
    )
    expect(await collect(tar)).toEqual([{ name, size: 5, type: '0', text: 'hello' }])
  })

  it('reports a non-regular entry with its type and skips its body when the caller does', async () => {
    const tar = concat(
      header({ name: 'outputs/link', size: 0, type: '2' }),
      header({ name: 'outputs/dir/', size: 0, type: '5' }),
      header({ name: 'outputs/f.txt', size: 3, type: '0' }),
      padTo512(enc.encode('abc')),
      EOF_BLOCKS,
    )
    const names: string[] = []
    for await (const e of tarEntries(streamOf(tar))) names.push(`${e.type}:${e.name}`) // bodies never read
    expect(names).toEqual(['2:outputs/link', '5:outputs/dir/', '0:outputs/f.txt'])
  })

  it('refuses a corrupt checksum', async () => {
    const tar = concat(
      header({ name: 'outputs/f.txt', size: 3, type: '0' }),
      padTo512(enc.encode('abc')),
      EOF_BLOCKS,
    )
    tar[0] = tar[0]! ^ 0x01
    await expect(collect(tar)).rejects.toThrow(TarFormatError)
    await expect(collect(tar)).rejects.toThrow(/checksum/)
  })

  it('refuses a truncated archive rather than yielding a short entry', async () => {
    const full = concat(
      header({ name: 'outputs/f.txt', size: 1000, type: '0' }),
      padTo512(enc.encode('x'.repeat(1000))),
      EOF_BLOCKS,
    )
    await expect(collect(full.subarray(0, 512 + 300))).rejects.toThrow(/ends inside/)
    await expect(collect(full.subarray(0, 512 + 1024))).rejects.toThrow(
      /end-of-archive|ends inside/,
    )
    expect((await collect(full))[0]!.size).toBe(1000) // CONTROL
  })
})

describe('tarPack', () => {
  const inputs = () => {
    const prefixed = 'outputs/' + 'd'.repeat(120) + '/' + 'f'.repeat(90) + '.txt'
    const paxOnly = 'outputs/' + 'x'.repeat(300) + '.txt'
    return [
      { name: 'stdout', size: 3, body: 'log' },
      { name: 'outputs/empty', size: 0, body: new Uint8Array(0) },
      { name: 'outputs/run.sh', size: 9, mode: 0o755, mtime: 1_700_000_000, body: '#!/bin/sh' },
      { name: prefixed, size: 4, body: new Blob(['deep']) },
      { name: paxOnly, size: 3, body: 'far' },
      { name: 'outputs/big.bin', size: 3000, body: new Uint8Array(3000).fill(7) },
    ]
  }
  async function bytesOf(): Promise<Uint8Array> {
    const parts: Uint8Array[] = []
    for await (const c of tarPack(inputs())) parts.push(c)
    return concat(...parts)
  }

  it("round-trips through vx's own reader with names, sizes, bytes and header mode", async () => {
    const tar = await bytesOf()
    expect(tar.byteLength).toBe(tarSize(inputs())) // the plan's size is exact, pax included
    expect(tar.byteLength % 512).toBe(0)
    const got = await collect(tar, 333)
    expect(got.map((e) => [e.name, e.size, e.type])).toEqual(
      inputs().map((i) => [i.name, i.size, '0']),
    )
    expect(got[2]!.text).toBe('#!/bin/sh')
    expect(got[5]!.text).toBe('\x07'.repeat(3000))
  })

  it('is readable by libarchive (Bun.Archive) — an independent implementation', async () => {
    const files = await new Bun.Archive(await bytesOf()).files()
    expect([...files.keys()].sort()).toEqual(
      inputs()
        .map((i) => i.name)
        .sort(),
    )
    expect(await files.get('stdout')!.text()).toBe('log')
    expect(files.get('outputs/' + 'x'.repeat(300) + '.txt')!.size).toBe(3)
  })

  it('is listed identically by the system tar (external control)', async () => {
    const tar = await bytesOf()
    const proc = Bun.spawn(['tar', '-tf', '-'], {
      stdin: new Blob([tar]),
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const out = await new Response(proc.stdout).text()
    expect(await proc.exited).toBe(0)
    expect(out.trim().split('\n').sort()).toEqual(
      inputs()
        .map((i) => i.name)
        .sort(),
    )
  })

  it('refuses a body whose length disagrees with its declared size', async () => {
    const bad = [{ name: 'outputs/x', size: 5, body: 'abc' }]
    await expect(
      (async () => {
        for await (const _ of tarPack(bad)) {
          /* drain */
        }
      })(),
    ).rejects.toThrow(TarFormatError)
  })
})
