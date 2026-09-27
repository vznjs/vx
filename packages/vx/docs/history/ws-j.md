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

- **J-3** `architecture.md`: contract table named nonexistent
  `CASBackend`/`Digest` and a `toPosix` export; matrix lacked
  `index → exec`; plugins "never change what a task is" (the `project`
  stage does); executor pinning, `prepareRun` order, a nonexistent
  env-var remote layer, telemetry gate, `shell: true` spawn and a
  post-exit second hash corrected.
- **J-4** `execution.md` against the run's code (19 claims, each re-read
  in source). The prepare steps follow `prepareRun` again (the local
  cache opens before configs load; an unscoped run starts git
  enumeration first). Exec and restore tiers are separate lanes
  (restore `2×concurrency`), not one worker cap. The save is deferred to
  a save lane, withheld by `keyStillTrue()`, and reuses the one input
  capture taken before the spawn. Plugin install and run-context
  capture always run; telemetry needs a `telemetry` hook or injected
  sinks. The short-circuit has no dep-edge gate; a persistent task that
  exits early carries no captured stderr; a failing runtime input fails
  only its task; `aborted` fails the run; a diff-scoped empty run is
  `ok: true`.
- **J-5** `caching.md`: the trust note said env/runtime values land
  verbatim in `cache.db`; `entry_inputs` stores their xxh3 digest. Also
  package.json folds its blob OID, the enumeration spawns, stat not
  lstat for the fingerprint check (item 760), the 8,192 output-dir cap,
  capture before spawn, the inputs warning on every miss, what a schema
  reset keeps, step cross-references, `runs_failed`, the `plugin` kind.

- **J-6** `flows.md`, `patterns.md`, `optimizations.md`: git
  enumeration moved to `git-inputs.ts` (`ls-files -s -v` + `status`);
  hit-restore checks inode/ctime and wipes outputs itself; no dep-edge
  short-circuit gate; skipped tasks are listed; foreground persistent
  tasks outlive the summary; patterns.md denied executor plugins.
- **J-7** Site guides: Nx `runtime` and Turbo `dotEnv` mappings,
  `deny`/`ignore` keys, the CI sample's missing `GITHUB_TOKEN`, what the
  lock holds, sandbox vs `cache.inputs`, `VX_RUN_*` env, the
  quickstart's second-run output, the npm launcher.

- **J-8** 38 `docs/modules/` pages: exports that do not exist
  (`attributedHitsLast24h`, `CacheEntry.stderr`, `localExecutor` on the
  façade), stale signatures, the pre-v14 cache layout, key fold order,
  bin.ts exit path, argv-ordered filters, prune ignoring `cacheDir`.
- **J-9** `cli.md`: the plugin-commands sample used a plain object the
  loader refuses; two quoted errors do not exist; UUIDv7 run ids;
  watch polling and `--report-file`; `GITHUB_STEP_SUMMARY`; completions.
- **J-10** Blog: three posts said to move an output-changing var from
  `passThrough` to `cache.inputs.env`, which drops it from the env (it
  goes in both); why-post verdict rows; exit code of a crashed server;
  `vx prune` was removed, not moved.

- **J-11** `parity.md` and `upstream-ledger.md`: ~30 ledger notes cut
  off mid-quote; four quotes the docs no longer say; one issue with two
  contradicting verdicts; two covered rows citing tests that do not test
  the claim; parity.md rejected `$TURBO_ROOT$` (it maps to
  `workspaceFiles`).

- **J-12** vx-reapi and vx-migrate READMEs said a remote hit is read
  first and to declare the plugin before the local cache;
  `LayeredCache` reads local first, and no local-cache entry exists in
  `plugins`.

- **J-13** Doc pins: the `vx why` verdict pin now takes every note
  `whyDidThisRerun` can print from metrics.ts (9, was a hand-counted 8
  that missed the no-key note), and the configure guide gains that row
  and drops "something unkeyed" (a stale hit, not this verdict). The
  ledger law accepts `open (limit: <page> § <heading>)` only when the
  heading exists; turborepo#12786's two rows move from `n/a` to that.

- **J-14** (from E's queue) `--filter` listed the workspace twice:
  `resolveFilters` discovered, then `prepareRun` did again. The filter
  pass's projects now reach the run (`RunOptions.discovered`, used when
  the root matches). 1,000 packages, `--filter '*'` warm: the run's
  `discover projects` stage 10 ms → 0; wall, 25 interleaved compiled
  rounds, main 305 (min 277), patch 318 (282), A/A 330 (293): the win is
  below this box's noise. Row: `load-reads.test.ts` counts one read of a
  member manifest across the filter pass and the run.
