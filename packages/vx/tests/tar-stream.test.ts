// The streaming tar reader behind a bounded-memory restore. Pinned against
// what Bun.Archive writes (ustar with the name/prefix split; pax past its
// limits), hand-built pax and GNU long-name headers, a corrupt checksum and
// a truncated archive — the two shapes that must be errors, never short
// entries.

import { describe, expect, it } from 'bun:test'
import { TarFormatError, tarEntries } from '../src/cache/tar-stream.js'

const enc = new TextEncoder()
const streamOf = (bytes: Uint8Array, chunk = 1000): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(c) {
      for (let i = 0; i < bytes.byteLength; i += chunk) c.enqueue(bytes.subarray(i, i + chunk))
      c.close()
    },
  })

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
