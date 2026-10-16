// A directory swapped for a link out of the tree after an entry was staged
// beside its target, and before the rename, does not carry the rename out:
// the commit checks each target directory again. Bun has no `renameat`
// against a held directory fd, so the check is by path, as close to the
// rename as the extractor gets.

import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'bun:test'
import { extractArtifactStream } from '../src/cache/archive.js'
import { tarPack } from '../src/cache/tar-stream.js'
import { withSum } from './helpers/artifact-sum.js'
import { streamOf } from './helpers/stream.js'

let root = ''
afterEach(() => rmSync(root, { recursive: true, force: true }))

it('a target directory swapped for a link out between stage and rename writes nothing out', async () => {
  root = mkdtempSync(path.join(os.tmpdir(), 'vx-link-swap-'))
  const dest = path.join(root, 'proj')
  const outside = path.join(root, 'outside')
  mkdirSync(path.join(dest, 'dist', 'sub'), { recursive: true })
  mkdirSync(outside)
  const parts: Uint8Array[] = []
  for await (const c of tarPack([{ name: 'outputs/dist/sub/x.js', size: 2, body: 'x\n' }]))
    parts.push(c)
  const tar = await withSum(new Uint8Array(await new Blob(parts).arrayBuffer()))
  const err = await extractArtifactStream(streamOf(tar), dest, undefined, () => {
    // Staged: the temp sits in dist/sub. Move the directory, temp and all,
    // out of the tree and leave a link to it where it stood.
    renameSync(path.join(dest, 'dist', 'sub'), path.join(outside, 'sub'))
    symlinkSync(path.join(outside, 'sub'), path.join(dest, 'dist', 'sub'))
  }).then(
    () => null,
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(Error)
  expect(existsSync(path.join(outside, 'sub', 'x.js'))).toBe(false)
})
