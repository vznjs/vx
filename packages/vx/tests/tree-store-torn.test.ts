// A tree-form entry (the default store) whose file was cut short on disk —
// the shape a crash leaves of a file renamed in before its data reached the
// disk — restores green with the short bytes; the tar form refuses the same
// damage by its checksum and drops the entry.
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { Cache, DEFAULT_STORE } from '../src/cache/cache.js'
import { TAR_STORE } from './helpers/tar-store.js'

let root: string
let proj: string
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'vx-tree-cut-'))
  proj = path.join(root, 'p')
  mkdirSync(path.join(proj, 'dist'), { recursive: true })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const body = crypto.getRandomValues(new Uint8Array(64 * 1024))

/** Save `dist/a.bin`, then cut the stored copy to `keep` bytes. */
async function damaged(store: typeof DEFAULT_STORE, keep: number): Promise<Cache> {
  const out = path.join(proj, 'dist', 'a.bin')
  writeFileSync(out, body)
  const cacheDir = path.join(root, 'cache')
  const cache = new Cache(cacheDir, undefined, undefined, undefined, undefined, undefined, store)
  await cache.save({
    hash: 'k1',
    projectDir: proj,
    outputFiles: [out],
    entry: { taskId: 'p#build', command: 'c', durationMs: 1, stdout: '' },
  })
  const tree = readdirSync(cacheDir, { recursive: true }).find((p) =>
    String(p).endsWith(path.join('outputs', 'dist', 'a.bin')),
  )
  if (tree !== undefined) truncateSync(path.join(cacheDir, String(tree)), keep)
  else {
    const tar = readdirSync(cacheDir, { recursive: true }).find((p) =>
      String(p).endsWith('.tar.zst'),
    )!
    const at = path.join(cacheDir, String(tar))
    const bytes = readFileSync(at)
    bytes[bytes.length >> 1]! ^= 0x10
    writeFileSync(at, bytes)
  }
  return cache
}

const outcome = (cache: Cache, into: string) =>
  cache.restoreOutputs('k1', into, root, { files: ['dist/**'], workspaceFiles: [] }).then(
    () => `restored ${readFileSync(path.join(into, 'dist', 'a.bin')).byteLength} bytes`,
    (e: Error) => e.name,
  )

it.each([
  ['copy-out (outputs absent)', 0],
  ['copy-out (outputs absent), cut in half', 32 * 1024],
])('a stored tree file cut short is refused, not restored: %s', async (_, keep) => {
  const cache = await damaged(DEFAULT_STORE, keep)
  try {
    rmSync(path.join(proj, 'dist'), { recursive: true })
    expect(await outcome(cache, proj)).toBe('ArtifactVanishedError')
  } finally {
    cache.close()
  }
})

it('a stored tree file cut short is refused, not restored: through the extractor (outputs present)', async () => {
  const cache = await damaged(DEFAULT_STORE, 0)
  try {
    writeFileSync(path.join(proj, 'dist', 'a.bin'), 'stale')
    expect(await outcome(cache, proj)).toBe('ArtifactVanishedError')
  } finally {
    cache.close()
  }
})

it('CONTROL: the tar form refuses its damaged bytes', async () => {
  const cache = await damaged(TAR_STORE, 0)
  try {
    rmSync(path.join(proj, 'dist'), { recursive: true })
    expect(await outcome(cache, proj)).toBe('ArtifactVanishedError')
  } finally {
    cache.close()
  }
})

it('a stored tree file cut short is not uploaded under a fresh checksum', async () => {
  const cache = await damaged(DEFAULT_STORE, 0)
  try {
    const pinned = await cache.pinArtifact('k1').then(
      async (p) => {
        await p.release()
        return `packed ${p.body.size} bytes`
      },
      (e: Error) => e.name,
    )
    expect(pinned).toBe('CorruptArtifactError')
  } finally {
    cache.close()
  }
})
