// A target directory swapped for a link out of the tree after the commit's
// containment check, before the rename lands, does not leave the entry
// outside: the rename runs on the thread pool, so another writer can swap
// the directory in that gap (a concurrent restore's plant, restore-ported's
// race row, flaked 1 in ~120 on CI, 2026-10-17). `rename` is wrapped to
// swap at the call; `mock.module` holds for the whole file.
import * as fsPromises from 'node:fs/promises'
import { mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, symlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, mock } from 'bun:test'
import { tarPack } from '../src/cache/tar-stream.js'
import { withSum } from './helpers/artifact-sum.js'
import { streamOf } from './helpers/stream.js'

const real = { ...fsPromises }
let swapAt = ''
let swap = (): void => undefined
await mock.module('node:fs/promises', () => ({
  ...real,
  rename: async (from: string, to: string) => {
    if (swapAt !== '' && to === swapAt) {
      swapAt = ''
      swap()
    }
    return real.rename(from, to)
  },
}))
const { extractArtifactStream } = await import('../src/cache/archive.js')

let root = ''
afterEach(() => {
  swapAt = ''
  rmSync(root, { recursive: true, force: true })
})

async function tarOf(files: Record<string, string>): Promise<Uint8Array> {
  const parts: Uint8Array[] = []
  const entries = Object.entries(files).map(([name, body]) => ({
    name: `outputs/${name}`,
    size: Buffer.byteLength(body),
    body,
  }))
  for await (const c of tarPack(entries)) parts.push(c)
  return withSum(new Uint8Array(await new Blob(parts).arrayBuffer()))
}

it('a directory swapped for a link out between the check and the rename keeps nothing out', async () => {
  root = mkdtempSync(path.join(os.tmpdir(), 'vx-swap-rename-'))
  const dest = path.join(root, 'proj')
  const outside = path.join(root, 'outside')
  mkdirSync(path.join(dest, 'dist'), { recursive: true })
  mkdirSync(outside)
  swapAt = path.join(dest, 'dist', 'x.js')
  swap = () => {
    renameSync(path.join(dest, 'dist'), path.join(root, 'moved'))
    symlinkSync(outside, path.join(dest, 'dist'))
  }
  const err = await extractArtifactStream(
    streamOf(await tarOf({ 'dist/x.js': 'x\n' })),
    dest,
    undefined,
    undefined,
    undefined,
    root,
  ).then(
    () => null,
    (e: unknown) => e,
  )
  expect(swapAt).toBe('')
  expect(err).toBeInstanceOf(Error)
  expect(readdirSync(outside)).toEqual([])
})
