// The restore keeps a target that already holds the entry's bytes and sets
// its mtime at commit. An in-place rewrite between the compare and the commit
// kept the inode, so the writer's bytes got the entry's mtime, were stamped,
// and every later hit skipped the restore over them.

import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'bun:test'
import { extractArtifactStream } from '../src/cache/archive.js'
import { tarPack } from '../src/cache/tar-stream.js'
import { withSum } from './helpers/artifact-sum.js'

const made: string[] = []
afterEach(async () => {
  for (const d of made.splice(0)) await rm(d, { recursive: true, force: true })
})

const MTIME = 1_600_000_000_123

async function artifact(): Promise<Uint8Array> {
  const meta = JSON.stringify({ version: 1, files: { 'outputs/dist/a.txt': [0o644, MTIME] } })
  const parts: Uint8Array[] = []
  for await (const c of tarPack([
    { name: 'outputs/dist/a.txt', size: 3, body: 'aa\n' },
    { name: 'stdout', size: 0, body: '' },
    { name: '.vx-meta.json', size: Buffer.byteLength(meta), body: meta },
  ]))
    parts.push(c)
  return withSum(new Uint8Array(await new Blob(parts).arrayBuffer()))
}

it('an output rewritten in place while a restore keeps it is not stamped with the entry mtime', async () => {
  const dest = mkdtempSync(path.join(os.tmpdir(), 'vx-hunt-keep-'))
  made.push(dest)
  const target = path.join(dest, 'dist/a.txt')
  mkdirSync(path.dirname(target))
  // Already the entry's bytes: the restore keeps the file instead of renaming over it.
  writeFileSync(target, 'aa\n')
  const tar = await artifact()
  const split = 1024 // the entry's header and its one body block
  let step = 0
  const stream = new ReadableStream<Uint8Array>({
    async pull(c) {
      if (step++ === 0) {
        c.enqueue(tar.subarray(0, split))
        return
      }
      // The keep decision is taken; a writer rewrites the file in place
      // (same inode, same size) before the commit.
      await Bun.sleep(100)
      writeFileSync(target, 'bb\n')
      c.enqueue(tar.subarray(split))
      c.close()
    },
  })
  // A refusal ("changed while it was restored") is a red run, never a wrong tree.
  const refused = await extractArtifactStream(stream, dest, undefined).then(
    () => false,
    () => true,
  )
  if (refused) return
  const bytes = readFileSync(target, 'utf8')
  const mtime = Math.floor(statSync(target).mtimeMs)
  // Either the entry's bytes landed, or the writer's bytes keep the writer's mtime.
  expect({ bytes, forged: bytes !== 'aa\n' && mtime === MTIME }).toEqual({
    bytes: 'aa\n',
    forged: false,
  })
})
