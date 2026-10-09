# Cache save CPU — design

> **Status:** proposal (2026-10-08). Step 1 shipped as X-191, step 2 as X-204, step 3 as X-205; step 4 refuted (X-206); one `entry_inputs` row per entry shipped as X-207 (`docs/history/ws-x.md`).

## What we're solving

Cold run, 1,090 packages / 2,180 tasks, 1,090 saves of a tiny `dist/`:
vx's own CPU is ~8.6 s, and the save costs ~3.8 s of it (no save: 8.7 → 4.7 s).
Vite Task's total cold CPU is 20.7 s and vx's is 26.7 s, so vx needs ~5–6 s less of its own CPU.
**This design does not close that gap alone.** It removes ~2 s, about half of the save.
The rest has to come from outside the save.

## Where the CPU goes (per save, one-file artifact)

In-run numbers are the owner's measurements. Micro numbers come from
`bun` 1.4.2 on an idle core: 1,000 ops, one output of 400 B, 5,120 B tar,
278 B zst. Under load the in-run numbers are 3–5× the micro ones because
of thread-pool wakeups and cache pressure. Read the micro column as
ratios.

| Part                                              | Site                                                                  | In-run (1,090 saves)      | Micro                            |
| ------------------------------------------------- | --------------------------------------------------------------------- | ------------------------- | -------------------------------- |
| temp `writeFile` (pool) + rename                  | `cache.ts:1977-1986`, `2093-2098`                                     | ~1.0 s                    | 187 µs (sync write + rename: 56) |
| move-aside rename + tmp→final rename inside tx    | `cache.ts:2088-2099`                                                  | part of 0.65 s            | —                                |
| index tx: BEGIN IMMEDIATE / COMMIT                | `cache.ts:2091-2141`                                                  | ~0.33 s                   | 28 µs, row only                  |
| index tx: inserts                                 | `cache.ts:2100-2129`                                                  | ~0.33 s incl. renames     | —                                |
| scan of own tar (async generators, CRC, drain)    | `cache.ts:2000-2004` → `archive.ts:423-466` → `tar-stream.ts:194-276` | ≤0.45 s                   | 159 µs (sync prototype: 22 µs)   |
| pack (async gens `summed`/`tarPack`, `for await`) | `archive.ts:375-396`                                                  | not split out             | 84 µs                            |
| plan (lstat, meta JSON)                           | `archive.ts:232-338`                                                  | not split out             | 39 µs                            |
| zstd                                              | `zstd.ts:137`                                                         | 0.19 s                    | 43 µs                            |
| lane + promise hops, `span`s, GC                  | `save-lane.ts`, `miss-save.ts:165-199`                                | rest (~1.3 s unaccounted) | —                                |

Other micro facts used below:

- A 278 B blob in the same tx as the row costs +17 µs (45 against 28 µs).
- Batching 8 saves into one tx costs 16 µs per save, against 45 µs one tx each.
- A blob SELECT costs 7–9 µs. `Bun.file(...).bytes()` of the artifact file costs 141 µs.
- An append to an open fd costs 3 µs.

The ~1.3 s unaccounted is probably plan, pack, async overhead and GC.
Treat that as an assumption. Step 2 measures it.

## Access pattern

- Saves land in bursts, one per miss, up to `2 × concurrency` in flight (`run.ts:809`).
- Nearly all artifacts are tiny: one to a few files, under 1 KB compressed.
- A save must be durable in the index before `landed` resolves. Dependants (`scheduler.ts:893`) and admission joiners (`admission.ts:216`) wait for it.
- The read side has three users:
  - `get`/`getMany` read the row and stat the artifact (`cache.ts:1342`, `1396`).
  - `restoreOutputs` reads the artifact (`cache.ts:1569`).
  - Uploads pin it (`layered-cache.ts:583`).
- Several vx processes share `~/.vx/<id>/cache`. SQLite's write lock is the only cross-process serializer.

## Options (ranked by CPU saved vs. risk)

| #     | Option                                                                                                                       | Est. CPU saved | Risk                                                                                                     |
| ----- | ---------------------------------------------------------------------------------------------------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------- |
| **A** | **Inline small artifacts in `store.db`, scan in memory synchronously, pack synchronously, group-commit per event-loop turn** | **~1.8–2.3 s** | medium: new location, prune and adopt paths                                                              |
| B     | Per-process append-only pack files (`<pid>-<n>.pack`), with an index of offset and length                                    | ~1.8–2.2 s     | high: a second container format, compaction for prune, adopt needs a pack scan, crash leaves a torn tail |
| C     | Keep one file per artifact. Only sync scan, sync pack, group commit, no aside rename                                         | ~0.6–0.9 s     | low                                                                                                      |

