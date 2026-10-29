// The restore keeps a target that already holds the entry's bytes (item
// 886). A stale output this user cannot read, of the entry's size, threw
// EACCES from that comparison and failed the restore with "make the
// declared output paths writable", though renaming over it works.

import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'bun:test'
import { extractArtifactStream } from '../src/cache/archive.js'
import { tarPack } from '../src/cache/tar-stream.js'
import { withSum } from './helpers/artifact-sum.js'
import { skipAsRoot } from './helpers/nonroot-gate.js'
import { streamOf } from './helpers/stream.js'

it.skipIf(skipAsRoot('an unreadable stale output'))(
  'a stale output this user cannot read, of the entry size, is replaced',
  async () => {
    const dest = mkdtempSync(path.join(os.tmpdir(), 'vx-unreadable-'))
    try {
      writeFileSync(path.join(dest, 'a.txt'), 'old!\n')
      chmodSync(path.join(dest, 'a.txt'), 0o000)
      const meta = JSON.stringify({
        version: 1,
        files: { 'outputs/a.txt': [0o644, 1_700_000_000_000] },
      })
      const parts: Uint8Array[] = []
      for await (const c of tarPack([
        { name: 'stdout', size: 0, body: '' },
        { name: 'outputs/a.txt', size: 5, body: 'new!\n' },
        { name: '.vx-meta.json', size: Buffer.byteLength(meta), body: meta },
      ]))
        parts.push(c)
      const tar = await withSum(new Uint8Array(await new Blob(parts).arrayBuffer()))
      await extractArtifactStream(streamOf(tar), dest, undefined)
      expect(readFileSync(path.join(dest, 'a.txt'), 'utf8')).toBe('new!\n')
      expect(statSync(path.join(dest, 'a.txt')).mode & 0o777).toBe(0o644 & ~process.umask())
    } finally {
      await rm(dest, { recursive: true, force: true })
    }
  },
)
