// Small artifacts live inline in the store's index (v33,
// docs/design/cache-save-cpu-2026-10.md): an artifact of at most INLINE_MAX
// compressed bytes is a row of `artifacts`, written in the transaction that
// writes its entry rows, with no temp and no rename. Each row here is one of
// the design's tests; the numbers are its own.

import { Database } from 'bun:sqlite'
import { existsSync, readdirSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { Cache, CorruptArtifactError } from '../src/cache/cache.js'
import { isInline, storedArtifact } from './helpers/stored-artifact.js'

let root: string
let cacheDir: string
let proj: string

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-inline-'))
  cacheDir = path.join(root, 'cache')
  proj = path.join(root, 'p')
  await mkdir(path.join(proj, 'dist'), { recursive: true })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const HOUR = 60 * 60 * 1000
const ctx = { taskId: 'p#build', command: 'build' }

/** Incompressible bytes past INLINE_MAX: an artifact holding them is a file. */
const big = (): Uint8Array => crypto.getRandomValues(new Uint8Array(48 * 1024))

/** Save `dist/<name>` holding `body` alone under `hash`. */
async function save(cache: Cache, hash: string, body: string | Uint8Array, name = 'out.txt') {
  await rm(path.join(proj, 'dist'), { recursive: true, force: true })
  await mkdir(path.join(proj, 'dist'), { recursive: true })
  const out = path.join(proj, 'dist', name)
  await writeFile(out, body)
  await cache.save({
    hash,
    projectDir: proj,
    outputFiles: [out],
    entry: { ...ctx, durationMs: 1, stdout: '' },
  })
}

/** Restore `hash` into a fresh directory; its `dist/` file names and bytes. */
async function restored(cache: Cache, hash: string): Promise<Record<string, string>> {
  const into = await mkdtemp(path.join(root, 'r-'))
  await cache.restoreOutputs(hash, into)
  const dist = path.join(into, 'dist')
  const out: Record<string, string> = {}
  for (const n of readdirSync(dist)) out[n] = (await readFile(path.join(dist, n))).toString('hex')
  return out
}

const hex = (b: string | Uint8Array): string => Buffer.from(b).toString('hex')
const files = (): string[] => readdirSync(cacheDir).filter((n) => n.includes('.tar.zst'))

describe('2: two writers re-saving one key while a third process restores', () => {
  // Each writer saves the key with its own file name, so rows of one and
  // bytes of the other fail the restore as "missing a recorded output". The
  // restore reads the rows and the inline bytes in one read transaction.
  it('every restore gets one writer whole: its file, its bytes', async () => {
    const script = path.join(root, 'writer.ts')
    const stop = path.join(root, 'stop')
    const CACHE = path.resolve(import.meta.dir, '..', 'src', 'cache', 'index.ts')
    await writeFile(
      script,
      `import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { Cache } from ${JSON.stringify(CACHE)}
const [name, dir] = process.argv.slice(2)
const proj = ${JSON.stringify(root)} + '/w-' + name
mkdirSync(proj + '/dist', { recursive: true })
writeFileSync(proj + '/dist/' + name, name.repeat(64))
const cache = new Cache(dir)
let n = 0
while (!existsSync(${JSON.stringify(stop)})) {
  await cache.save({ hash: 'h1', projectDir: proj, outputFiles: [proj + '/dist/' + name],
    entry: { taskId: 'p#build', command: 'build', durationMs: n++, stdout: '' } })
}
cache.close()
console.log(n)
`,
    )
    const reader = new Cache(cacheDir)
    await save(reader, 'h1', 'a.js'.repeat(64), 'a.js')
    const writers = ['a.js', 'b.js'].map((n) =>
      Bun.spawn([process.execPath, script, n, cacheDir], { stdout: 'pipe', stderr: 'inherit' }),
    )
    const seen = new Set<string>()
    const failures: string[] = []
    try {
      const until = Date.now() + 3000
      while (Date.now() < until) {
        try {
          const got = await restored(reader, 'h1')
          const [name, ...rest] = Object.keys(got)
          if (rest.length > 0 || got[name!] !== hex(name!.repeat(64))) {
            failures.push(JSON.stringify(got))
          }
          seen.add(name!)
        } catch (err) {
          failures.push(String(err))
        }
      }
    } finally {
      await writeFile(stop, '')
      const saves = await Promise.all(
        writers.map(async (w) => Number(await new Response(w.stdout).text())),
      )
      reader.close()
      // CONTROL: both writers saved throughout, and the restores saw both.
      expect(saves.every((n) => n > 10)).toBe(true)
    }
    expect([failures.slice(0, 3), [...seen].sort()]).toEqual([[], ['a.js', 'b.js']])
  }, 30_000)
})

describe('3: one key moving file → inline → file', () => {
  it('reads the latest bytes each time and leaves one copy', async () => {
    const cache = new Cache(cacheDir)
    try {
      const first = big()
      await save(cache, 'h1', first)
      expect([isInline(cache, 'h1'), files()]).toEqual([false, ['h1.tar.zst']])
      expect(await restored(cache, 'h1')).toEqual({ 'out.txt': hex(first) })

      await save(cache, 'h1', 'small')
      // The file the previous row named was moved aside and unlinked.
      expect([isInline(cache, 'h1'), files()]).toEqual([true, []])
      expect(await restored(cache, 'h1')).toEqual({ 'out.txt': hex('small') })

      const last = big()
      await save(cache, 'h1', last)
      expect([isInline(cache, 'h1'), files()]).toEqual([false, ['h1.tar.zst']])
      expect(await restored(cache, 'h1')).toEqual({ 'out.txt': hex(last) })
      expect(cache.artifactSize('h1')).toBe(storedArtifact(cache, 'h1')!.byteLength)
    } finally {
      cache.close()
    }
  })

  it('a file no row names, shadowed by an inline save, is never read and the sweep takes it', async () => {
    const cache = new Cache(cacheDir)
    try {
      const old = big()
      await save(cache, 'aaaaaaaaaaaaaaaa', old)
      const file = path.join(cacheDir, 'aaaaaaaaaaaaaaaa.tar.zst')
      const oldBytes = await readFile(file)
      // Another version's open dropped the row: the file is row-less, and
      // the inline save moves it aside as it would a row's.
      cache.dbHandle().query('DELETE FROM entries').run()
      await save(cache, 'aaaaaaaaaaaaaaaa', 'small')
      expect([isInline(cache, 'aaaaaaaaaaaaaaaa'), files()]).toEqual([true, []])
      // An older vx, which knows no inline table, writes the key's file again.
      await writeFile(file, oldBytes)
      expect(await restored(cache, 'aaaaaaaaaaaaaaaa')).toEqual({ 'out.txt': hex('small') })
      const aged = (Date.now() - 2 * HOUR) / 1000
      await utimes(path.join(cacheDir, 'aaaaaaaaaaaaaaaa.tar.zst'), aged, aged)
      // Taken whatever the policy, as a temp is; the inline entry is not
      // a phantom, so it is neither dropped nor uncounted.
      const size = storedArtifact(cache, 'aaaaaaaaaaaaaaaa')!.byteLength
      const fileSize = old.byteLength
      expect(await cache.orphanStats()).toEqual({ orphans: 1, orphanBytes: expect.any(Number) })
      const r = await cache.prune({ maxBytes: Number.MAX_SAFE_INTEGER })
      expect([r.evicted, r.orphans, files()]).toEqual([0, 1, []])
      expect(r.orphanBytes).toBeGreaterThan(fileSize)
      expect(await restored(cache, 'aaaaaaaaaaaaaaaa')).toEqual({ 'out.txt': hex('small') })
      // `--max-size 1B` counts and evicts it: a row whose artifact is inline is present.
      expect(await cache.prune({ maxBytes: 1, dryRun: true })).toEqual({
        evicted: 1,
        bytesFreed: size,
        orphans: 0,
        orphanBytes: 0,
      })
    } finally {
      cache.close()
    }
  })
})

describe('4: a reset keeps the inline artifacts', () => {
  it('a SCHEMA_VERSION reset drops the rows; the bytes stay and a lookup with a task adopts them', async () => {
    const writer = new Cache(cacheDir)
    await save(writer, 'h1', 'kept')
    writer.close()
    const raw = new Database(path.join(cacheDir, 'cache.db'))
    raw.query("UPDATE schema_meta SET value = 'v0' WHERE key = 'version'").run()
    raw.close()
    const cache = new Cache(cacheDir)
    try {
      expect(cache.schemaReset?.from).toBe('v0')
      expect([await cache.get('h1'), storedArtifact(cache, 'h1') !== null]).toEqual([null, true])
      expect((await cache.get('h1', ctx))?.hash).toBe('h1')
      expect(await restored(cache, 'h1')).toEqual({ 'out.txt': hex('kept') })
    } finally {
      cache.close()
    }
  })

  it("an older vx's reset of the store drops what it knows and leaves `artifacts` alone", async () => {
    const store = path.join(root, 'store')
    const open = (): Cache => new Cache(cacheDir, undefined, undefined, undefined, 'open', store)
    const writer = open()
    await save(writer, 'h1', 'kept')
    writer.close()
    // What a v32 open does to a store of another schema: drops its tables
    // but store_meta, makes its own, and stamps its version.
    const raw = new Database(path.join(store, 'store.db'))
    for (const t of ['entry_inputs', 'output_files', 'entry_stdout', 'entries']) {
      raw.exec(`DROP TABLE ${t}; CREATE TABLE ${t} (old_shape TEXT)`)
    }
    raw.query("UPDATE store_meta SET value = 'v32' WHERE key = 'schema'").run()
    raw.close()
    const cache = open()
    try {
      expect(cache.storeReset).toEqual({ from: 'v32', to: expect.stringMatching(/^v\d+$/) })
      expect((await cache.get('h1', ctx))?.hash).toBe('h1')
      expect(isInline(cache, 'h1')).toBe(true)
    } finally {
      cache.close()
    }
  })
})

describe('6: a small remote body is ingested inline', () => {
  /** A good artifact for `hash`, as a producer saved it. */
  async function produced(hash: string, body: string | Uint8Array): Promise<Uint8Array> {
    const producer = new Cache(path.join(root, `producer-${hash}`))
    try {
      await save(producer, hash, body)
      return storedArtifact(producer, hash)!
    } finally {
      producer.close()
    }
  }

  const chunked = (bytes: Uint8Array, headers?: Record<string, string>): Response =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(c) {
          const half = bytes.byteLength >> 1
          c.enqueue(bytes.slice(0, half))
          c.enqueue(bytes.slice(half))
          c.close()
        },
      }),
      headers === undefined ? {} : { headers },
    )

  it('a good body lands inline and hits, as a Blob and as a stream with no length', async () => {
    const bytes = await produced('h1', 'remote')
    const cache = new Cache(cacheDir)
    try {
      await cache.ingest('h1', new Blob([bytes]), { ...ctx, durationMs: 1 })
      expect([isInline(cache, 'h1'), files()]).toEqual([true, []])
      await cache.ingest('h1', chunked(bytes), { ...ctx, durationMs: 1 })
      expect([isInline(cache, 'h1'), files()]).toEqual([true, []])
      expect(hex(storedArtifact(cache, 'h1')!)).toBe(hex(bytes))
      expect(await restored(cache, 'h1')).toEqual({ 'out.txt': hex('remote') })
    } finally {
      cache.close()
    }
  })

  it('a large body streamed with no length is counted past INLINE_MAX and lands as a file', async () => {
    const body = big()
    const bytes = await produced('h2', body)
    const cache = new Cache(cacheDir)
    try {
      await cache.ingest('h2', chunked(bytes), { ...ctx, durationMs: 1 })
      expect([isInline(cache, 'h2'), files()]).toEqual([false, ['h2.tar.zst']])
      expect(await restored(cache, 'h2')).toEqual({ 'out.txt': hex(body) })
    } finally {
      cache.close()
    }
  })

  it('a wrong key, a cut body, a bomb and a body past the cap leave no row and no blob', async () => {
    const bytes = await produced('h1', 'remote')
    const threeGiB = 3n * 1024n * 1024n * 1024n
    const fcs = new Uint8Array(8)
    for (let i = 0; i < 8; i++) fcs[i] = Number((threeGiB >> BigInt(8 * i)) & 0xffn)
    const bomb = new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 0xc0, 0x00, ...fcs, 0, 0, 0, 0])
    // A ceiling of 8 KiB puts the cap on the compressed bytes at 73,760.
    const cache = new Cache(cacheDir, undefined, undefined, 8192)
    try {
      const refused = async (hash: string, body: Blob | Response): Promise<unknown> =>
        cache.ingest(hash, body, { ...ctx, durationMs: 1 }).then(
          () => null,
          (e: unknown) => e,
        )
      const outcomes = [
        await refused('hother', new Blob([bytes])),
        await refused('h1', new Blob([bytes.subarray(0, bytes.byteLength - 8)])),
        await refused('h1', chunked(bytes.subarray(0, bytes.byteLength - 8))),
        await refused('h1', new Blob([bomb])),
        await refused('h1', chunked(new Uint8Array(80_000))),
      ]
      expect(outcomes.map((e) => e instanceof CorruptArtifactError)).toEqual([
        true,
        true,
        true,
        true,
        true,
      ])
      expect((outcomes[4] as Error).message).toContain('runs past 73760 bytes')
      expect([
        await cache.get('h1'),
        await cache.get('hother'),
        storedArtifact(cache, 'h1'),
        storedArtifact(cache, 'hother'),
        readdirSync(cacheDir).filter((n) => n.includes('.tar.zst')),
      ]).toEqual([null, null, null, null, []])
      // CONTROL: the good body, through the same handle, lands.
      await cache.ingest('h1', new Blob([bytes]), { ...ctx, durationMs: 1 })
      expect(isInline(cache, 'h1')).toBe(true)
    } finally {
      cache.close()
    }
  })
})