Rejected:

- **Writer worker(s).** Process CPU counts the worker, so this moves cost and doesn't remove it. It also adds structured-clone copies.
- **Skipping the scan.** That drops the name-safety and round-trip guarantee.
- **Temp writes on the main thread.** Measured worse (+0.3–1.0 s).
- **Skipping the move-aside rename alone.** Measured zero.

B buys about the same CPU as A, but needs a new on-disk container and a
garbage collector. SQLite is already a crash-safe, multi-process
append-and-free store, and the one each save already commits into.
C is a strict subset of A, and A ships it as its first steps.

## Recommendation: A

An artifact whose compressed size is at most `INLINE_MAX` lives as a
BLOB in the store's `artifacts` table. The INSERT is in the same
transaction as its `entries` / `output_files` / `entry_inputs` rows.

- Start `INLINE_MAX` at 32 KiB. Step 3 decides it from 8, 32 and 128 KiB arms. SQLite's own internal-vs-external BLOB study puts the break-even near 100 KB, and WAL writes a blob twice.
- Larger artifacts keep today's file path.
- The bytes are the same `tar.zst`, with the same sidecar key and `.vx-sum`. Only where the bytes live changes.

### Concrete spec

**Table.** It lives in the store schema (`store.db`, or `cache.db` for a named `cacheDir`):

```sql
CREATE TABLE IF NOT EXISTS store.artifacts (
  hash  TEXT PRIMARY KEY,
  bytes BLOB NOT NULL,      -- the exact <hash>.tar.zst bytes
  at    INTEGER NOT NULL    -- last use (ms), the file-mtime equivalent for row-less sweeps
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS store.artifacts_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- ('layout', 'a1'): the only thing that may drop `artifacts`.
```

- `artifacts` is **not** in `STORE_TABLES` (`cache.ts:246`) or the `main` drop list (`cache.ts:850`). A `SCHEMA_VERSION` reset drops the index and keeps the bytes, as it keeps files today. Older vx versions don't know the table and leave it alone. This keeps M's rule: the artifact is the record, the index only an inventory.
- `artifacts_meta.layout` is the table's own version sentinel. A different value drops `artifacts`, silently.

**Save.**

- The plan, read, pack, zstd and scan steps run synchronously when the plan size is at most `ON_THREAD_MAX`.
- If `compressed.byteLength ≤ INLINE_MAX`:
  - No temp, no rename.
  - The tx runs `INSERT INTO artifacts … ON CONFLICT(hash) DO UPDATE SET bytes=excluded.bytes, at=excluded.at`, plus today's rows.
  - If the previous row's `size_bytes > INLINE_MAX` (read in the tx), unlink the old `<hash>.tar.zst` after commit.
- Otherwise use today's file path, and the tx also runs `DELETE FROM artifacts WHERE hash=?`.
- Either way, a hash's live bytes are in exactly one place, as of each commit.
- Readers prefer the blob, then the file. A stale file next to a blob is ignored and the sweep reaps it.

**Scan.** `scanTarBytes(tar: Uint8Array)` is a synchronous walk over the
in-memory tar. It is built from the same header, pax and field decoders
as `tarEntries`, extracted into one shared pure function. It keeps the
same `SumCheck`, `assertSafeName`, key check and `assertArtifactNames`.
Its output must deep-equal `scanArtifact`'s. Streaming `scanArtifact`
stays for large artifacts and for ingest of files.

**Pack.** `packArtifactBytes` gets a synchronous body for `size ≤ ON_THREAD_MAX`, with no async generators. The streaming pack is unchanged.

**Group commit.** Saves that are ready queue their index work. One `setImmediate` flush runs them all in one `BEGIN IMMEDIATE`, each in its own `SAVEPOINT`.

- A save that throws rolls back only its savepoint. It reports through the lane, which degrades it to a miss.
- A failed COMMIT (`SQLITE_BUSY` past the timeout, `SQLITE_FULL`) fails every save in the batch. For the file path, renamed files are unlinked as today.
- `landed` resolves after COMMIT. That adds at most one event-loop turn of latency.
- The lock is held for k × ~16 µs.

**Read side.**