- **J-17** Adoption walk (Turbo and Nx repos, `turbo()`, `nx()`,
  `bunx @vzn/vx-migrate`): the migrate guide and both migration posts
  gave `vx run --graph` without a task or `--all`, said the Nx export
  reruns only on config edits (it keys on the worktree), mapped
  `dotEnv` to `cache.inputs.files` (it is a runtime probe) and said
  Turbo's default inputs were dropped (written as `**/*`). The
  quickstart told users to gitignore `.vx/`, which ignores itself.

- **J-15** First-run walk (npm install, `vx init`, run, why, watch, `--affected`): a
  SIGINT sent to the npm launcher killed the Node process and left the
  `vx` binary running under init. The launcher now spawns asynchronously,
  forwards SIGINT/SIGTERM/SIGHUP unless it is in the terminal's foreground
  group (a keyboard Ctrl-C already reached vx, and a second signal means
  "stop now"), and exits with the binary's code. Row in
  `npm-launcher.test.ts`, red without the fix.
- **J-16** Docs against ~190 merges: execution.md's restore lane
  (pooled tasks, concurrency 1), schema.md's runtime-probe pin, retries'
  summed duration and whitespace-only command, capacity and plugin-verb
  refusals, async hook isolation, the `Aborted:`/`Not started:` sections
  and `aborted[]`, telemetry's counted `--` arguments.

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
- **E** `vx completions` scrapes every `--word` from a verb's help cut: `watch` completes only the flags it refuses, `show`/`info` get `--run --list`, `lock` gets `--frozen` (cli/completions.ts:14-18).
- **E** A non-dry `vx cache prune` in a workspace that never ran creates `.vx/cache/` (cli/cache.ts:146); cli.md says none of why/last/info/prune creates anything.
- **A** `output_dirs` is not in the schema-reset DROP list (cache.ts:528-530); verify the FK cascade clears it.
- **J (test)** `tests/site-samples.unsafe.test.ts` pins the quickstart's second-run comment to `formatTaskHitLine`'s full-mode row; the default frame closes `up-to-date` (`outcomeWord`). Retarget needs an owner-approved test edit.
- **F** `vx-reapi/tests/wedged.test.ts:372` "RST_STREAM(CANCEL) reads as CANCELLED and is not retried" failed once in a full gate (after F-1's INTERNAL retry), 3/3 green alone. A race under load, not a flake to ignore.
- **B** `orchestrator/sandbox-request.ts:99` comment cites sandbox-manager.js 0.0.75; installed is 0.0.76 (check at line 238).
- **D** `config.ts` SandboxConfig comment says grant paths are prefixes, never globs; the schema accepts patterns (config-schema.ts:974-976) and the runtime expands them.
- **J (test)** `site-samples.unsafe.test.ts` verdict pin expects 8 sentences; its regex misses `this task recorded no cache key` (metrics.ts:500-501), the 9th.
- **J (test)** `upstream-ledger.unsafe.test.ts` accepts only covered / fixed-in-item-N / n/a; a documented limit vx shares (turborepo#12786) has no honest verdict. An `open (limit)` verdict needs a test change.
- **F** `vx-reapi/src/index.ts:95-96` doc comment says a remote hit is consulted first; `LayeredCache.get` reads local first. **G** `vx-migrate/tests/{nx,turbo}-cache.test.ts` describe blocks say the plugin is "declared before the local cache", which has no meaning (no local-cache entry in `plugins`).
- **K** vx-otel README "What it exports": the `vx.run` span carries
  `vx.command` (after `--`: `-- <N arguments>`). vx-github README: the
  summary footer shows that command. vx-mcp README Troubleshooting: an
  edited relative import of `vx.workspace.ts` makes later loads refuse
  (`… a running process cannot evaluate an imported module again —
restart it to apply the edit`).
- **A/B** `sandbox-runtime.unsafe.test.ts` "a traced sandboxed one-shot
  task's children die with vx that is descheduled after the spawn"
  failed once in a full local gate (3.5 s) on a launcher-only diff; it
  passed 2/2 alone. A timing row under load.
- **K** vx-migrate README, Turbo table: the `readyWhen` TODO appears only
  when a task depends on the persistent one.
