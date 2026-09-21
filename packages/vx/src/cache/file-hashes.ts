// The per-file content-hash memo. A file's cache-key contribution is its
// git blob OID; a clean tracked file takes it from the index (inputs.ts),
// everything else is hashed here from the worktree bytes — memoized on
// (mtime, size, ctime, ino) in `file_hashes`, the same four fields git's
// own index keys on — and a symlink hashes as the blob of its target
// string, exactly as the index stores it. Owns its two statements over
// the store's handle; `Cache` delegates.

import type { Database } from 'bun:sqlite'
import { lstatSync, readlinkSync } from 'node:fs'
import path from 'node:path'
import { FILE_HASH_RACY_MS } from './layer.js'

export class FileHashStore {
  private readonly selectFileHash: ReturnType<Database['prepare']>
  private readonly upsertFileHash: ReturnType<Database['prepare']>
  private objectFormat: 'sha1' | 'sha256' | null = null

  constructor(
    private readonly db: Database,
    /** Where `git rev-parse --show-object-format` is asked, once, when a file misses the memo. */
    private readonly cacheDir: string,
    /** The local WRITE axis: off, and a miss is hashed but not remembered (a read-only cache). */
    private readonly write: boolean = true,
  ) {
    this.selectFileHash = this.db.prepare(
      'SELECT mtime_ms, size_bytes, ctime_ms, ino, content_hash FROM file_hashes WHERE path = ?',
    )
    this.upsertFileHash = this.db.prepare(`
      INSERT INTO file_hashes(path, mtime_ms, size_bytes, ctime_ms, ino, content_hash, seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        mtime_ms     = excluded.mtime_ms,
        size_bytes   = excluded.size_bytes,
        ctime_ms     = excluded.ctime_ms,
        ino          = excluded.ino,
        content_hash = excluded.content_hash,
        seen_at      = excluded.seen_at
    `)
  }

  /**
   * Content-hash a file (as a git blob OID, v20) with an mtime+size
   * fast path. If the `file_hashes` table has a row for `path` whose
   * `(mtime_ms, size_bytes, ctime_ms, ino)` all match the current
   * stat, we reuse the stored content_hash (a memory + SQLite lookup,
   * no disk read). Otherwise we read + hash + upsert. All four fields
   * are load-bearing — see the comment at the comparison.
   *
   * The OID is byte-identical to what `git hash-object` (and the git
   * index) computes for the same content — for a symlink, the index's
   * mode-120000 blob of the link text — so this fallback and the
   * `CacheKeyInput.fileHashes` index-OID fast path agree on any file
   * git stores verbatim. They do NOT agree when a clean filter
   * (`text`/`eol`/`ident`) is active: the index blob is the filtered
   * form while this hashes the worktree bytes, so `inputs.ts` drops
   * the index OID for those paths and routes them here.
   */
  async hashFile(filePath: string): Promise<string> {
    // lstatSync intentional: a single stat is ~1.6µs (Bun 1.3); the
    // async-stat equivalent adds ~75µs of Promise machinery per call.
    // Promise.all over the batched callers (key derivation) gives no
    // I/O parallelism benefit because the stat is faster than the
    // threadpool dispatch overhead. lstat, not stat, so a symlink is
    // seen as one.
    let st
    try {
      st = lstatSync(filePath)
    } catch {
      // Caller is responsible for skipping files that don't exist;
      // fall through to the content-hash path which will throw with
      // a more useful error.
      return await this.hashFileFromDisk(filePath)
    }
    // A symlink folds as git folds it: the blob of its TARGET STRING, which
    // is its mode-120000 index OID. Not the bytes behind it — a link to a
    // directory has none, a dangling one has none, and a link to a file
    // outside the project would fold bytes `git diff` and `--affected`
    // cannot see. A link to a file inside the project still tracks that
    // file's content, because the file is an input in its own right. No
    // memo: readlink is one syscall, and the row would be keyed on the
    // link's own stat, not its target's.
    if (st.isSymbolicLink()) return this.hashBlob(new TextEncoder().encode(readlinkSync(filePath)))
    const mtimeMs = Math.floor(st.mtimeMs)
    const size = st.size
    // ctime + ino are what make this memo SAFE, not merely fast. mtime is
    // caller-settable, so (mtime, size) alone hands back the previous run's
    // digest for genuinely different bytes whenever a producer preserves
    // mtime — `tar -x`, `unzip`, `cp -p`, `rsync --times`, any
    // SOURCE_DATE_EPOCH generator — which is a stale cache hit. `utimes`
    // cannot suppress ctime without root, and an atomic write-then-rename
    // changes the inode; git's own index keys on ctime+ino+dev for exactly
    // this reason. Both fields come from the stat we already took.
    const ctimeMs = Math.floor(st.ctimeMs)
    const ino = Number(st.ino)
    const row = this.selectFileHash.get(filePath) as
      | {
          mtime_ms: number
          size_bytes: number
          ctime_ms: number
          ino: number
          content_hash: string
        }
      | undefined
    if (
      row &&
      row.mtime_ms === mtimeMs &&
      row.size_bytes === size &&
      row.ctime_ms === ctimeMs &&
      row.ino === ino
    ) {
      return row.content_hash
    }
    const ch = await this.hashFileFromDisk(filePath)
    // git's racy-clean rule, applied to the memo: a stat taken in the same
    // tick as the file's last change cannot be trusted next time, because a
    // rewrite landing in that tick keeps ctime (and, with mtime restored,
    // every other field) equal and would hand back THIS digest for other
    // bytes — seen once on ubuntu CI, on a docs-only commit. So a file
    // changed within the window is hashed again on its next call rather
    // than memoised; the warm path never meets it (keys are derived long
    // after the files were written).
    if (this.write && Date.now() - ctimeMs >= FILE_HASH_RACY_MS) {
      this.upsertFileHash.run(filePath, mtimeMs, size, ctimeMs, ino, ch, Date.now())
    }
    return ch
  }