- `SELECT_ENTRY` gains `a.hash IS NOT NULL AS inline` through a LEFT JOIN on `artifacts`. An inline hit needs no `statSync`, which saves one stat per hit on the warm path. Pin that with a measurement.
- `restoreOutputsOnce` reads the rows and the blob **in one read transaction**, so a concurrent re-save can't pair one save's rows with another's bytes. Today the rows and the file are two reads. A file hit decodes as today.
- `pinArtifact` returns `new Blob([bytes])` for inline, read once, so the bytes are stable by construction.
- `adopt` finds a row-less blob and indexes it from its bytes in one tx. No link-and-touch dance.
- Ingest: a remote body at most `INLINE_MAX` (by `Blob.size` or `Content-Length`, counted as it streams and capped at `INLINE_MAX`) is read to memory, decoded, scanned and inserted inline. A larger body takes today's temp path.
- Prune and `evictIfDue`:
  - Victims delete their `artifacts` rows in the same tx as `entries`.
  - `phantomRows` counts inline rows as present.
  - Row-less blobs older than the policy, judged by `at`, are reaped the way row-less files are, and counted in `orphanStats`.
  - `flushAccessed` bumps `artifacts.at` for inline `staleTimes` instead of calling `utimes`.
- `outputsPath` (`layer.ts:728-734`) gets a corrected doc: it names a file for a file-backed artifact, and small artifacts live in the index. Add an optional `artifactSize?(hash)` to `CacheLayer` for `miss-save.ts:195`, which today stats the path. This changes the plugin surface. It is optional, so existing layers still type-check.
- The DB doesn't shrink after prune. Freed pages get reused. New stores are created with `auto_vacuum = INCREMENTAL`, and prune runs `PRAGMA incremental_vacuum`. Existing stores keep their size until a manual `VACUUM`. That's a real cost, and it's stated here.

### Output log (stderr)

Per the coordinator, M approved stderr in the cache. Another thread lands
it first as one ordered output log: chunks in read order, each `{ text, err }`,
the `OutputChunk` shape from `framed-output.ts`. This design builds on
that shape and adds no separate stderr field.

**Where it lives.**

1. In the artifact, as the log entry that replaces `stdout`, so it rides every remote wire verbatim.
2. In the index, as the encoded log in the row that replaces `entry_stdout`, so a hit replays it without decoding the artifact. Decoding per hit would put ~30 µs on the warm path, 30 ms per 1,000 hits.

Encode the index copy compactly, not as JSON: per chunk, a stream byte, a varint length, then the UTF-8 bytes.

**Cost per save.** It is linear in the log's bytes, and nothing for a quiet task.

- The bytes are added to the tar, the CRC and the zstd input, and written raw to the index.
- A few hundred bytes cost < 2 µs.
- 100 KB of warnings cost ~0.2 ms of zstd plus ~25 WAL pages for the index copy.
- A noisy log also pushes its artifact past `INLINE_MAX`, onto the file path.
- Inline entries hold the log twice (raw in the index, compressed in the blob). That is the price of a decode-free hit.

**Versions.**

- The log changes the stored bytes, so it carries the `CACHE_VERSION` bump (v41 → v42).
- This design changes no artifact byte, so it needs **no** `CACHE_VERSION` bump of its own. If both land in one release window, they share v42.
- It needs one `SCHEMA_VERSION` bump for the new tables and the `inline` read. If the log's PR has already bumped the schema, this one bumps it again; if the two are coordinated, one bump covers both.

### Correctness argument

- **Crash or interrupt (kill, Ctrl-C, OOM).** An inline artifact and its rows are one transaction in one database file. WAL commit is atomic, so either both are there or neither is. No temp files, no rename window, no orphans. A tx across attached DBs is _not_ atomic under WAL, which is why the blob must not live in a separate `artifacts.db`.
- **Power loss** (`synchronous=NORMAL`). The last commits may roll back, but always rows and bytes together. Today the file and the WAL are lost independently, and only the CRC catches it. The CRC stays as the backstop.
- **Concurrent processes.**
  - Writers serialize on the store's write lock. Two saves of one key are an upsert of bytes and rows in one tx each: last writer wins, never mixed. The A-3 mixed pairing can't happen.
  - The file↔inline switch for one key flips in the same tx as the rows (DELETE blob, or blob precedence).
  - Readers see a WAL snapshot. Rows and blob are read in one read tx.
- **Restore reads exactly what the save meant.**
  - Same bytes and same decoder.
  - The sync scan is held to the stream scan by shared decode code and a parity property test. So index rows equal what `tarEntries` yields on restore, and unsafe names are refused before insert.
  - The CRC and sidecar-key checks run on every restore, unchanged.
- **Stale hits.** Keys are unchanged, and bytes go live only with their own key's rows. A blob without a row is only ever adopted after its sidecar key matches.

## Tests that must prove it

Each test must fail without its fix (differential).

