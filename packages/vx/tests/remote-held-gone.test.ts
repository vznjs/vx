// The remote's batch probe said it held a key, but the GET found nothing (an
// eviction between them, or a wire whose index outlives its blob). The task
// re-ran and its upload was skipped as "held", so the key was never repaired.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { Cache } from '../src/cache/cache.js'
import { LayeredCache, type RemoteCacheLayer } from '../src/cache/layered-cache.js'
import { layeredOver } from './helpers/layered.js'
import { TAR_STORE } from './helpers/tar-store.js'

let root: string
let local: Cache
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-held-gone-'))
  local = new Cache(
    path.join(root, '.vx', 'cache'),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    TAR_STORE,
  )
})
afterEach(async () => {
  local.close()
  await rm(root, { recursive: true, force: true })
})

async function save(cache: LayeredCache, hash: string): Promise<void> {
  const projectDir = path.join(root, 'p')
  const out = path.join(projectDir, 'dist', 'out.txt')
  await mkdir(path.dirname(out), { recursive: true })
  await writeFile(out, `produced-${hash}`)
  await cache.save({
    hash,
    projectDir,
    outputFiles: [out],
    entry: { taskId: 'p#build', command: 'echo', durationMs: 5, stdout: '' },
  })
  await cache.drainUploads()
}

it('a key the probe called held but whose GET found nothing is uploaded by the re-run', async () => {
  const puts: string[] = []
  // The batch probe and the object store disagree: the entry was evicted
  // between them (or the wire's index outlived its blob).
  const remote: RemoteCacheLayer = {
    has: async () => ({}),
    hasMany: async (hs) => new Map(hs.map((h) => [h, {}])),
    get: async () => null,
    put: async (h) => void puts.push(h),
  }
  const layered = layeredOver(local, remote, { onRemoteError: () => {} })
  expect((await layered.remoteHasMany(['k']))?.has('k')).toBe(true)
  expect(await layered.get('k', { taskId: 'p#build', command: 'echo' })).toBeNull()
  await save(layered, 'k')
  expect(puts).toEqual(['k'])
})