  /**
   * `hashFile` for many paths at once, with ONE memo query. The per-file
   * form costs a SQLite point lookup each; a warm config load keys 1,000
   * closures that way (7.7 ms of `get` in a 2026-09-09 profile), where one
   * `IN` query over all of them costs well under a millisecond. Same stat
   * fields, same racy-clean rule, same digest. A path that cannot be
   * stat'ed is absent from the result (the caller decides what a missing
   * identity means) rather than thrown, so one vanished preset does not
   * fail the batch for every other config.
   */
  async hashFiles(paths: readonly string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>()
    if (paths.length === 0) return out
    interface Stat {
      mtimeMs: number
      size: number
      ctimeMs: number
      ino: number
    }
    const stats = new Map<string, Stat>()
    for (const p of paths) {
      if (stats.has(p) || out.has(p)) continue
      try {
        // lstat, not stat: `hashFile` folds a symlink as git folds it —
        // the blob of its TARGET STRING — and this form promises the same
        // digest. Following the link here instead hashed the target's
        // BYTES, so the same path identified differently depending on
        // which entry point the caller used, and the batch folded bytes
        // `git diff` and `--affected` cannot see.
        const st = lstatSync(p)
        if (st.isSymbolicLink()) {
          // No memo, for `hashFile`'s reason: the row would be keyed on
          // the link's own stat, not its target's.
          out.set(p, this.hashBlob(new TextEncoder().encode(readlinkSync(p))))
          continue
        }
        stats.set(p, {
          mtimeMs: Math.floor(st.mtimeMs),
          size: st.size,
          ctimeMs: Math.floor(st.ctimeMs),
          ino: Number(st.ino),
        })
      } catch {
        // absent from the result
      }
    }
    const wanted = [...stats.keys()]
    const misses: string[] = []
    // SQLite's bound-variable ceiling is 32,766 (999 on old builds); 500
    // keeps a closure list of any size inside either.
    for (let i = 0; i < wanted.length; i += 500) {
      const chunk = wanted.slice(i, i + 500)
      const rows = this.db
        .query(
          `SELECT path, mtime_ms, size_bytes, ctime_ms, ino, content_hash FROM file_hashes WHERE path IN (${chunk.map(() => '?').join(',')})`,
        )
        .all(...chunk) as Array<{
        path: string
        mtime_ms: number
        size_bytes: number
        ctime_ms: number
        ino: number
        content_hash: string
      }>
      const byPath = new Map(rows.map((r) => [r.path, r]))
      for (const p of chunk) {
        const st = stats.get(p)!
        const row = byPath.get(p)
        if (
          row &&
          row.mtime_ms === st.mtimeMs &&
          row.size_bytes === st.size &&
          row.ctime_ms === st.ctimeMs &&
          row.ino === st.ino
        ) {
          out.set(p, row.content_hash)
        } else misses.push(p)
      }
    }
    if (misses.length === 0) return out
    const digests = await Promise.all(
      misses.map((p) => this.hashFileFromDisk(p).catch(() => undefined)),
    )
    const now = Date.now()
    this.db.transaction(() => {
      for (let i = 0; i < misses.length; i++) {
        const digest = digests[i]
        if (digest === undefined) continue
        const p = misses[i]!
        const st = stats.get(p)!
        out.set(p, digest)
        // The same racy-clean rule as `hashFile`: a stat taken within the
        // window of the file's last change is not memoised.
        if (this.write && now - st.ctimeMs >= FILE_HASH_RACY_MS) {
          this.upsertFileHash.run(p, st.mtimeMs, st.size, st.ctimeMs, st.ino, digest, now)
        }
      }
    })()
    return out
  }

  /**
   * Git blob OID of the file's bytes:
   * `hex(HASH("blob " + byteLength + "\0" + content))`, where HASH is
   * the repo's object format. Same value `git hash-object` prints and
   * the same value the index stores. Computed in-process — no git
   * spawn per file.
   */
  private async hashFileFromDisk(filePath: string): Promise<string> {
    return this.hashBlob(await Bun.file(filePath).bytes(), filePath)
  }

  /** `git hash-object` of `bytes`: the blob OID in the repo's object format. */
  private hashBlob(bytes: Uint8Array, nearPath?: string): string {
    const hasher = new Bun.CryptoHasher(
      this.objectFormat ?? this.detectObjectFormat(nearPath ?? this.cacheDir),
    )
    hasher.update(`blob ${bytes.byteLength}\0`)
    hasher.update(bytes)
    return hasher.digest('hex')
  }

  /**
   * Repo object format — sha1 unless the repo was created with
   * `--object-format=sha256`. One `git rev-parse` spawn per Cache
   * lifetime, and only when at least one file misses the mtime+size
   * memo. Outside a repo (unit fixtures) we default to sha1, which is
   * still a deterministic blob-OID domain.
   */
  private detectObjectFormat(nearPath: string): 'sha1' | 'sha256' {
    let detected: 'sha1' | 'sha256' = 'sha1'
    try {
      const proc = Bun.spawnSync({
        cmd: ['git', 'rev-parse', '--show-object-format'],
        cwd: path.dirname(nearPath),
        stdout: 'pipe',
        stderr: 'pipe',
      })
      if (proc.exitCode === 0 && new TextDecoder().decode(proc.stdout).trim() === 'sha256') {
        detected = 'sha256'
      }
    } catch {
      // git unavailable → sha1 default keeps hashing deterministic.
    }
    this.objectFormat = detected
    return detected
  }
}