1. **Atomic inline save.** A throw injected after the blob insert, inside the tx, leaves no row and no blob. The control (blob insert moved outside the tx) fails.
2. **Two-writer pairing.** Two processes re-save one key with different bytes in a loop while a third restores. Every restore's files match the `output_files` rows it read (adapt the A-3 row). Must fail with rows and blob read in two read txs.
3. **Location switch.** File → inline → file for one key. Each read gets the latest bytes. The stale file is reaped, and no phantom row is counted by `--max-size`.
4. **Reset survival.** Bump `SCHEMA_VERSION` in a fixture: rows go, the blob stays, and `get` with ctx adopts it into a hit. Simulate an old vx dropping `STORE_TABLES`: `artifacts` survives.
5. **Sync scan parity (property test).** Generated names cover ASCII, unicode, exactly 100 bytes, > 100 (pax), the ustar prefix split, 255-byte segments and a deep path. Pack, then scan with the sync and stream scanners: deep-equal. Then a byte-flip table over every header, body and sum byte: both refuse with the same class. Run the hostile name fixtures from the archive security suite through both.
6. **Small ingest inline.** Wrong key, truncated, bomb, and body past the cap must leave no row and no blob. A good body is inline and hits.
7. **Group commit.**
   - One save throws in a batch of N: the others land.
   - A forced `SQLITE_FULL` at commit: every save is reported once, no rows, no renamed files.
   - `landed` resolves only after commit: an admission joiner probes a hit.
8. **Prune.**
   - Inline sizes count toward `maxBytes`.
   - Victims' blobs are gone in the same tx.
   - Row-less blobs are reaped by `at`, and `vx info` orphan counts include them.
   - A dry run deletes nothing.
9. **Pin stability.** Pin an inline artifact, re-save the key: the pinned body is unchanged.
10. **Warm path.** An inline hit does no `stat` (`syscall-repeats.unsafe.test.ts` updated). The warm no-op bench shows no regression.
11. **Output log.**
    - A hit's replay equals the miss's interleaving byte for byte, stderr chunks in order.
    - The index log equals the artifact's log.
    - A remote-ingested entry replays the same.
12. **Version sentinels.** A foreign `artifacts_meta.layout` drops `artifacts` silently and prints nothing.

## Implementation plan (PR-sized, in order)

Each step is A/B'd on the 1,090-package cold row (interleaved arms, min-of-N, before-arm from a worktree) once the host is free.

1. `perf(cache): scan a save's own tar in memory, synchronously`. Extract the shared header decode, add `scanTarBytes`, parity tests (5). Expected −0.3 to −0.4 s. Low risk, no format change.
2. `perf(cache): pack a small artifact synchronously`. Sync body under `ON_THREAD_MAX`, and an A/B that splits out plan, pack and the unaccounted ~1.3 s. Expected −0.1 to −0.3 s.
3. `perf(cache): store small artifacts inline in the store index`. Add the table and sentinel, save, read, restore, has/get/getMany, adopt, ingest, pin, prune and sweep, `artifactSize?`, docs (`modules/cache.md` § Storage layout and § Atomic writes, `caching.md`), tests 1–4, 6, 8–10, 12, and a `SCHEMA_VERSION` bump. The `INLINE_MAX` arms decide the threshold. Expected −1.0 to −1.2 s. The largest PR: about 2–3 days with tests. Rebase it on the output-log PR, and the log's tests (11) must pass here.
4. `perf(cache): commit a turn's saves in one transaction`. Savepoints, batch failure path, tests 7. Expected −0.2 to −0.3 s.
5. `docs`: record the measured numbers in STATUS and the history file.

## Out of scope

- The other ~4.7 s of vx's own CPU (discovery, keys, scheduling, spawn), which this gap also needs.
- Shrinking existing large `store.db` files.
- Remote wire formats (bytes unchanged).
- Large artifacts (> `INLINE_MAX`), which keep the file path except for steps 1, 2 and 4.
- The output-log feature itself (the other thread).
- fsync policy.
- `auto_vacuum` / incremental vacuum on the store. Step 3 skipped it: a prune frees inline pages for reuse but the file does not shrink. Open until a store's size after prune is measured to matter.

## Open questions

- `INLINE_MAX` value (step 3 arms).
- Whether the remaining ~1.3 s is lane and promise overhead (then trim `save-lane.ts` and `miss-save.ts`) or GC. Step 2 measures it.
- Whether WAL autocheckpoint (1,000 pages) during a cold burst costs measurable main-thread time. If so, set `wal_autocheckpoint` higher on the store handle and checkpoint at close.

## Why this is the right move

- It removes the single largest save cost, file creation plus two renames (~1.0 s), and doesn't just move it to a thread.
- Atomicity gets stronger: one transaction holds the bytes and their rows, and restore reads both from one snapshot.
- It composes what's there: SQLite already serializes the cross-process store. There's no new container format and no GC to write.
- Steps 1, 2 and 4 are independent, low-risk wins that land even if step 3 slips.
- It is honest about the ceiling: ~2 s of the ~5–6 s needed.
