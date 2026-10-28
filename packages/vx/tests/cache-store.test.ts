// `cache.store`: every combination of embeddings × decompress saves,
// restores and uploads the same bytes; only where they live differs.
import { existsSync, readdirSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { Cache, type StoreOptions } from '../src/cache/index.js'
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
  for (const decompress of [true, false]) combos.push({ embeddings, decompress })

describe.each(combos)('cache.store %o', (store) => {
  for (const [label, bytes] of [
    ['small', SMALL],
    ['large', LARGE],
  ] as const) {
    it(`a ${label} output restores byte-exact, in the form the store names`, async () => {
      const { cache, proj } = await saved(store, bytes)
      const expected = !store.decompress
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
      const { cache } = await saved({ embeddings, decompress: true }, SMALL)
      expect(form(path.join(root, 'c'))).toBe(want)
      cache.close()
      await rm(path.join(root, 'c'), { recursive: true, force: true })
    }
  })
})

describe('a tree hit', () => {
  it('trusts the stored files: an edited one restores as edited, unchecked', async () => {
    const { cache, proj } = await saved({ embeddings: 0, decompress: true }, LARGE)
    const file = treeFile(path.join(root, 'c'))
    const st = statSync(file)
    await writeFile(file, 'short')
    await utimes(file, st.atime, st.mtime)
    await cache.restoreOutputs(HASH, proj)
    expect(await readFile(path.join(proj, 'out/a.bin'), 'utf8')).toBe('short')
    expect(readdirSync(path.dirname(path.dirname(path.dirname(file))))).not.toContain('.vx-sum')
    cache.close()
  })
})

describe('a tree hit under a source directory', () => {
  // solid's build outputs `store/dist/**` beside the sources in `store/`:
  // the copy-out asked that each output's top be absent, so every such hit
  // went through the tar extractor (~25 ms a task).
  it('copies its files out where the directory around them stands, and keeps the sources', async () => {
    const proj = path.join(root, 'p')
    await mkdir(path.join(proj, 'store/out'), { recursive: true })
    await writeFile(path.join(proj, 'store/src.ts'), 'source')
    await writeFile(path.join(proj, 'store/out/a.bin'), LARGE)
    const cache = new Cache(
      path.join(root, 'c'),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { embeddings: 0, decompress: true },
    )
    await cache.save({
      hash: HASH,
      entry: { taskId: 'p#build', command: 'build', durationMs: 1, stdout: '' },
      projectDir: proj,
      outputFiles: [path.join(proj, 'store/out/a.bin')],
    })
    await rm(path.join(proj, 'store/out'), { recursive: true })
    // The copy-out writes each file from the stored tree; the extractor
    // streams a tar packed back from it and writes none that way.
    const write = spyOn(Bun, 'write')
    try {
      await cache.restoreOutputs(HASH, proj)
      const fromTree = write.mock.calls.filter(
        ([, from]) =>
          from instanceof Blob && String((from as { name?: string }).name).includes('.tree'),
      )
      expect(fromTree).toHaveLength(1)
    } finally {
      write.mockRestore()
    }
    expect(new Uint8Array(await readFile(path.join(proj, 'store/out/a.bin')))).toEqual(LARGE)
    expect(await readFile(path.join(proj, 'store/src.ts'), 'utf8')).toBe('source')
    cache.close()
  })
})

describe('a tree no row names', () => {
  it('is an orphan the sweep sizes and reaps; an indexed tree stays', async () => {
    const { cache, proj } = await saved({ embeddings: 0, decompress: true }, LARGE)
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

it("a pinned upload body survives another process's prune that keeps the entry", async () => {
  // The pin is a hard link, so it shares the artifact's mtime: an artifact
  // saved hours ago made it look like a crashed save's temp, and another
  // process's orphan sweep took it mid-upload (DTE share and resend).
  const { cache } = await saved({ embeddings: 0, decompress: false }, LARGE)
  const dir = path.join(root, 'c')
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000)
  await utimes(path.join(dir, `${HASH}.tar.zst`), old, old)
  const pinned = await cache.pinArtifact(HASH)
  const other = new Cache(dir, undefined, undefined, undefined, undefined, undefined, {
    embeddings: 0,
    decompress: false,
  })
  await other.prune({ maxBytes: 1024 ** 3 })
  other.close()
  expect((await pinned.body.bytes()).byteLength).toBeGreaterThan(0)
  await pinned.release()
  cache.close()
})

describe('a tree restore while another process re-saves the key', () => {
  // The tree form copies each file by path under `<hash>.tree`; a re-save
  // elsewhere renames the old tree aside and a new one in. Files copied
  // after that came from the new build, a mix of two under a green hit;
  // where the new build's names differ, the copy's ENOENT read as a
  // corrupt artifact and dropped the other process's fresh entry.
  const open = (dir: string): Cache =>
    new Cache(dir, undefined, undefined, undefined, undefined, undefined, {
      embeddings: 0,
      decompress: true,
    })
  async function build(cache: Cache, proj: string, id: string, names: string[]): Promise<void> {
    await mkdir(path.join(proj, 'out'), { recursive: true })
    for (const n of names) await writeFile(path.join(proj, 'out', n), `${n} ${id}`)
    await cache.save({
      hash: HASH,
      entry: { taskId: 'p#build', command: 'build', durationMs: 1, stdout: '' },
      projectDir: proj,
      outputFiles: names.map((n) => path.join(proj, 'out', n)),
    })
  }
  /** Restore with the re-save landing after the first file is copied. */
  async function racedRestore(
    second: string[],
  ): Promise<{ reader: Cache; writer: Cache; err: unknown }> {
    const dir = path.join(root, 'c')
    const reader = open(dir)
    const writer = open(dir)
    await build(writer, path.join(root, 'w1'), '1', ['a.js', 'b.js'])
    expect(await reader.get(HASH)).not.toBeNull()
    const real = Bun.write
    let first = true
    let done!: () => void
    const resaved = new Promise<void>((r) => (done = r))
    const write = spyOn(Bun, 'write').mockImplementation((async (
      to: never,
      from: never,
      o: never,
    ) => {
      if (!String((from as { name?: string }).name).includes('.tree')) return real(to, from, o)
      if (first) {
        first = false
        const n = await real(to, from, o)
        await build(writer, path.join(root, 'w2'), '2', second)
        done()
        return n
      }
      await resaved
      return real(to, from, o)
    }) as unknown as typeof Bun.write)
    let err: unknown
    try {
      await reader.restoreOutputs(HASH, path.join(root, 'r'))
    } catch (e) {
      err = e
    } finally {
      write.mockRestore()
    }
    return { reader, writer, err }
  }

  it('restores one build or none, never a mix', async () => {
    const { reader, writer, err } = await racedRestore(['a.js', 'b.js'])
    if (err === undefined) {
      const a = await readFile(path.join(root, 'r/out/a.js'), 'utf8')
      const b = await readFile(path.join(root, 'r/out/b.js'), 'utf8')
      expect([a, b]).toEqual(a === 'a.js 1' ? ['a.js 1', 'b.js 1'] : ['a.js 2', 'b.js 2'])
    } else {
      expect((err as Error).name).toBe('ArtifactVanishedError')
      expect(existsSync(path.join(root, 'r/out'))).toBe(false)
    }
    reader.close()
    writer.close()
  })

  it("a re-save with other names is a miss and keeps the other process's entry", async () => {
    const { reader, writer, err } = await racedRestore(['c.js'])
    expect((err as Error | undefined)?.name).toBe('ArtifactVanishedError')
    expect(existsSync(path.join(root, 'r/out'))).toBe(false)
    expect(await writer.get(HASH)).not.toBeNull()
    reader.close()
    writer.close()
  })
})

it('an ingested tree counts the bytes it holds, as a saved tree does', async () => {
  // A remote hit unpacked into a tree recorded the zstd archive's size, so
  // `--max-size` and stats undercounted it by the compression ratio.
  const proj = path.join(root, 'p')
  await mkdir(path.join(proj, 'out'), { recursive: true })
  const hex = Buffer.from(crypto.getRandomValues(new Uint8Array(512 * 1024))).toString('hex')
  await writeFile(path.join(proj, 'out/a.bin'), hex)
  const a = new Cache(path.join(root, 'a'))
  await a.save({
    hash: HASH,
    entry: { taskId: 'p#build', command: 'build', durationMs: 1, stdout: '' },
    projectDir: proj,
    outputFiles: [path.join(proj, 'out/a.bin')],
  })
  const pinned = await a.pinArtifact(HASH)
  const b = new Cache(path.join(root, 'b'))
  await b.ingest(HASH, pinned.body, { taskId: 'p#build', command: 'build', durationMs: 1 })
  await pinned.release()
  const size = (c: Cache): number =>
    (c.dbHandle().query('SELECT size_bytes FROM entries').get() as { size_bytes: number })
      .size_bytes
  expect(size(b)).toBe(size(a))
  expect(size(b)).toBeGreaterThanOrEqual(hex.length)
  a.close()
  b.close()
})
