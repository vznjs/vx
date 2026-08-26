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

1. **Resolved-config hashing.** The cache key sees the
   post-evaluation `vx.config.ts` object — imports, presets, and
   computed values participate. Turbo/Nx hash the static config file
   and miss them.
2. **Strict output ownership.** Declared outputs are wiped before exec
   AND before restore, so the tree ends every run bit-identical to the
   cached snapshot — no stale stragglers from a prior build or a hand
   edit. Turbo/Nx restore additively; removed files survive.
3. **Sparse `^task` bridging.** `^build` walks through dep packages
   that don't declare the task to the nearest holders (Turbo/Nx stop
   at direct deps). Since v19 this is a frontier walk — Turbo-grade
   edge counts with the bridging kept.
4. **Restore-exact gitignore semantics with zero re-spawns.** After a
   restore, downstream tasks re-enumerate via git only when their
   input globs can actually see a changed path (920 ms → 136 ms on
   the repo that reported it; 81 git spawns → 1).
5. **Always-on artifact integrity — no key management.** Content
   addressing does the work a signature would: every blob is fetched
   BY its digest, and `@vzn/vx-reapi` re-hashes what came back with
   the negotiated digest function before it is written into the local
   store. A corrupt store or a truncating transport degrades to a
   MISS — never a restored artifact — and there is no shared secret to
   distribute or rotate, which is the cost Turbo's HMAC signing pays
   on every machine. It is the same check Bazel's own client
   performs.
6. **A committed config lockfile.** `vx lock` freezes every project's
   **resolved config** (post-evaluation objects — computed values and
   config-time env reads included) into `vx-lock.json`; CI audits it
   with a full re-evaluation (`vx lock --check`) and loads exactly it
   (`--frozen`) with zero config evaluation. The graph is still built
   per run, and live-resolved inputs (`inputs.env` values, `runtime`
   command output) stay live under `--frozen`. Local runs always
   evaluate live. Turbo and Nx have no equivalent — their static-JSON
   configs dodge the problem by being less expressive; vx keeps
   code-as-config AND reproducibility.
7. **Daemonless by design.** No background process, no staleness window,
   no socket state — and the fastest warm/cached runs in the committed
   head-to-head benchmark (`bench/compare.ts`).
8. **Runtime inputs.** `cache.inputs.runtime` / `workspaceRuntime`
   fold a probe command's live output into the key (tool versions, OS
   info) — deduped per run, correct under `--frozen`. Nx has a
   `runtime` input; Turbo has none (vercel/turborepo#4124).
9. **Restore-ahead two-tier scheduling.** A stable-key warm hit is
   knowable up front, so it restores immediately — before its deps
   finish running — as low-priority worker backfill (misses own the
   pool). Measured −6.6% on mixed workloads, parity on all-warm.
   Remote runs get the same idea as **async prefetch**: stable-key
   remote GETs fire in the background and overlap execution, at most
   one per key; uploads are backgrounded too and drained at run end.
10. **A versioned telemetry contract + run-level plugins.**
    `TelemetryRecord` / `RunSummaryRecord` is one neutral, versioned
    export shape every sink reads (OTel via `@vzn/vx-otel`, a self-hosted
    dashboard, custom sinks) — observe-only by construction,
    crash-isolated, and provably zero-overhead when no sink is active.

> **Note:** an earlier design folded the upstream's _output content
> identity_ into downstream keys ("early cutoff", v21). It was
> **reverted in v22** in favor of pure-input transitive hashing
> (`upstream.ts` folds the upstream's input key, like Turbo/Nx). An
> upstream that re-runs but emits identical output therefore still
> re-runs its dependents — `caching.md` is the authority.

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
  priority queue — now two-tier (exec queue + restore-backfill queue).
- **Pure-SQL cache hits**: metadata + stdout live in the `entries`
  row, so a hit never decompresses the artifact (118 ms → 5 ms on
  large-binary entries); `accessed_at` bumps batch into one UPDATE.
- **Remote latency off the critical path**: prefetch overlaps GETs
  with execution; uploads are fire-and-forget background tasks drained
  at run end; `--dry` / `--graph` probe remote existence without
  downloading.

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
  identical outputs are rare in real builds (path embedding).
- **Nx-style daemon**: the cold-start numbers say we don't need one.