describe('8: prune over inline artifacts', () => {
  it('counts inline sizes toward maxBytes and takes a victim’s bytes with its rows', async () => {
    const cache = new Cache(cacheDir)
    try {
      await save(cache, 'h1', 'one')
      await save(cache, 'h2', 'two')
      const db = cache.dbHandle()
      db.query("UPDATE entries SET accessed_at = 1 WHERE hash = 'h1'").run()
      const two = storedArtifact(cache, 'h2')!.byteLength
      const one = storedArtifact(cache, 'h1')!.byteLength
      // A dry run counts and deletes nothing.
      expect(await cache.prune({ maxBytes: two, dryRun: true })).toEqual({
        evicted: 1,
        bytesFreed: one,
        orphans: 0,
        orphanBytes: 0,
      })
      expect([isInline(cache, 'h1'), isInline(cache, 'h2')]).toEqual([true, true])
      // The rows' delete fails: the bytes stay with them, one transaction.
      db.exec(
        "CREATE TRIGGER refuse BEFORE DELETE ON entries BEGIN SELECT RAISE(ABORT, 'refused'); END",
      )
      await expect(cache.prune({ maxBytes: two })).rejects.toThrow('refused')
      expect(isInline(cache, 'h1')).toBe(true)
      db.exec('DROP TRIGGER refuse')
      expect((await cache.evictIfDue({ maxBytes: two }))?.evicted).toBe(1)
      expect([storedArtifact(cache, 'h1'), await cache.get('h1'), isInline(cache, 'h2')]).toEqual([
        null,
        null,
        true,
      ])
    } finally {
      cache.close()
    }
  })

  it('reaps a row-less inline artifact by its `at`, counts it for `vx info`, and nothing younger', async () => {
    const cache = new Cache(cacheDir)
    try {
      for (const h of ['00000000000000a1', '00000000000000a2', '00000000000000a3']) {
        await save(cache, h, h)
      }
      const db = cache.dbHandle()
      db.query('DELETE FROM entries').run()
      const at = db.query('UPDATE artifacts SET at = ? WHERE hash = ?')
      at.run(Date.now() - 3 * 24 * HOUR, '00000000000000a1') // past the age limit
      at.run(Date.now() - 2 * HOUR, '00000000000000a2') // past the grace, within the limit
      // a3: just written, inside the in-flight grace.
      const size = storedArtifact(cache, '00000000000000a1')!.byteLength
      const sizes = ['00000000000000a1', '00000000000000a2'].map(
        (h) => storedArtifact(cache, h)!.byteLength,
      )
      expect(await cache.orphanStats()).toEqual({ orphans: 2, orphanBytes: sizes[0]! + sizes[1]! })
      const dry = await cache.prune({ olderThanMs: Date.now() - 24 * HOUR, dryRun: true })
      expect({ orphans: dry.orphans, orphanBytes: dry.orphanBytes }).toEqual({
        orphans: 1,
        orphanBytes: size,
      })
      expect(storedArtifact(cache, '00000000000000a1')).not.toBeNull()
      const r = await cache.prune({ olderThanMs: Date.now() - 24 * HOUR })
      expect({ orphans: r.orphans, orphanBytes: r.orphanBytes }).toEqual({
        orphans: 1,
        orphanBytes: size,
      })
      expect(
        ['00000000000000a1', '00000000000000a2', '00000000000000a3'].map(
          (h) => storedArtifact(cache, h) !== null,
        ),
      ).toEqual([false, true, true])
    } finally {
      cache.close()
    }
  })

  it('an adopt between the scan and the reap keeps the artifact', async () => {
    const cache = new Cache(cacheDir)
    try {
      await save(cache, '00000000000000a1', 'adopted')
      const db = cache.dbHandle()
      db.query('DELETE FROM entries').run()
      db.query('UPDATE artifacts SET at = ?').run(Date.now() - 3 * 24 * HOUR)
      const target = cache as unknown as { reapOrphans: (...a: unknown[]) => Promise<unknown> }
      const reap = target.reapOrphans.bind(cache)
      spyOn(target, 'reapOrphans').mockImplementation(async (...args: unknown[]) => {
        expect((await cache.get('00000000000000a1', ctx))?.hash).toBe('00000000000000a1')
        return reap(...args)
      })
      const r = await cache.prune({ olderThanMs: Date.now() - 24 * HOUR })
      expect([r.orphans, isInline(cache, '00000000000000a1')]).toEqual([0, true])
    } finally {
      cache.close()
    }
  })
})

