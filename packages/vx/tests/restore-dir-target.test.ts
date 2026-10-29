// A restore leaves each output as it was or as the entry: a target that is a
// directory fails its rename, so it is refused before any rename lands.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { extractArtifactStream, packArtifact } from '../src/cache/archive.js'
import { streamOf } from './helpers/stream.js'

let root: string
let proj: string
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'vx-restore-dir-target-'))
  proj = path.join(root, 'p')
  mkdirSync(path.join(proj, 'dist'), { recursive: true })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

it('a directory where the entry holds a file replaces no output before it fails', async () => {
  const src = path.join(root, 'src')
  mkdirSync(src)
  writeFileSync(path.join(src, 'a.txt'), 'new a')
  writeFileSync(path.join(src, 'z.txt'), 'new z')
  const tar = await packArtifact({
    key: 'k',
    stdout: '',
    outputs: new Map([
      ['outputs/dist/a.txt', path.join(src, 'a.txt')],
      ['outputs/dist/z.txt', path.join(src, 'z.txt')],
    ]),
  })
  writeFileSync(path.join(proj, 'dist', 'a.txt'), 'old a')
  // `dist/**` covers this empty directory, and the clean takes files only.
  mkdirSync(path.join(proj, 'dist', 'z.txt'))
  const err = await extractArtifactStream(
    streamOf(tar),
    proj,
    root,
    undefined,
    undefined,
    root,
  ).catch((e: NodeJS.ErrnoException) => e.code)
  expect([err, readFileSync(path.join(proj, 'dist', 'a.txt'), 'utf8')]).toEqual(['EISDIR', 'old a'])
})
