// `Cache.hashFiles` is `hashFile` over a list with one memo query. It must
// agree with the per-file form byte for byte, reuse the memo the per-file
// form wrote (and vice versa), see through a rewrite, and leave a missing
// path out rather than throwing the batch.

import { chmod, mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { statSync } from 'node:fs'
import { Cache, FILE_HASH_RACY_MS } from '../src/cache/index.js'

let dir: string
let cache: Cache
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'vx-hash-files-'))
  cache = new Cache(path.join(dir, 'cache'), { read: true, write: true })
})
afterEach(async () => {
  cache.close()
  await rm(dir, { recursive: true, force: true })
})

/**
 * Write, then wait out the racy-clean window so the digest is memoised.
 * `utimes` cannot do this: it moves mtime but stamps ctime with now, and
 * ctime is the field the window reads.
 */
async function aged(file: string, content: string): Promise<void> {
  await writeFile(file, content)
  await Bun.sleep(FILE_HASH_RACY_MS + 10)
}

describe('Cache.hashFiles', () => {
  it('agrees with hashFile, memoises, and omits a path it cannot stat', async () => {
    const a = path.join(dir, 'a.txt')
    const b = path.join(dir, 'b.txt')
    await aged(a, 'alpha\n')
    await aged(b, 'beta\n')
    const single = await cache.hashFile(a)
    const batch = await cache.hashFiles([a, b, path.join(dir, 'missing.txt'), a])
    expect(batch.get(a)).toBe(single)
    expect(batch.get(b)).toBe(await cache.hashFile(b))
    expect(batch.has(path.join(dir, 'missing.txt'))).toBe(false)
    expect(batch.size).toBe(2)
    // Both paths are memoised now (b by the batch): a row each.
    const rows = cache
      .dbHandle()
      .query('SELECT path FROM file_hashes ORDER BY path')
      .all() as Array<{ path: string }>
    expect(rows.map((r) => r.path)).toEqual([a, b])
  })

  it('hashBytes is hashFile of a file holding the bytes, and writes no memo row', async () => {
    const a = path.join(dir, 'bytes.txt')
    await aged(a, 'from bytes\n')
    const fromBytes = cache.hashBytes(new TextEncoder().encode('from bytes\n'), a)
    const rowsBefore = cache.dbHandle().query('SELECT COUNT(*) AS n FROM file_hashes').get() as {
      n: number
    }
    expect(rowsBefore.n).toBe(0)
    expect(fromBytes).toBe(await cache.hashFile(a))
    // CONTROL: other bytes are another identity.
    expect(cache.hashBytes(new TextEncoder().encode('other\n'), a)).not.toBe(fromBytes)
  })

  it('agrees on a symlink too — the blob of the link text, not the target bytes', async () => {
    // The agreement above only ever used regular files. The batch form
    // stat'ed (following the link) while `hashFile` lstat'ed, so the same
    // path identified two different ways depending on the entry point —
    // and the batch folded the TARGET's bytes, which is what `hashFile`'s
    // rationale says must not happen: `git diff` and `--affected` cannot
    // see them. project-loader uses the batch for a config closure's fast
    // path and `hashFile` for its slow path, so the two keyed differently
    // for the same closure.
    const target = path.join(dir, 'target.txt')
    await aged(target, 'hello\n')
    const toFile = path.join(dir, 'to-file')
    await symlink('target.txt', toFile)
    await mkdir(path.join(dir, 'd'))
    const toDir = path.join(dir, 'to-dir')
    await symlink('d', toDir)
    const dangling = path.join(dir, 'dangling')
    await symlink('nowhere.txt', dangling)
    const batch = await cache.hashFiles([toFile, toDir, dangling, target])
    for (const link of [toFile, toDir, dangling]) {
      expect([link, batch.get(link)]).toEqual([link, await cache.hashFile(link)])
    }
    // CONTROL: a link is NOT its target — that is the whole point of
    // folding the link text, and it is what following the link lost.
    expect(batch.get(toFile)).not.toBe(batch.get(target))
    expect(batch.get(target)).toBe(await cache.hashFile(target))
    // A symlink is never memoised: the row would key on the link's own
    // stat, not its target's.
    const rows = cache
      .dbHandle()
      .query('SELECT path FROM file_hashes ORDER BY path')
      .all() as Array<{ path: string }>
    expect(rows.map((r) => r.path)).toEqual([target])
  })

  it('a rewrite is seen — the memo keys on the stat, never on the path alone', async () => {
    const a = path.join(dir, 'a.txt')
    await aged(a, 'one\n')
    const before = (await cache.hashFiles([a])).get(a)
    await aged(a, 'two — a different size\n')
    const after = (await cache.hashFiles([a])).get(a)
    expect(after).not.toBe(before)
    expect(after).toBe(await cache.hashFile(a))
  })

  it('sees a rewrite that preserves BOTH mtime and size — ctime is what makes the memo safe', async () => {
    // The memo's own comment: ctime and ino are what make it SAFE, not
    // merely fast. mtime is caller-settable, so (mtime, size) alone hands
    // back the previous run's digest for genuinely different bytes
    // whenever a producer preserves mtime — `tar -x`, `unzip`, `cp -p`,
    // `rsync --times`, any SOURCE_DATE_EPOCH generator. That is a stale
    // cache hit, the worst failure this repo has, and nothing asserted it.
    // Both forms key on the same four fields, in two separate copies of
    // the comparison, so both are exercised here.
    for (const viaBatch of [false, true]) {
      const f = path.join(dir, `same-size-${String(viaBatch)}.txt`)
      const hash = async (): Promise<string | undefined> =>
        viaBatch ? (await cache.hashFiles([f])).get(f) : await cache.hashFile(f)
      await aged(f, 'AAAAA\n')
      const before = await hash()
      const st = statSync(f)
      await aged(f, 'BBBBB\n') // same byte length, different content
      await utimes(f, st.atime, st.mtime) // mtime restored; ctime cannot be
      const now = statSync(f)
      // The fixture is only meaningful while mtime, size and ino all still
      // match — otherwise another field would be doing the work and the
      // row would pass on a memo that ignores ctime.
      expect([
        now.size === st.size,
        Math.floor(now.mtimeMs) === Math.floor(st.mtimeMs),
        Number(now.ino) === Number(st.ino),
      ]).toEqual([true, true, true])
      expect([viaBatch, await hash()]).not.toEqual([viaBatch, before])
    }
  })

  // ctime moves on every write and cannot be set back, so on a real file it
  // masks the other three stat fields; each is held here by a planted row
  // that matches the file in all but that one field (A-23).
  for (const field of ['mtime_ms', 'size_bytes', 'ino'] as const) {
    it(`a memo row whose ${field} disagrees is not trusted, by either form`, async () => {
      const f = path.join(dir, 'f.txt')
      await aged(f, 'real\n')
      const truth = await cache.hashFile(f)
      const st = statSync(f)
      const planted = {
        mtime_ms: Math.floor(st.mtimeMs),
        size_bytes: st.size,
        ctime_ms: Math.floor(st.ctimeMs),
        ino: Number(st.ino),
      }
      planted[field] += 1
      const plant = () =>
        cache
          .dbHandle()
          .query(
            'UPDATE file_hashes SET mtime_ms = ?, size_bytes = ?, ctime_ms = ?, ino = ?, content_hash = ? WHERE path = ?',
          )
          .run(
            planted.mtime_ms,
            planted.size_bytes,
            planted.ctime_ms,
            planted.ino,
            'f'.repeat(40),
            f,
          )
      plant()
      expect(await cache.hashFile(f)).toBe(truth)
      plant()
      expect((await cache.hashFiles([f])).get(f)).toBe(truth)
      // CONTROL: the same row with every field agreeing is trusted.
      planted[field] -= 1
      plant()
      expect(await cache.hashFile(f)).not.toBe(truth)
    })
  }

  it('an executable file keys as 100755 in the batch form too', async () => {
    const x = path.join(dir, 'x.sh')
    await aged(x, 'echo\n')
    await chmod(x, 0o755)
    const single = await cache.hashFile(x)
    expect((await cache.hashFiles([x])).get(x)).toBe(single)
    await chmod(x, 0o644)
    expect(await cache.hashFile(x)).not.toBe(single)
  })

  it('a read-only store hashes a miss but remembers nothing', async () => {
    // The local WRITE axis off: a miss is still hashed, so callers keep
    // working, but the memo stays empty. Both forms gate on it.
    // Its OWN cache dir: sharing the suite's would count rows the
    // write-enabled store wrote, and the row would pass on someone
    // else's memo being empty or fail on it being full.
    const ro = new Cache(path.join(dir, 'ro-cache'), { read: true, write: false })
    try {
      const a = path.join(dir, 'ro-a.txt')
      const b = path.join(dir, 'ro-b.txt')
      await aged(a, 'alpha\n')
      await aged(b, 'beta\n')
      expect(await ro.hashFile(a)).toBe(await cache.hashFile(a))
      expect((await ro.hashFiles([b])).get(b)).toBe(await cache.hashFile(b))
      const rows = ro.dbHandle().query('SELECT COUNT(*) AS n FROM file_hashes').get() as {
        n: number
      }
      expect(rows.n).toBe(0)
    } finally {
      ro.close()
    }
  })

  it('stores the stat times as integers, not sub-millisecond floats', async () => {
    // The columns are INTEGER and both forms floor before storing. An
    // unfloored value round-trips as a float through SQLite's loose
    // typing, so nothing complains — it just stops being the integer the
    // schema says, and two builds that floor differently stop agreeing.
    const a = path.join(dir, 'int-a.txt')
    const b = path.join(dir, 'int-b.txt')
    await aged(a, 'alpha\n')
    await aged(b, 'beta\n')
    await cache.hashFile(a)
    await cache.hashFiles([b])
    const rows = cache
      .dbHandle()
      .query('SELECT path, mtime_ms, ctime_ms FROM file_hashes ORDER BY path')
      .all() as Array<{ path: string; mtime_ms: number; ctime_ms: number }>
    expect(rows.map((r) => r.path)).toEqual([a, b].sort())
    for (const r of rows) {
      expect([r.path, Number.isInteger(r.mtime_ms), Number.isInteger(r.ctime_ms)]).toEqual([
        r.path,
        true,
        true,
      ])
    }
  })

  it('a file changed within the racy window is hashed but not memoised', async () => {
    // The first miss in a store also spawns `git rev-parse` for the object
    // format; pay that on an aged file so the timed part below is only the
    // stat, the digest and the memo query.
    const warm = path.join(dir, 'warm.txt')
    await aged(warm, 'warm\n')
    await cache.hashFiles([warm])
    // The claim holds only while the calls complete inside the window of
    // the write — on a loaded CI runner one attempt can take longer (seen
    // 2026-09-09: 417 ms on ubuntu, the row memoised). The clock decides
    // whether an attempt can judge: assert only when the elapsed time
    // bounds `now - ctime` under the window, else try a fresh file again.
    let judged = false
    for (let attempt = 0; attempt < 20 && !judged; attempt++) {
      const a = path.join(dir, `fresh-${attempt}.txt`)
      const t0 = Date.now()
      await writeFile(a, 'fresh\n')
      const batch = (await cache.hashFiles([a])).get(a)
      const single = await cache.hashFile(a)
      const elapsed = Date.now() - t0
      expect(batch).toBe(single)
      if (elapsed >= FILE_HASH_RACY_MS) continue
      const rows = cache.dbHandle().query('SELECT path FROM file_hashes WHERE path = ?').all(a)
      expect(rows).toEqual([])
      judged = true
    }
    expect(judged).toBe(true)
  })
})