describe('a workspace index that held its entries itself, moved to a store', () => {
  // Its own `artifacts` would shadow the store's: an unqualified name is
  // found in `main` first, and the save's bytes would land beside the
  // workspace's index while its rows went to the store.
  it("saves its inline bytes into the store, where another workspace's lookup finds them", async () => {
    const store = path.join(root, 'store')
    const own = new Cache(cacheDir, undefined, undefined, undefined, 'open', null)
    await save(own, 'h0', 'before')
    own.close()
    const moved = new Cache(cacheDir, undefined, undefined, undefined, 'open', store)
    await save(moved, 'h1', 'shared')
    moved.close()
    const other = new Cache(
      path.join(root, 'other'),
      undefined,
      undefined,
      undefined,
      'open',
      store,
    )
    try {
      expect((await other.get('h1'))?.hash).toBe('h1')
      expect(await restored(other, 'h1')).toEqual({ 'out.txt': hex('shared') })
    } finally {
      other.close()
    }
  })
})

describe('12: the inline table’s own layout sentinel', () => {
  it('a foreign layout drops the inline artifacts, silently', async () => {
    const writer = new Cache(cacheDir)
    await save(writer, 'h1', 'kept')
    writer.close()
    // Another vx's: a layout change comes with a schema of its own.
    const raw = new Database(path.join(cacheDir, 'cache.db'))
    raw.query("UPDATE artifacts_meta SET value = 'zz' WHERE key = 'layout'").run()
    raw.query("UPDATE schema_meta SET value = 'v999' WHERE key = 'version'").run()
    raw.close()
    const err = spyOn(process.stderr, 'write')
    const out = spyOn(process.stdout, 'write')
    const cache = new Cache(cacheDir)
    try {
      expect([err.mock.calls.length, out.mock.calls.length]).toEqual([0, 0])
      const db = cache.dbHandle()
      expect([
        db.query('SELECT count(*) AS n FROM artifacts').get(),
        db.query("SELECT value FROM artifacts_meta WHERE key = 'layout'").get(),
        await cache.get('h1'),
      ]).toEqual([{ n: 0 }, { value: 'a1' }, null])
    } finally {
      err.mockRestore()
      out.mockRestore()
      cache.close()
    }
    // CONTROL: the layout this vx writes keeps them.
    const writer2 = new Cache(cacheDir)
    await save(writer2, 'h2', 'kept')
    writer2.close()
    const again = new Cache(cacheDir)
    try {
      expect(isInline(again, 'h2')).toBe(true)
    } finally {
      again.close()
    }
    expect(existsSync(path.join(cacheDir, 'h2.tar.zst'))).toBe(false)
  })

  it("a store at another vx's schema and layout drops the store's inline artifacts", async () => {
    const store = path.join(root, 'store')
    const open = (): Cache => new Cache(cacheDir, undefined, undefined, undefined, 'open', store)
    const writer = open()
    await save(writer, 'h1', 'kept')
    writer.close()
    const raw = new Database(path.join(store, 'store.db'))
    raw.query("UPDATE artifacts_meta SET value = 'zz' WHERE key = 'layout'").run()
    raw.query("UPDATE store_meta SET value = 'v999' WHERE key = 'schema'").run()
    raw.close()
    const cache = open()
    try {
      expect([
        cache.dbHandle().query('SELECT count(*) AS n FROM store.artifacts').get(),
        cache.dbHandle().query("SELECT value FROM store.artifacts_meta WHERE key = 'layout'").get(),
      ]).toEqual([{ n: 0 }, { value: 'a1' }])
    } finally {
      cache.close()
    }
  })

  it('an index whose entries come back from a store stamps the table it makes', async () => {
    const store = path.join(root, 'store')
    new Cache(cacheDir, undefined, undefined, undefined, 'open', store).close()
    const own = new Cache(cacheDir, undefined, undefined, undefined, 'open', null)
    try {
      expect(
        own.dbHandle().query("SELECT value FROM main.artifacts_meta WHERE key = 'layout'").get(),
      ).toEqual({ value: 'a1' })
    } finally {
      own.close()
    }
  })

  it('a warm open at this schema reads no layout: the open costs no statement for it', async () => {
    const writer = new Cache(cacheDir)
    await save(writer, 'h1', 'kept')
    writer.close()
    const raw = new Database(path.join(cacheDir, 'cache.db'))
    raw.query("UPDATE artifacts_meta SET value = 'zz' WHERE key = 'layout'").run()
    raw.close()
    const cache = new Cache(cacheDir)
    try {
      expect(isInline(cache, 'h1')).toBe(true)
    } finally {
      cache.close()
    }
  })
})
