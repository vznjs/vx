// What an artifact's restore takes from where, when the sidecar is silent or
// the host differs: the header's mtime without a sidecar (and not an epoch
// one), and the sidecar's mode under a umask that is not the one the temp
// file was made with. And the sidecar's stat restored whole at its edges
// (A-4): a mode of 000 and an mtime of 0 were skipped (the file came back
// 0644 and stamped now, so every later hit restored it again), and an mtime
// before 1970 wrote an unreadable tar header, so its task never saved. Name
// safety is archive-security.test.ts.

import {
  mkdtempSync,
  rmSync,
  type Stats,
  statSync,
  utimesSync,
  writeFileSync,
  chmodSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { extractArtifactStream, packArtifact, scanArtifact } from '../src/cache/archive.js'
import { tarPack, type TarInput } from '../src/cache/tar-stream.js'
import { streamOf } from './helpers/stream.js'
import { withSum } from './helpers/artifact-sum.js'

const dir = mkdtempSync(path.join(os.tmpdir(), 'vx-archive-meta-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
let n = 0
const fresh = (): string => mkdtempSync(path.join(dir, `d${n++}-`))

/** A tar with no `.vx-meta.json`: what a foreign or older producer writes. */
async function bareTar(inputs: TarInput[]): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  for await (const c of tarPack([{ name: 'stdout', size: 0, body: '' }, ...inputs])) chunks.push(c)
  return await withSum(new Uint8Array(await new Blob(chunks).arrayBuffer()))
}

describe('an artifact with no sidecar', () => {
  it('scans to the header mtime and a readable mode', async () => {
    const tar = await bareTar([{ name: 'outputs/a.txt', size: 1, body: 'a', mtime: 1_700_000_000 }])
    const { entries } = await scanArtifact(streamOf(tar))
    expect(entries.find((e) => e.name === 'outputs/a.txt')).toEqual({
      name: 'outputs/a.txt',
      size: 1,
      mode: 0o644,
      mtimeMs: 1_700_000_000_000,
    })
  })

  it('a header mtime of 0 is unknown: the restored file keeps the time it was written', async () => {
    const dest = fresh()
    const before = Date.now() - 60_000
    const tar = await bareTar([{ name: 'outputs/a.txt', size: 1, body: 'a', mtime: 0 }])
    await extractArtifactStream(streamOf(tar), dest, undefined)
    expect(statSync(path.join(dest, 'a.txt')).mtimeMs).toBeGreaterThan(before)
  })
})

describe('extractArtifactStream', () => {
  it("restores the sidecar's mode whatever the umask made the temp file", async () => {
    // The chmod is skipped when the mode already matches the temp's. Under a
    // umask of 002 a new file is 0664, so a 0644 entry must still be chmodded.
    const src = path.join(fresh(), 'a.txt')
    writeFileSync(src, 'a')
    chmodSync(src, 0o644)
    const tar = await packArtifact({ stdout: '', outputs: new Map([['outputs/a.txt', src]]) })
    const dest = fresh()
    const saved = process.umask(0o002)
    try {
      await extractArtifactStream(streamOf(tar), dest, undefined)
    } finally {
      process.umask(saved)
    }
    expect(statSync(path.join(dest, 'a.txt')).mode & 0o777).toBe(0o644)
  })

  // A small entry's temp is made by `writeFile` (0666 & ~umask), a large
  // one's by Bun's file writer (0664 & ~umask). Under umask 000 they differ,
  // and the chmod skip read the first entry's temp mode for all of them:
  // the other kind came back with the wrong mode, and every later hit
  // restored it again.
  for (const [order, mode] of [
    [['small.txt', 'big.bin'], 0o666],
    [['big.bin', 'small.txt'], 0o664],
  ] as const) {
    it(`restores each mode under umask 000, ${order.join(' before ')}`, async () => {
      // Both carry the mode the FIRST entry's temp is made with, so the
      // second is the one whose temp differs from it.
      const srcDir = fresh()
      writeFileSync(path.join(srcDir, 'small.txt'), 's')
      writeFileSync(path.join(srcDir, 'big.bin'), new Uint8Array(4 * 1024 * 1024 + 1))
      for (const f of order) chmodSync(path.join(srcDir, f), mode)
      const tar = await packArtifact({
        stdout: '',
        outputs: new Map(order.map((f) => [`outputs/${f}`, path.join(srcDir, f)])),
      })
      const dest = fresh()
      const saved = process.umask(0)
      try {
        await extractArtifactStream(streamOf(tar), dest, undefined)
      } finally {
        process.umask(saved)
      }
      expect(order.map((f) => statSync(path.join(dest, f)).mode & 0o777)).toEqual([mode, mode])
    })
  }
})

const META = JSON.stringify({ version: 1, files: { 'outputs/a.txt': [0, 1_700_000_000_000] } })

describe('the sidecar at its edges', () => {
  /** Pack one output as it is on disk, restore it into a fresh directory, stat it. */
  async function roundTrip(prepare: (src: string) => void): Promise<Stats> {
    const src = path.join(fresh(), 'a.txt')
    writeFileSync(src, 'a')
    prepare(src)
    const tar = await packArtifact({ stdout: '', outputs: new Map([['outputs/a.txt', src]]) })
    const dest = fresh()
    await extractArtifactStream(streamOf(tar), dest, undefined)
    return statSync(path.join(dest, 'a.txt'))
  }

  it('restores a mode of 000', async () => {
    // Built by hand: only root can read a mode-000 file to pack it, and CI
    // is not root. The sidecar records what root's pack would.
    const tar = await bareTar([
      { name: 'outputs/a.txt', size: 1, body: 'a', mtime: 1_700_000_000 },
      {
        name: '.vx-meta.json',
        size: META.length,
        body: META,
      },
    ])
    const dest = fresh()
    await extractArtifactStream(streamOf(tar), dest, undefined)
    expect(statSync(path.join(dest, 'a.txt')).mode & 0o777).toBe(0)
  })

  it('restores an mtime of 0, as SOURCE_DATE_EPOCH=0 writes it', async () => {
    expect((await roundTrip((f) => utimesSync(f, 0, 0))).mtimeMs).toBe(0)
  })

  it('packs and restores an mtime before 1970', async () => {
    // A Date: Bun's `utimesSync` reads a negative number of seconds as now.
    const t = new Date(Date.UTC(1960, 0, 1))
    expect((await roundTrip((f) => utimesSync(f, t, t))).mtimeMs).toBe(t.getTime())
  })

  it('control: an ordinary mode and mtime round-trip as before', async () => {
    const st = await roundTrip((f) => {
      chmodSync(f, 0o755)
      utimesSync(f, 1_700_000_000, 1_700_000_000)
    })
    expect([st.mode & 0o777, st.mtimeMs]).toEqual([0o755, 1_700_000_000_000])
  })
})
