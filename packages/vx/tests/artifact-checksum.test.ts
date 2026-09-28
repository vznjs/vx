// An artifact's last entry is a CRC-32 over every entry before it (v36,
// L-19). Nothing else checked an entry's BODY: tar sums its headers, and
// neither zstd writer asks for a frame checksum, so a byte flipped in a raw
// zstd block — incompressible output, stored as is — decoded clean and a
// hit replayed the wrong bytes (1,141 of 1,141 flips in a random 8 KB body,
// probed). A damaged artifact is refused before anything it holds lands.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { extractArtifactStream, packArtifact, scanArtifact } from '../src/cache/archive.js'
import { Cache, CorruptArtifactError } from '../src/cache/cache.js'
import { tarPack } from '../src/cache/tar-stream.js'
import { streamOf } from './helpers/stream.js'

const dir = mkdtempSync(path.join(os.tmpdir(), 'vx-l19-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const noise = crypto.getRandomValues(new Uint8Array(8000))
const src = path.join(dir, 'blob.bin')
writeFileSync(src, noise)

/** Where the output's body sits in the tar: its bytes are unique noise. */
const bodyAt = (tar: Uint8Array): number =>
  Buffer.from(tar).indexOf(Buffer.from(noise.subarray(0, 64)))

const packed = (key = 'k1') =>
  packArtifact({ key, stdout: 'built\n', outputs: new Map([['outputs/blob.bin', src]]) })

const flipped = (tar: Uint8Array, at: number): Uint8Array => {
  const m = tar.slice()
  m[at] = m[at]! ^ 0x10
  return m
}

describe('an artifact whose bytes changed after it was packed', () => {
  it('is refused on scan and on restore, and nothing it holds lands', async () => {
    const tar = await packed()
    const at = bodyAt(tar) + 4000
    expect(at).toBeGreaterThan(4000)
    const dest = path.join(dir, 'bad')
    const outcomes = await Promise.all([
      scanArtifact(streamOf(flipped(tar, at))).then(
        () => 'scanned',
        (e: Error) => e.message,
      ),
      extractArtifactStream(streamOf(flipped(tar, at)), dest, undefined).then(
        () => 'restored',
        (e: Error) => e.message,
      ),
    ])
    expect(
      outcomes.map((o) => o.startsWith('artifact content does not match its checksum')),
    ).toEqual([true, true])
    expect(existsSync(path.join(dest, 'blob.bin'))).toBe(false)
  })

  it('CONTROL: the untouched artifact restores its bytes', async () => {
    const dest = path.join(dir, 'good')
    await extractArtifactStream(streamOf(await packed()), dest, undefined)
    expect(Buffer.compare(readFileSync(path.join(dest, 'blob.bin')), Buffer.from(noise))).toBe(0)
  })

  it('an artifact with no checksum, or an entry after it, is refused', async () => {
    const tar = await packed()
    // The sum entry's header opens with its name.
    const sumAt = Buffer.from(tar).indexOf(Buffer.from('.vx-sum\0'))
    expect(sumAt % 512).toBe(0)
    const cut = new Uint8Array([...tar.subarray(0, sumAt), ...new Uint8Array(1024)])
    let end = tar.length
    while (tar.subarray(end - 512, end).every((b) => b === 0)) end -= 512
    const extra: Uint8Array[] = []
    for await (const c of tarPack([{ name: 'outputs/late.txt', size: 1, body: 'x' }])) extra.push(c)
    const late = new Uint8Array([...tar.subarray(0, end), ...Buffer.concat(extra)])
    const why = (t: Uint8Array) =>
      scanArtifact(streamOf(t)).then(
        () => 'scanned',
        (e: Error) => e.message,
      )
    expect([await why(cut), await why(late)]).toEqual([
      'artifact carries no checksum',
      "entry outputs/late.txt follows the artifact's checksum",
    ])
  })

  it('from a remote: a damaged body is a corrupt artifact, never an entry', async () => {
    const cache = new Cache(path.join(dir, 'cache'))
    try {
      const tar = await packed('h-l19')
      const bad = await Bun.zstdCompress(flipped(tar, bodyAt(tar) + 100))
      const good = await Bun.zstdCompress(tar)
      const meta = { taskId: 'p#t', command: 'x', durationMs: 1 }
      const refused = await cache.ingest('h-l19', new Blob([bad]), meta).then(
        () => 'indexed',
        (e: unknown) => (e instanceof CorruptArtifactError ? 'corrupt' : String(e)),
      )
      expect({ refused, entry: await cache.get('h-l19') }).toEqual({
        refused: 'corrupt',
        entry: null,
      })
      // CONTROL: the same artifact undamaged indexes.
      await cache.ingest('h-l19', new Blob([good]), meta)
      expect((await cache.get('h-l19'))?.stdout).toBe('built\n')
    } finally {
      cache.close()
    }
  })
})