// Item 1082: `seen_at` was written and never read, so a row for every path
// ever hashed stayed, a deleted generated input or a removed worktree's
// files among them, and `cache.db` grew for good.
describe('file_hashes retention', () => {
  const DAY = 24 * 60 * 60 * 1000
  function seed(p: string, seenAt: number): void {
    cache
      .dbHandle()
      .query(
        "INSERT INTO file_hashes(path, mtime_ms, size_bytes, ctime_ms, ino, content_hash, seen_at) VALUES (?, 1, 1, 1, 1, 'x', ?)",
      )
      .run(p, seenAt)
  }
  function paths(): string[] {
    return (
      cache.dbHandle().query('SELECT path FROM file_hashes ORDER BY path').all() as Array<{
        path: string
      }>
    ).map((r) => r.path)
  }

  it('a close drops rows unseen for 30 days, at most once a day', async () => {
    seed('/gone/old', Date.now() - 31 * DAY)
    seed('/kept/fresh', Date.now() - 29 * DAY)
    cache.close()
    cache = new Cache(path.join(dir, 'cache'), { read: true, write: true })
    expect(paths()).toEqual(['/kept/fresh'])
    // The sweep's clock: a second close within the day scans nothing.
    seed('/gone/later', Date.now() - 31 * DAY)
    cache.close()
    cache = new Cache(path.join(dir, 'cache'), { read: true, write: true })
    expect(paths()).toEqual(['/gone/later', '/kept/fresh'])
  })
})
