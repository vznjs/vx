// `cache.store`: every combination of embeddings × compress × verify saves,
// restores and uploads the same bytes; only where they live differs.
import { existsSync, readdirSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { ArtifactVanishedError, Cache, type StoreOptions } from '../src/cache/index.js'
import { parseSettingValue } from '../src/settings.js'

const SMALL = new TextEncoder().encode('small output\n')
const LARGE = crypto.getRandomValues(new Uint8Array(48 * 1024))
const HASH = '0123456789abcdef'

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-cache-store-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function saved(
  store: StoreOptions,
  bytes: Uint8Array,
  name = 'c',
): Promise<{ cache: Cache; proj: string }> {
  const proj = path.join(root, `p-${name}`)
  await mkdir(path.join(proj, 'out'), { recursive: true })
  await writeFile(path.join(proj, 'out/a.bin'), bytes)
  const cache = new Cache(
    path.join(root, name),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    store,
  )
  await cache.save({
    hash: HASH,
    entry: { taskId: 'p#build', command: 'build', durationMs: 1, stdout: 'built\n' },
    projectDir: proj,
    outputFiles: [path.join(proj, 'out/a.bin')],
  })
  await rm(path.join(proj, 'out'), { recursive: true })
  return { cache, proj }
}

const form = (cacheDir: string): string => {
  const names = readdirSync(cacheDir, { recursive: true }).map(String)
  if (names.some((n) => n.endsWith(`${HASH}.tree`))) return 'tree'
  if (names.some((n) => n.endsWith(`${HASH}.tar.zst`))) return 'tar'
  return 'inline'
}

const treeFile = (cacheDir: string): string => {
  const rel = readdirSync(cacheDir, { recursive: true })
    .map(String)
    .find((n) => n.endsWith(`${HASH}.tree`))!
  return path.join(cacheDir, rel, 'outputs/out/a.bin')
}

const combos: StoreOptions[] = []
for (const embeddings of [32 * 1024, 0])
  for (const compress of [true, false])
    for (const verify of ['stat', 'hash', 'none'] as const)
      combos.push({ embeddings, compress, verify })

describe.each(combos)('cache.store %o', (store) => {
  for (const [label, bytes] of [
    ['small', SMALL],
    ['large', LARGE],
  ] as const) {
    it(`a ${label} output restores byte-exact, in the form the store names`, async () => {
      const { cache, proj } = await saved(store, bytes)
      const expected = store.compress
        ? store.embeddings > 0 && label === 'small'
          ? 'inline'
          : 'tar'
        : store.embeddings > 0 && label === 'small'
          ? 'inline'
          : 'tree'
      expect(form(path.join(root, 'c'))).toBe(expected)
      expect((await cache.get(HASH))?.stdout).toBe('built\n')
      await cache.restoreOutputs(HASH, proj)
      expect(new Uint8Array(await readFile(path.join(proj, 'out/a.bin')))).toEqual(bytes)
      cache.close()
    })

    it(`a ${label} entry uploads an archive another store ingests and restores`, async () => {
      const { cache } = await saved(store, bytes)
      const pinned = await cache.pinArtifact(HASH)
      const other = new Cache(
        path.join(root, 'o'),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        store,
      )
      await other.ingest(HASH, pinned.body, { taskId: 'p#build', command: 'build', durationMs: 1 })
      await pinned.release()
      const into = path.join(root, 'into')
      await other.restoreOutputs(HASH, into)
      expect(new Uint8Array(await readFile(path.join(into, 'out/a.bin')))).toEqual(bytes)
      expect((await other.get(HASH))?.stdout).toBe('built\n')
      cache.close()
      other.close()
    })
  }

  it('an entry with no outputs ingests and restores its stdout', async () => {
    const cache = new Cache(
      path.join(root, 'n'),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      store,
    )
    const proj = path.join(root, 'p-n')
    await mkdir(proj, { recursive: true })
    await cache.save({
      hash: HASH,
      entry: { taskId: 'p#check', command: 'check', durationMs: 1, stdout: 'ok\n' },
      projectDir: proj,
      outputFiles: [],
    })
    const pinned = await cache.pinArtifact(HASH)
    const other = new Cache(
      path.join(root, 'o'),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      store,
    )
    await other.ingest(HASH, pinned.body, { taskId: 'p#check', command: 'check', durationMs: 1 })
    await pinned.release()
    await other.restoreOutputs(HASH, path.join(root, 'into'))
    expect((await other.get(HASH))?.stdout).toBe('ok\n')
    cache.close()
    other.close()
  })

  it('prune takes the entry in every form', async () => {
    const { cache } = await saved(store, LARGE)
    await cache.prune({ olderThanMs: Date.now() + 2 * 60 * 60 * 1000 })
    expect(await cache.get(HASH)).toBeNull()
    const left = readdirSync(path.join(root, 'c'), { recursive: true }).map(String)
    expect(left.filter((n) => n.includes(HASH))).toEqual([])
    cache.close()
  })
})

describe('cache.store.embeddings', () => {
  it('is the bound: an entry past it is files, and false keeps none inline', async () => {
    // SMALL's tar is past 1 KiB, under 32 KiB.
    for (const [embeddings, want] of [
      [parseSettingValue({ type: 'size', off: true }, '1KB') as number, 'tree'],
      [parseSettingValue({ type: 'size', off: true }, '32KiB') as number, 'inline'],
      [parseSettingValue({ type: 'size', off: true }, false) as number, 'tree'],
    ] as const) {
      const { cache } = await saved({ embeddings, compress: false, verify: 'stat' }, SMALL)
      expect(form(path.join(root, 'c'))).toBe(want)
      cache.close()
      await rm(path.join(root, 'c'), { recursive: true, force: true })
    }
  })
})

describe('verify on a tree whose stored file changed', () => {
  const tree: StoreOptions = { embeddings: 0, compress: false, verify: 'stat' }

  it('stat catches a size change: the entry is dropped, nothing lands', async () => {
    const { cache, proj } = await saved(tree, LARGE)
    const file = treeFile(path.join(root, 'c'))
    const st = statSync(file)
    await writeFile(file, 'short')
    await utimes(file, st.atime, st.mtime)
    await expect(cache.restoreOutputs(HASH, proj)).rejects.toBeInstanceOf(ArtifactVanishedError)
    expect(existsSync(path.join(proj, 'out/a.bin'))).toBe(false)
    expect(await cache.get(HASH)).toBeNull()
    cache.close()
  })

  it('stat misses a same-size, same-mtime edit; hash catches it; none restores it', async () => {
    const edit = async (verify: StoreOptions['verify'], name: string) => {
      const { cache, proj } = await saved({ ...tree, verify }, LARGE, name)
      const file = treeFile(path.join(root, name))
      const st = statSync(file)
      const flipped = LARGE.slice()
      flipped[0] = flipped[0]! ^ 0xff
      await writeFile(file, flipped)
      await utimes(file, st.atime, st.mtime)
      return { cache, proj, flipped }
    }
    for (const verify of ['stat', 'none'] as const) {
      const { cache, proj, flipped } = await edit(verify, verify)
      await cache.restoreOutputs(HASH, proj)
      expect(new Uint8Array(await readFile(path.join(proj, 'out/a.bin')))).toEqual(flipped)
      cache.close()
    }
    const { cache, proj } = await edit('hash', 'hash')
    await expect(cache.restoreOutputs(HASH, proj)).rejects.toBeInstanceOf(ArtifactVanishedError)
    expect(existsSync(path.join(proj, 'out/a.bin'))).toBe(false)
    cache.close()
  })
})

describe('a tree no row names', () => {
  it('is an orphan the sweep sizes and reaps; an indexed tree stays', async () => {
    const { cache, proj } = await saved({ embeddings: 0, compress: false, verify: 'stat' }, LARGE)
    const indexed = path.dirname(path.dirname(path.dirname(treeFile(path.join(root, 'c')))))
    const orphan = path.join(path.dirname(indexed), 'fedcba9876543210.tree')
    await mkdir(path.join(orphan, 'outputs'), { recursive: true })
    await writeFile(path.join(orphan, 'outputs/x'), 'x'.repeat(11))
    const old = (Date.now() - 2 * 60 * 60 * 1000) / 1000
    await utimes(orphan, old, old)
    await utimes(indexed, old, old)
    expect(await cache.orphanStats()).toEqual({ orphans: 1, orphanBytes: 11 })
    await cache.prune({ olderThanMs: Date.now() - 30 * 60 * 1000 })
    expect(existsSync(orphan)).toBe(false)
    await cache.restoreOutputs(HASH, proj)
    expect(new Uint8Array(await readFile(path.join(proj, 'out/a.bin')))).toEqual(LARGE)
    cache.close()
  })
})
