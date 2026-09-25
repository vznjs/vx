// What an artifact's restore takes from where, when the sidecar is silent or
// the host differs: the header's mtime without a sidecar (and not an epoch
// one), and the sidecar's mode under a umask that is not the one the temp
// file was made with. Name safety is
// archive-security.test.ts.

import { mkdtempSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { extractArtifactStream, packArtifact, scanArtifact } from '../src/cache/archive.js'
import { tarPack, type TarInput } from '../src/cache/tar-stream.js'
import { streamOf } from './helpers/stream.js'

const dir = mkdtempSync(path.join(os.tmpdir(), 'vx-archive-meta-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
let n = 0
const fresh = (): string => mkdtempSync(path.join(dir, `d${n++}-`))

/** A tar with no `.vx-meta.json`: what a foreign or older producer writes. */
async function bareTar(inputs: TarInput[]): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  for await (const c of tarPack([{ name: 'stdout', size: 0, body: '' }, ...inputs])) chunks.push(c)
  return new Uint8Array(await new Blob(chunks).arrayBuffer())
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
})
