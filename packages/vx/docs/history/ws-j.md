# Stream J — docs accuracy (plan 2026-09-27): one entry per merged PR

## Entries

- **J-1** Root README against the code. `vx run --frozen` was said to
  refuse a config changed since locking; it checks no staleness by
  design (`workspace/lockfile.ts` `frozenProjectConfig`, pinned by
  `tests/lock.test.ts` "a changed config file … --frozen keeps the
  freeze until re-lock"; reproduced: an edited config ran its locked
  form, exit 0, while `vx lock --check` exited 1). The comparison
  table's "fully cached, 100 pkgs" row (144 / 279 / 583+ ms) had no
  source in `benchmarks.md`; it now quotes the 3,270-task warm row
  (510 ms / 760 ms / 3.59 s). The stage table gains the `fingerprint`,
  `admit` and `setup`/`teardown` hooks (13 in `VxPlugin`, as the
  maturity table says). "~3,000 core tests" was ~4,200 declarations.
  `@vzn/vx-migrate` was listed twice. `parity.md` named a flag that does
  not exist (`vx lock --frozen`).

- **J-2** `comparison.md` and the README's integrity bullet. Core does
  not content-verify a remote artifact: it refuses a zstd bomb, bytes
  that are not a vx archive, and an archive recording another key than
  the one fetched (`cache/cache.ts` ingest); only `@vzn/vx-reapi`
  re-hashes blobs, and `turboCache()` checks Turbo's HMAC only with a
  `signatureKey`. The page also named `@vzn/vx-nx-cache` (merged into
  `@vzn/vx-migrate` on 2026-09-11), called cache caps a plugin's option
  (core's `cacheRetention` since item 658), and said symlinked
  directories are followed where `cache/inputs.ts` scans with
  `followSymlinks: false` and folds a link's target string.

## Leads for other streams

- **C** `orchestrator/prepare.ts:242` says frozen configs load "after a
  content-hash tripwire"; there is none (`frozenProjectConfig` checks
  nothing, by design). The comment claims a guarantee the code lacks.
- **C** `orchestrator/plugin.ts:75` (`graph` hook doc) says a plugin may
  "adjust resources"; task resources went with the reservations on
  2026-09-12 and `TaskNode` carries none.
- **A** `cache/cache.ts:555` SQL comment says stdout lives in the
  artifact "not here", above an `entries.stdout` column that a local
  hit replays from.
- **A** `orchestrator/execute-task.ts:453-462` still describes a second
  `computeTaskHash` after exit 0; the capture is `describeTaskInputs`
  before the spawn.
- **E** `bin.ts` dynamically imports `./index.js` (a `bin → index` edge
  the matrix does not grant), and `tests/module-boundaries.test.ts`
  scans only static `from` specifiers, so the law cannot see it.
- **G** `vx-schedule-history/src/index.ts:37-39` says the reservation
  includes "the most CPU parallelism seen, rounded to a core"; its
  README says cores are never learned, only declared.
