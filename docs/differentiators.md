# Why vx is fast — and what it does that others don't

The condensed story of every structural advantage, with measured
numbers. Mechanics live in [`optimizations.md`](./optimizations.md);
history in CLAUDE.md's decision log; raw numbers in
[`benchmarks.md`](./benchmarks.md).

## Headline numbers (same machine, same workspaces)

- 100-project comparison repo, warm: **vx 144 ms · Turbo 279 ms ·
  Nx 583+ ms** (wall-clock, direct binaries). vx's restore costs the
  same as an intact tree.
- 1090-package / 100-layer stress repo, fully cached: **10.2 s →
  0.62 s** across the June 2026 scaling pass.
- 500 projects × 30 files, warm run-phase: **245 ms → 76 ms (3.2×)**
  after git-OID hashing.

## Differentiators — things Turbo and Nx do not have

1. **Early cutoff (v21).** Downstream cache keys fold the upstream's
   _output content identity_, not its task hash. A comment edit that
   re-runs a library but reproduces byte-identical `dist/` re-runs
   nothing downstream. Turbo/Nx cascade the miss through the whole
   graph. Safety: tasks without declared outputs fall back to
   task-hash cascade; mtimes are excluded so rebuilds count as
   identical.
2. **Resolved-config hashing.** The cache key sees the
   post-evaluation `vx.config.ts` object — imports and computed
   values participate. Turbo/Nx hash the static config file and miss
   them.
3. **Strict output ownership.** Declared outputs are wiped before
   exec AND restore, so the tree ends bit-identical to the cached
   snapshot. Turbo/Nx restore additively; stale files survive.
4. **Sparse `^task` bridging.** `^build` walks through dep packages
   that don't declare the task to the nearest holders (Turbo/Nx stop
   at direct deps). Since v19 this is a frontier walk — Turbo-grade
   edge counts with the bridging kept.
5. **Restore-exact gitignore semantics with zero re-spawns.** After a
   restore, downstream tasks re-enumerate via git only when their
   input globs can actually see a changed path (920 ms → 136 ms on
   the repo that reported it; 81 git spawns → 1).
6. **Hard-fail artifact signing.** Turbo-wire-compatible HMAC
   (`x-artifact-tag`), but a configured key REJECTS unsigned
   responses — header-stripping can't bypass it. Tampered artifacts
   degrade to re-execution, never fail the run.
7. **A committed graph lockfile.** `vx lock` freezes the
   fully-resolved task graph (env values included) into
   `vx-lock.json`; CI audits it with a full re-evaluation
   (`vx lock --check`) and executes exactly it (`--frozen`) with
   zero config evaluation. Local runs always evaluate live. Turbo
   and Nx have no equivalent — their static-JSON configs dodge the
   problem by being less expressive; vx keeps code-as-config AND
   reproducibility.
8. **Daemonless by design** — and still faster cold than Nx's daemon
   warm. No background process, no staleness window, no socket state.

## Perf tricks under the hood

- **Hashes come from git's index (v20, Turbo technique, extended).**
  `git ls-files -s` yields every clean file's blob OID in the same
  spawn that enumerates files; `git status` (run CONCURRENTLY)
  prunes divergent paths; dirty files get byte-identical blob OIDs
  in-process so a key never flips across commit boundaries — a
  spurious-miss class Turbo accepts. Clean-tree hashing costs zero
  reads, zero stats, zero DB lookups.
- **Bitset graph algorithms everywhere a closure is needed**
  (scheduler priority, package graph): exact counts via popcount,
  O(E·N/32), replacing Set-union DFS that cost 8.5 s at 3270 tasks.
- **One bulk git enumeration per run**, partitioned per project by
  binary search over the sorted file list.
- **Stat-check restore skip**: warm-warm restores are N stats, zero
  writes, zero decompress (`output_files` fingerprints in SQLite).
- **v17 single-format artifacts**: local and remote transport
  identical tar.zst bytes; metadata rides SQLite/HTTP headers — no
  repack anywhere.
- **xxh3 key derivation, seed-chained**, `\0`-delimited part
  boundaries (collision-hardened in v18).
- **In-process tar** (15-400× faster than Bun.Archive at our sizes),
  atomic tmp+rename publish, single-transaction batch SQL.
- **O(N+E) scheduler tick** with an exact most-blocked-first
  priority queue.

## Deliberately rejected (with receipts)

- **Config-eval cache / project-graph cache**: configs are programs;
  soundness needs a correctness-critical purity heuristic for
  ~200 ms at 1000 projects. Re-evaluate only with a sound dependency
  story (see benchmarks.md headroom).
- **fspy-style auto-input tracing**: a ~9-crate native systems
  project per vite-task's implementation (seccomp_unotify, Detours,
  shipped shell for macOS SIP). Incompatible with no-build-step
  distribution (see comparison.md §3).
- **Cross-task artifact sharing / CAS dedup**: storage-only win;
  identical outputs are rare in real builds (path embedding). Early
  cutoff captures the speed-relevant version of the idea.
- **Nx-style daemon**: the cold-start numbers say we don't need one.
