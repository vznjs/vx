// `cache.store`: every combination of embeddings × decompress saves,
// restores and uploads the same bytes; only where they live differs.
import { existsSync, readdirSync, readlinkSync, statSync } from 'node:fs'
import { link, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { indexDb, Cache, type StoreOptions } from '../src/cache/index.js'
import { parseSettingValue } from '../src/settings.js'
import { treeBytes } from '../src/util/index.js'

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
  return path.join(cacheDir, rel, 'out/a.bin')
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

  // `size_bytes` is what `--max-size` and `vx info` count: the bytes the
  // entry's form holds on disk. An ingested tree recorded the compressed
  // body's size, so a remote hit of 1 MiB counted as its ~48 KiB download.
  it('an ingested entry records the size a saved one of the same form does', async () => {
    const bytes = new Uint8Array(LARGE.byteLength + 1024 * 1024)
    bytes.set(LARGE)
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
    expect(form(path.join(root, 'o'))).toBe(form(path.join(root, 'c')))
    const size = (c: Cache): number =>
      (indexDb(c).query('SELECT size_bytes AS s FROM entries').get() as { s: number }).s
    expect(size(other)).toBe(size(cache))
    if (store.decompress) expect(size(other)).toBeGreaterThan(bytes.byteLength)
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

// An evicted file entry's rows (one a file it holds) went to SQLite's free
// list and stayed: a `--max-size` clean left the index 90% free pages.
it.each([
  ['an index', false],
  ['a store', true],
])('a prune that evicts a file entry gives its rows’ pages back (%s)', async (_, shared) => {
  const proj = path.join(root, 'p')
  await mkdir(path.join(proj, 'out'), { recursive: true })
  const outs: string[] = []
  for (let i = 0; i < 3000; i++) {
    const f = path.join(proj, 'out', `file-with-a-long-name-${i}.js`)
    await writeFile(f, `${i}`)
    outs.push(f)
  }
  const store = shared ? path.join(root, 'home', '.vx', 'id', 'cache') : null
  if (shared) await mkdir(path.join(root, 'home'), { mode: 0o700 })
  const cache = new Cache(path.join(root, 'c'), undefined, undefined, undefined, 'open', store)
  try {
    await cache.save({
      hash: HASH,
      entry: { taskId: 'p#build', command: 'build', durationMs: 1, stdout: '' },
      projectDir: proj,
      outputFiles: outs,
    })
    expect((await cache.prune({ maxBytes: 0 })).evicted).toBe(1)
    const free = (schema: string) =>
      Object.values(indexDb(cache).query(`PRAGMA ${schema}.freelist_count`).get() as object)[0]
    expect(shared ? [free('main'), free('store')] : [free('main')]).toEqual(shared ? [0, 0] : [0])
  } finally {
    cache.close()
  }
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
  // Its size is held to its row's (tree-store-torn.test.ts): that check
  // is free, the read a checksum takes is not.
  it('trusts the stored files: an edited one restores as edited, unchecked', async () => {
    const { cache, proj } = await saved({ embeddings: 0, decompress: true }, LARGE)
    const file = treeFile(path.join(root, 'c'))
    const st = statSync(file)
    const edited = 'e'.repeat(st.size)
    await writeFile(file, edited)
    await utimes(file, st.atime, st.mtime)
    await cache.restoreOutputs(HASH, proj)
    expect(await readFile(path.join(proj, 'out/a.bin'), 'utf8')).toBe(edited)
    expect(readdirSync(path.dirname(path.dirname(file)))).not.toContain('.vx-sum')
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

describe("a tree hit over the last build's files", () => {
  // A hit after a branch switch finds the other build's files in place:
  // the copy-out asked each file's place be absent, so 20,000 files were
  // packed into a tar and unpacked, 6.5 s against 1.6 s into an empty tree.
  it('copies each file beside the one it replaces and renames it over', async () => {
    const { cache, proj } = await saved({ embeddings: 0, decompress: true }, LARGE)
    const out = path.join(proj, 'out/a.bin')
    await mkdir(path.dirname(out), { recursive: true })
    await writeFile(out, 'the other build')
    // A hard link elsewhere to the file replaced keeps its bytes: a rename
    // over the name, never a write through it.
    const other = path.join(root, 'linked.bin')
    await link(out, other)
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
    expect(new Uint8Array(await readFile(out))).toEqual(LARGE)
    expect(await readFile(other, 'utf8')).toBe('the other build')
    expect(readdirSync(path.dirname(out))).toEqual(['a.bin'])
    cache.close()
  })

  // Rewritten, a hit over an unchanged tree dated every output now: a
  // noop whose stamps a restore must re-prove rewrote dist/ (pr-bench).
  it('leaves a file that already holds the bytes, and its mtime', async () => {
    const { cache, proj } = await saved({ embeddings: 0, decompress: true }, LARGE)
    const out = path.join(proj, 'out/a.bin')
    await mkdir(path.dirname(out), { recursive: true })
    await writeFile(out, LARGE)
    const then = new Date(1_000_000_000_000)
    await utimes(out, then, then)
    const ino = statSync(out).ino
    await cache.restoreOutputs(HASH, proj)
    expect(statSync(out).mtimeMs).toBe(then.getTime())
    expect(statSync(out).ino).toBe(ino)
    cache.close()
  })
})

describe('a tree hit into absent outputs', () => {
  // The copy-out wrote each file at its final path, so a reader met it
  // empty or short until the copy finished; the tar form stages and renames.
  // A file into a folder that stands is still copied in place (cheaper).
  it.each([
    ['staged in the workspace', true],
    ['with no workspace root', false],
  ])('a reader never finds an output short in a missing folder (%s)', async (_, withRoot) => {
    const { cache, proj } = await saved({ embeddings: 0, decompress: true }, LARGE)
    const out = path.join(proj, 'out/a.bin')
    const real = Bun.write
    const write = spyOn(Bun, 'write').mockImplementation((async (
      ...args: Parameters<typeof real>
    ) => {
      // A copy's open makes its target empty first; the copy lands later.
      await writeFile(args[0] as string, '')
      await Bun.sleep(40)
      return real(...args)
    }) as typeof Bun.write)
    const seen = new Set<number>()
    let done = false
    const poll = (async () => {
      while (!done) {
        const st = statSync(out, { throwIfNoEntry: false })
        if (st !== undefined) seen.add(st.size)
        await Bun.sleep(1)
      }
    })()
    try {
      await cache.restoreOutputs(HASH, proj, withRoot ? root : undefined)
    } finally {
      done = true
      await poll
      write.mockRestore()
    }
    expect([...seen].filter((n) => n !== LARGE.byteLength)).toEqual([])
    expect(new Uint8Array(await readFile(out))).toEqual(LARGE)
    expect(readdirSync(proj).sort()).toEqual(['out'])
    expect(readdirSync(path.join(proj, 'out'))).toEqual(['a.bin'])
    cache.close()
  })
})

describe('a tree hit holding a link', () => {
  // A link sent the whole restore through a tar packed back from the tree,
  // and the extractor's check of each link against every entry was
  // links × files: 700 links in a 32k-entry tree restored in 3.5 s, not 0.2.
  const savedWithLink = async (): Promise<{ cache: Cache; proj: string }> => {
    const proj = path.join(root, 'p')
    await mkdir(path.join(proj, 'out'), { recursive: true })
    await writeFile(path.join(proj, 'out/a.bin'), LARGE)
    await symlink('a.bin', path.join(proj, 'out/l'))
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
      outputFiles: [path.join(proj, 'out/a.bin'), path.join(proj, 'out/l')],
    })
    await rm(path.join(proj, 'out'), { recursive: true })
    return { cache, proj }
  }

  it.skipIf(process.platform === 'win32')(
    'copies its files out and lays the link as written',
    async () => {
      const { cache, proj } = await savedWithLink()
      const write = spyOn(Bun, 'write')
      try {
        await cache.restoreOutputs(HASH, proj, root)
        const fromTree = write.mock.calls.filter(
          ([, from]) =>
            from instanceof Blob && String((from as { name?: string }).name).includes('.tree'),
        )
        expect(fromTree).toHaveLength(1)
      } finally {
        write.mockRestore()
      }
      expect(readlinkSync(path.join(proj, 'out/l'))).toBe('a.bin')
      expect(new Uint8Array(await readFile(path.join(proj, 'out/l')))).toEqual(LARGE)
      cache.close()
    },
  )

  // The copy-out lays a link only where the extractor would: one its row
  // records that points out of the workspace is still refused, and nothing lands.
  it.skipIf(process.platform === 'win32')(
    'a stored link pointing out of the workspace restores nothing',
    async () => {
      const { cache, proj } = await savedWithLink()
      const rel = readdirSync(path.join(root, 'c'), { recursive: true })
        .map(String)
        .find((n) => n.endsWith(`${HASH}.tree`))!
      const kept = path.join(root, 'c', rel, 'out/l')
      const to = '../../../outside'
      await rm(kept)
      await symlink(to, kept)
      const bytes = Buffer.from(to)
      indexDb(cache)
        .query(
          "UPDATE output_files SET size_bytes = ?, mtime_ms = ? WHERE entry_hash = ? AND path = 'out/l'",
        )
        .run(bytes.byteLength, Bun.hash.crc32(bytes), HASH)
      const err = await cache.restoreOutputs(HASH, proj, root).then(
        () => null,
        (e: unknown) => e,
      )
      expect(String(err)).toContain('archive link outputs/out/l points out of the workspace')
      expect(existsSync(path.join(proj, 'out'))).toBe(false)
      cache.close()
    },
  )
})

describe('a tree no row names', () => {
  it('is an orphan the sweep sizes and reaps; an indexed tree stays', async () => {
    const { cache, proj } = await saved({ embeddings: 0, decompress: true }, LARGE)
    const indexed = path.dirname(path.dirname(treeFile(path.join(root, 'c'))))
    const orphan = path.join(path.dirname(indexed), 'fedcba9876543210.tree')
    await mkdir(orphan, { recursive: true })
    await writeFile(path.join(orphan, 'x'), 'x'.repeat(11))
    const old = (Date.now() - 2 * 60 * 60 * 1000) / 1000
    await utimes(orphan, old, old)
    await utimes(indexed, old, old)
    expect(await cache.orphanStats()).toEqual({ orphans: 1, orphanBytes: treeBytes(orphan) })
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
    (indexDb(c).query('SELECT size_bytes FROM entries').get() as { size_bytes: number }).size_bytes
  expect(size(b)).toBe(size(a))
  expect(size(b)).toBeGreaterThanOrEqual(hex.length)
  a.close()
  b.close()
})
