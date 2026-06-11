# Integrity & robustness audit — May 2026

> **Status:** proposal. Findings from a Turbo + Nx review focused on
> integrity holes and robustness gaps in our cache + orchestrator.
> Each item below has a verified source link in Turbo or Nx; mark a
> fix as **shipped** when its PR merges.

## Why this audit

Recent PRs (#86–#95) tightened the cache-hit hot path significantly:
xxh3 keys, tar.zst artifacts, single-decompress slot, manifest in the
SQLite `output_files` table, bulk `git ls-files`, reverse-dep
scheduling. Speed is in a good place. What we **haven't** systematically
checked is what happens when things go wrong: signals, corruption,
shared-cache poisoning, transient FS failures, path-escape in tar
extracts.

Spent a session reviewing Turborepo (`/tmp/turbo/crates/`) and Nx
(`/tmp/nx/packages/nx/src/`) for patterns we don't have. Findings
below, prioritized by severity. Two principles applied:

1. **Real source verification** — every claim links to a file:line
   range in Turbo or Nx that we confirmed exists (the first-pass
   subagent reports both contained hallucinated "findings" that
   matched things we'd already shipped — those are filtered out).
2. **Integrity over speed** — speed wins are already in the
   `comparison.md` backlog; this doc is for correctness / robustness
   gaps the speed work didn't surface.

---

## Findings, ordered by severity × ease

### 1. No SIGINT / SIGTERM handler in `run()` — HIGH, ~30 LOC

**The gap.** `src/cli/watch.ts:204-208` installs `process.once('SIGINT',
…)` and `process.once('SIGTERM', cleanup)`. The main orchestrator
`src/orchestrator.ts:run()` does not. When a user hits Ctrl+C during a
`vx run`:

- In-flight child tasks become process-group orphans (depending on
  shell + invocation form).
- The `try { … } finally { cache.close() }` block at
  `src/orchestrator.ts:311-313` is skipped — signal interrupts don't
  run JS finally handlers.
- SQLite WAL may be mid-transaction. The `busy_timeout = 5000` from
  PR #17 covers concurrent writers but not partial commits.
- Tar `.tmp-<pid>-<ts>` staging files orphan in `<cacheDir>/`.

**Comparable patterns.**

- Nx forwards signals via IPC in
  `packages/nx/src/tasks-runner/forked-process-task-runner.ts:411-444`,
  with `process.once('exit', …)` as a final fallback for synchronous
  cleanup.

**Fix sketch.** At the top of `run()`, install handlers that:

1. Stop accepting new tasks (set a shared `abortToken`).
2. SIGTERM every entry in `persistentRegistry` + every in-flight
   `Bun.spawn` from `runner.ts` (we already track those for persistent
   tasks; need to extend to one-shot tasks).
3. `cache.close()` synchronously.
4. Remove the handlers (so a second Ctrl+C kills the parent).
5. `process.exit(130)` (the conventional 128 + SIGINT).

Keep this orchestrator-internal — don't install global process
handlers from a library API, since embedders own the process.

---

### 2. Path-traversal hole in `extractOutputs` — MEDIUM, ~5 LOC

**The gap.** `src/cache/tar.ts:174` does

```ts
const target = path.join(destDir, rel)
```

without verifying that `target` resolves inside `destDir`. A tar
entry with a name like `outputs/../../../etc/passwd` would have
`rel = '../../../etc/passwd'`, and `path.join` would resolve outside
`destDir`. We then `Bun.write(target, body)` at line 204.

**Why it doesn't bite today.** Tars are produced by our own
`save()`, which only stages files inside `args.projectDir`. The tar
entry names always start with `outputs/<rel>` where `<rel>` is
project-relative and has no `..` components by construction. So the
hole is theoretical for the local-only flow.

**When it becomes exploitable.**

- A corrupted tar.zst on disk (bad sector, partial write, etc.) —
  unlikely but possible.
- A malicious or compromised remote cache pushing crafted artifacts.
- A user mounting `<cacheDir>` across machines and someone with write
  access to the mount substitutes a tar.

**Comparable patterns.**

- Turbo's symlink-restore path lexically validates targets to detect
  escape attempts (`crates/turborepo-cache/src/cache_archive/restore_symlink.rs:53-189`).
  They do the same kind of check for regular files via
  `turbopath::AnchoredSystemPath` typing — every path in their tar
  pipeline is type-tagged as "inside the anchor".

**Fix sketch.**

```ts
const target = path.resolve(destDir, rel)
if (!target.startsWith(path.resolve(destDir) + path.sep)) {
  throw new Error(`tar entry escapes destDir: ${rel}`)
}
```

Same check for dir entries. Reject the whole archive on first
violation. A small unit test that builds a tar with a malicious entry
name and asserts the throw pins the contract.

---

### 3. No content verification on restore — MEDIUM, schema bump

**The gap.** `Cache.get()` and `Cache.restoreOutputs()` decompress
`<hash>.tar.zst` and extract — but never check that the bytes match
what we wrote. Failure modes the bit-exact path doesn't catch:

- Disk bit-flip / silent ECC failures on long-lived caches.
- Partial write surviving a crash (our `tmp + atomic rename` at
  `cache.ts:770-833` mostly prevents this — but there's a small
  window between `Bun.write(tmpPath)` and `rename(tmpPath, finalPath)`).
- Manual tampering by anyone with write access to `<cacheDir>`.

**Comparable patterns.**

- Turbo's signature layer
  (`crates/turborepo-cache/src/signature_authentication.rs:1-80`)
  computes HMAC-SHA256 over `task_hash || team_id || artifact_bytes`
  and embeds the tag in the `x-artifact-tag` header — but this only
  covers remote cache; local artifacts are unverified.
- Nx's `tasks-runner/cache.ts:107-139` (`DbCache.get`) also returns
  unverified bytes. So this is a gap across the ecosystem; we'd be
  the first to close it for the local path.

**Fix sketch.**

1. Add `artifact_hash TEXT` column to `entries` (SCHEMA_VERSION bump
   v16 → v17).
2. In `save()`, after computing the compressed tar bytes, compute
   `xxh3(compressed)` and store. Cost: one xxh3 over ~hundreds-of-KB
   = single-digit microseconds. Already in-memory.
3. In `get()`, after reading the tar bytes from disk and before
   decompressing, compute xxh3 and compare. On mismatch, log a warning,
   delete the entry + artifact, return null (treat as cache miss).

Strong correctness with negligible cost. The xxh3 hash here is
**non-cryptographic** — it catches accidental corruption but not
adversarial tampering. That's fine for the local-cache contract; the
adversarial case is covered by item #4 below for the remote path.

---

### 4. No HMAC on remote cache artifacts — MEDIUM, only when remote is shared

> **Shipped 2026-06** via `VX_REMOTE_CACHE_SIGNATURE_KEY`. We followed
> Turbo's exact construction (`hash || teamId || body`, not the
> `taskId` variant sketched below) for wire-level interop with the
> existing signing ecosystem. See
> [`remote-cache.md` § Authentication](remote-cache.md#authentication).

**The gap.** Our remote cache (`src/cache/remote-cache.ts`) PUTs and
GETs tar.gz artifacts with no signing layer. Anyone with write
access to the remote bucket can substitute artifacts; we'd happily
restore them.

For solo / trusted-team use this is fine. For larger teams or
managed-cache services (`ducktors/turborepo-remote-cache`, Vercel
hosted cache), it's a real cache-poisoning vector.

**Comparable patterns.**

- Turbo's signature layer (linked above) gates HMAC behind
  `TURBO_REMOTE_CACHE_SIGNATURE_KEY` env var. Minimum key length 32
  bytes. Optional today; future-direction is mandatory.
  - The signed metadata is `hash || team_id` (not just hash), so
    artifacts from a different team can't be substituted in.
  - Tag travels in `x-artifact-tag` HTTP header.
  - Verification is silent on the happy path, hard error on
    mismatch.

**Fix sketch.**

1. New env var `VX_REMOTE_CACHE_SIGNATURE_KEY`. When set:
   - On PUT: compute `HMAC-SHA256(key, taskId || hash || artifactBytes)`,
     send as `x-artifact-tag`.
   - On GET: read response's `x-artifact-tag`, verify against
     same construction. Reject mismatch (treat as miss, log warning).
2. We include `taskId` instead of Turbo's `team_id` because we don't
   have teams — but the principle is the same: bind the signature to
   metadata an attacker can't trivially fake while keeping the same
   artifact bytes.
3. `Bun.CryptoHasher('sha256')` (still available, not removed by the
   xxh3 swap) handles the HMAC computation. Bun also exposes `crypto.subtle`
   for a more standard path.

Defer until a user actually runs into shared-cache use. Document the
threat model in `docs/caching.md` so the contract is explicit.

---

### 5. No machine-ID gate on cache restore — LOW, only matters for shared local cache

**The gap.** If a user mounts `<cacheDir>` across machines (NFS,
shared CI artifact volume) or copies it between hosts, restoring
artifacts built on a different OS / arch produces silently wrong
output — e.g., Linux x86_64 `node_modules/.bin/esbuild` restored on
a macOS arm64 dev box.

**Comparable patterns.**

- Nx stores a hashed machine ID in each cache entry's `source` file
  (`packages/nx/src/utils/machine-id-cache.ts:62-82`,
  `packages/nx/src/tasks-runner/cache.ts:623-646`). On restore, if
  the ID mismatches and `NX_REJECT_UNKNOWN_LOCAL_CACHE != '0'`, it
  throws.
- Per-platform GUID source:
  - macOS: `ioreg -rd1 -c IOPlatformExpertDevice`
  - Linux: `/var/lib/dbus/machine-id` / `/etc/machine-id`
  - Windows: `HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Cryptography:MachineGuid`
  - Hashed via SHA-256, cached in-memory.

**Fix sketch.** Same shape:

1. Add `machine_id TEXT` to `entries` rows.
2. On `save()`: compute once per process (memoize), write to row.
3. On `get()`: compare. On mismatch, treat as miss unless
   `VX_ALLOW_CROSS_MACHINE_CACHE=1`.

Defer until shared-cache scenarios appear. Document the
known-broken pattern in `docs/caching.md` ("don't share `<cacheDir>`
across machines").

---

### 6. No retry on transient FS failures — LOW–MEDIUM, ~30 LOC

**The gap.** Cache reads/writes on flaky / networked storage can
fail with ENOENT, EACCES, EBUSY for transient reasons (NFS retries,
parallel writers on shared mounts, antivirus scanners on Windows).
Today a single transient failure kills the run.

**Comparable patterns.**

- Nx's `tryAndRetry()` (`packages/nx/src/tasks-runner/cache.ts:660-682`)
  wraps FS ops in exponential backoff:
  - `baseTimeout = 15ms`
  - `baseExponent = Math.random() * 2 + 2` (jitter 2–4)
  - Up to 6 attempts. Cap ~20s total.

**Fix sketch.** Add a `withRetry(fn, opts?)` helper in
`src/util/retry.ts`. Wrap `cache.save()`'s file ops + `cache.get()`'s
tar read in it. Don't wrap SQLite (already has `busy_timeout`
handling at the driver level). Don't wrap remote HTTP — that has
its own timeout / error semantics; conflating would mask real
network errors.

---

## Already covered (not gaps)

- **Per-file restore-skip** — PR #95 (manifest in `output_files`
  table, `isOutputsCurrent` does the stat-compare).
- **Bulk DB metadata fetch** — PR #92 (`Cache.getMetaBatch`).
- **Reverse-dependency scheduling** — PR #91.
- **Single-decompress slot on cache hits** — PR #88.
- **Worker-slot allocation stability** — already in scheduler.

## Won't ship

- **Per-task `.env` file support / per-task env hashing** — we don't
  support `.env` files today; if/when we add them, the per-task
  hashing pattern from Nx (`hash-task.ts:64-89`) is the right shape
  but irrelevant until then.
- **Git HEAD SHA / dirty-hash in artifact metadata** — Turbo captures
  these on a background thread for debugging / provenance. Useful for
  `vx stats`-style introspection but pure overhead until there's a
  consumer.
- **Tar TTY / pseudo-TTY mode selection** — Nx switches between piped
  and pty modes depending on TUI presence. We dropped the TUI (PR
  #82); piped is fine.
- **Flake detection from history table** — Nx ranks task scheduling
  partly by historical flakiness. We have the `runs` table populated
  (PR #20) but no consumer yet. Defer until there's a use case.

## Recommended ship order

| #   | Fix                                      | Effort  | Severity         | Schema bump                   |
| --- | ---------------------------------------- | ------- | ---------------- | ----------------------------- |
| 1   | SIGINT / SIGTERM handler in `run()`      | ~30 LOC | High             | No                            |
| 2   | Path-traversal guard in `extractOutputs` | ~5 LOC  | Defense-in-depth | No                            |
| 3   | Content verification on restore          | ~20 LOC | Medium           | Yes (`entries.artifact_hash`) |
| 4   | FS retry with exponential backoff        | ~30 LOC | Low-Med          | No                            |
| 5   | HMAC on remote cache (gated by env)      | ~50 LOC | Defer            | No                            |
| 6   | Machine-ID gate (gated by env)           | ~30 LOC | Defer            | Yes (`entries.machine_id`)    |

Items 1–4 are small focused PRs that compose. Items 5–6 are
opt-in features that should land only when there's a user driving
the requirement.

## Sources

- Turbo HMAC: `crates/turborepo-cache/src/signature_authentication.rs:1-80`
- Turbo symlink safety: `crates/turborepo-cache/src/cache_archive/restore_symlink.rs:53-189`
- Nx machine-ID cache: `packages/nx/src/utils/machine-id-cache.ts:62-82`
- Nx machine-ID gate on restore: `packages/nx/src/tasks-runner/cache.ts:623-646`
- Nx retry loop: `packages/nx/src/tasks-runner/cache.ts:660-682`
- Nx signal handling: `packages/nx/src/tasks-runner/forked-process-task-runner.ts:411-444`
- Our SIGINT-missing site: `src/orchestrator.ts:run()` (no handlers); compare to `src/cli/watch.ts:204-208`
- Our path-traversal site: `src/cache/tar.ts:174` (path.join without guard)
