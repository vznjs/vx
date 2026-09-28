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
- **J-19** cli.md against every verb's `--help` and the parser: all
  flags held; `vx upgrade`'s non-JSON release message and the stream of
  the undeclared-task line were wrong.
- **J-20** Hand-written site pages (guides, glossary, concepts, blog):
  13 wrong claims on 11 pages — `vx why`'s path is workspace-relative,
  otel's `OTEL_METRICS_EXPORTER=none`, Claude Code's `.mcp.json`,
  `strace` for naming a read, vx's own tar (not `Bun.Archive`), one
  transaction per save, inode and ctime in the fingerprint, the `graph`
  stage's powers, one runnable sink, `pnpm()` folding patches per
  package, and what `test.bun.unsafe` holds.
- **J-23** architecture.md and execution.md against the source: the
  `bin → index` edge (matrix, diagram) and the boundary test's
  `import('…')` scan, the restore lane (own lane, shared slot only at
  concurrency 1), run context reads `.git` itself, a repeat config
  evaluation runs in a worker, `runs.attempts` counts attempts, a
  signal-stopped run records no history, the prefetch gate is any
  remote layer, and the batch loader's name.
- **J-18** Module pages against the source (97 pages, 39 fixed): stale
  signatures and fields (`Cache`, `ExecuteArgs`, `TaskExecutor.demand`,
  `TaskNode`, sandbox types), wrong behaviour (`--affected` diffs from
  the merge base, `gha` in any mode, `maxRSS` units, `EDQUOT`, the
  status region's rows) and exports each page's own list omitted.
- **J-21** caching.md and flows.md against the source: the status
  spawn's `--ignored=matching`, the local short-circuit's up-front keys,
  `file_hashes_swept_at`, the rename inside the save transaction, prune
  unlinking before its DELETE and keeping phantoms under an hour,
  `cli/plan-format.ts`, and `has()` in place of HEAD.
- **J-22** schema.md against the source: `exec.command` runs as
  `sh -c`, `--` args are shell-quoted (bare when safe, else single
  quotes; not `JSON.stringify`), `!` negation subtracts in any order, and
  the always-ignored set also holds `**/vx-lock.json` and `**/*.bun-build`.
- **J-24** comparison.md and patterns.md against the source: filters
  start from the empty set unless all exclude (not a divergence), the
  artifact also holds `workspace-outputs/` and `.vx-meta.json`, `vx init`
  folds pre/post scripts, `cacheRetention` is a workspace field,
  `@vzn/vx-lockfile` has four lockfiles, a dead CLAUDE.md "P1" pointer,
  and the run-history tables live in `cache/schema.ts`.
- **J-25** Site internals and benchmarks.md prose against the code: only
  the landing draws with `Diagram` (imported pages still use Mermaid),
  `update-site.ts` has no n8n panel (it rewrites the landing rows, the
  README chart and the stress section), and "directory symlinks are
  STATUS Next" named no item (the save refuses one by name).
- **J-27** Docs against 21 merges from other streams: the salted value
  digest (`value_salt`), the flag hint's home (`flagHint`), the per-task
  unix-socket lift, the remote-body bound, plugin executors' timeout
  and abandon, re-validation after each config hook, `vx why`'s
  `what to do:` block, the `--run` and empty-picker hints, an uncached
  task folded as a reader, and output-nesting in the stability gate.
- **J-29** First-run walk on a pnpm monorepo (quickstart, configure,
  ci): npm refuses `workspace:*` (`pnpm add -D`), `vx init` also writes
  `vx.workspace.ts` and caches nothing until a `cache` block is added,
  a local install needs `npx vx`, the second run is `up-to-date` unless
  `dist/` is gone, a config runs without `@vzn/vx` installed (only the
  editor needs it), and the CI sample lacked `setup-bun`.
- **J-28** The site's plugins guide against each plugin's source: otel's
  `timeoutMs` reads `OTEL_EXPORTER_OTLP_TIMEOUT`, and `turbo()` / `nx()`
  also fill `fingerprint` (claiming `turbo.json` or `nx.json`).
- **J-30** Plugin CLIs run from source (`vx mcp` over stdio, the
  `vx-migrate` bin) against the docs: two of `vx mcp`'s four database
  tools read the cache, not run history; a verb's `run` may return a
  promise; and the plugins guide's verb sample opened the cache in a
  mode that can reset an old index (`Cache.inspect` now).
- **J-31** upstream-ledger.md notes against the code (no verdict
  changed): the task env also carries bin `PATH` and `VX_RUN_*`, a
  reverted edit is caught (item 1015), a shared `cacheDir` does serve a
  second checkout, the fingerprint holds `.npmrc` and `bunfig.toml`, a
  `passThrough` wildcard is refused, `VX_RUN_WORKSPACE` holds a path,
  a catalog edit re-keys every project; the intro drops the unused
  "untested" verdict.
- **J-32** The site's compare and playground pages against the code:
  one wrong claim, that the sandbox checks declared inputs (it checks
  reads against `exec.sandbox.allow.read`, kept apart from
  `cache.inputs`).
- **J-33** Sandboxing guide and schema.md's `exec.sandbox` run on Linux:
  network is per run (a task that declares none reaches every domain
  another task of the run lists; reproduced: alone `000`, beside a
  `network: ['registry.npmjs.org']` task `200`), `network: true` adds
  no domain, `deny.network` refuses nothing, and a linked package is
  readable by its real path.
- **J-34** J-33's class, grepped: sandbox-runtime.md and
  sandbox-request.md said a no-network task is never handed the proxy
  and `network: true` skips it; the sandbox post said the baseline has
  no network; the sandboxing guide promised only declared network
  exists and showed `deny.network` without saying it refuses nothing.
- **J-35** Blog posts, glossary and concepts against the last ten hours
  of merges: the wipe also spares `node_modules` unless a glob names it
  (A-13), the sandbox refuses only domains no task of the run lists
  (J-33), a sandboxed task on Linux records no CPU or RSS (B-3), and the
  `vx why` sample lacked its `what to do:` block (E-28).
- **J-36** Every exit code and quoted refusal in cli.md, run from
  source: all held but one. `--affected` with a diff that touches no
  project stops before the task-name check (`nothing affected since
<ref>` on stderr, exit 0, a typo unseen); the doc said a typo is
  always refused. Same gap as J-19's selection lead.
- **J-37** Every config example in schema.md and the configure guide,
  run from source: two schema.md examples no longer loaded (the full
  example's `inputs.tasks: ['^build']` without `^build` in `dependsOn`;
  the `NODE_OPTIONS` snippet without `cache.outputs`). All else held.
- **J-38** caching.md's local-layer claims run from source: all held
  but one; only `vx run` says `cannot create cache directory`, while
  the readers and `vx cache prune` find no cache and go on.
- **J-39** docs caught up to recent merges: moon/wireit/lage in the
  plugin tables and `vx migrate`, `--plugin` in the init synopsis,
  current duration/size and non-TTY messages, the removed `stats`
  alias; `vx init` no longer cites `vx-migrate --from scripts`, which
  vx-migrate rejects.
- **J-40** parity.md and optimizations.md run against source: two
  stale claims — `Bun.color` sees a handful of hex strings, not four;
  sandboxing is not under comparison's "Where vx is ahead".
- **J-41** glossary and "why vx is fast" run against source: the
  glossary held; an additive task cleans nothing before exec (only its
  rows before a restore; also in configure), and `git status`, not
  `ls-files`, lists untracked files.
- **J-42** comparison.md's CRLF bullet said a converting Windows
  checkout could diverge; a filtered file now drops its index OID and
  is hashed from worktree bytes (`dropFilteredOids`).
- **J-43** module pages for the sixteen most-changed source files of
  the last twelve hours: ten stale claims on six pages (scheduler,
  execute-task, affected, inputs, metrics, cli-watch).
- **J-44** migrate and CI guides run against source: all held but the
  CI sample, whose lone `checks: write` dropped `contents: read`
  (a private checkout fails), and the migrate guide's source list,
  which missed wireit and lage.
- **J-45** configure guide and internals index run against source and
  a fixture: `cacheRetention` evicts after every run, a `--no-cache`
  one included (probe: 2 entries evicted; also schema, comparison);
  outputs are wiped only by a run that writes the cache.
- **J-46** flows.md and execution.md against the last twelve hours of
  runtime changes: an outside stop is `failed` not `aborted` (also
  cli.md), `deny.network` is enforced run-wide since B-21 (sandboxing
  guide, schema.md), and the watch loop's owners span four files.
- **J-47** the rest of caching.md against source (constants held):
  nested projects drop by ancestor lookup, `prune --dry-run` previews
  an earlier-schema reset, and an empty directory can block a restore.
- **J-48** schema.md's field prose against source (error tables
  probed): masking skips `_FILE`/`_PATH`/`_DIR` and
  `GIT_CONFIG_KEY_<n>`; a write grant exposing `.git`, `.vx` or a
  nested project is refused (probed); the baseline writes its own
  `TMPDIR`; a denied read is reported only where strace attaches.

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
- **selection** `vx run nope --affected=HEAD~1` where the only affected
  project has no vx config prints `No affected project declares
task(s): nope.` and exits 0; cli.md says an undeclared name is
  refused (it is, exit 1, once a configured project is affected).
- **CLI** `vx init --help` shows `--mjs` in its usage but no row for it.
- **sandbox** CI `@vzn/vx-docs#build` finished (`Complete!`) then died 137 on `strace: ptrace(PTRACE_LISTEN…): Input/output error` (PR #1310, 2026-09-28): item 925's fault reaches the docs build too.
- **K** `packages/vx-mcp/README.md:60` says the server is "about 200 lines"; `src/server.ts` is 231 (the site says 210).
- **E** `vx init --mjs --dry` lists `would replace:` for existing `.ts` configs, but `vx init --mjs` without `--force` refuses and exits 1.
- **E** `vx cache prune` rejects `--dry` (takes `--dry-run`) while `vx run` and `vx init` take `--dry`.
- **K** `packages/vx-mcp/README.md:26` points Claude Code at `~/.claude/mcp.json`; it reads `.mcp.json` (or `claude mcp add`).
- **E** `vx mcp --help` and `vx history --help` refuse the flag (exit 1), yet `vx completions` offers `--help` for every plugin verb.
- **H** `getRunHistory`'s `successRate` counts only `status = 'success'` (`orchestrator/history.ts:111`), so a cache hit is a non-success; `failure-mode.ts` counts a hit as a pass.
- **H** `packages/vx-migrate/src/turbo/index.ts` header names `vx migrate --from turbo`, a verb that no longer exists.
- **J (ledger)** nx#35524 (n/a) and turborepo#9651 (n/a) may need other verdicts: vx re-keys every project on a catalog edit, and `turbo()`/`nx()` now fold pre/post hooks. Needs the upstream issue text, unread here.
- **B (security)** Sandbox network is per run: a task with no `network` reaches every domain any task of the run allows; `network: true` opens nothing past the union; `deny.network` is never enforced (`initSandbox` passes `deniedDomains: []`). The comments in `exec/sandbox-runtime.ts` `initSandbox` and `exec/sandbox-binds.ts` `buildCustomConfig` claim otherwise.
- **B (security)** The wrapped `sh -c "exec bwrap …"` resolves `bwrap` (and SRT's in-sandbox `socat`) on the TASK's PATH, so a dependency's `node_modules/.bin/bwrap` or `socat` replaces the sandbox tool; the comment near `runSandboxed` says vx's own PATH.
- **B** A root project with `read: ['.']` that exits non-zero with no violation gets the false "grants no read access to the task's own working directory" hint: `wallOff` punches `.git`/`.vx` out of `'.'`, so `readableUnder` misses the cwd (`sandbox-runtime.ts` ~1378).
- **B** vx's own hints (untouched placeholder, withheld link) are counted as sandbox violations in the "(N sandbox violation)" line.
- **B** On a host without IPv6, SRT's in-sandbox `socat TCP-LISTEN:3128` fails and its error goes to /dev/null: every networked task sees only "connection refused on localhost:3128".
- **M (via coordinator)** `sandbox-runtime.unsafe.test.ts` › "a SIGKILLed task's port bridge leaves no socket behind" fails with `ENOENT: no such file or directory, scandir '/tmp/claude/vx-tasks/vx-task-<pid>-x'` (`tests/sandbox-runtime.unsafe.test.ts:4030`): on CI for PR #1412 (history only) and in a local gate on main 2026-09-28 01:50. The row (B-15, 53144ba) read the bridge socket's dir after L-10 (18bfb32) moved per-task temp dirs; fixed by 34a6c14.
- **A** A corrupt LOCAL artifact fails its task every run (`internal error in app#build: CorruptArtifactError: … zstd decode failed`, `failed miss`) until `--force`, with no hint; a corrupt remote one degrades to a miss (nx#30338's shape, local side).
- **E/B** `src/orchestrator/shell-verdict.ts:82-83` says a SIGINT/SIGTERM
  the runner saw reverts the task to aborted; since c23d176 an outside
  stop is failed unless the run is stopping. A comment claiming what
  the code no longer does (found in J-43).
- **A** `src/config.ts:17` JSDoc says `cacheRetention` evicts after
  "every run that writes to it"; `evictIfDue` ignores the write axis
  and a `--no-cache` run evicts (found in J-45).
- **D** `tests/config-eval.test.ts` › "rejects a wedged worker … then
  recovers" failed on macOS CI (PR #1503, shard 4): the recovery eval
  got `config worker did not answer within 250ms` (line 500). The row
  keeps the 250 ms budget for the fresh worker's first answer, which a
  loaded runner's spawn can miss (D-17, c503448).
- **E** `vx why`'s note "this task recorded no cache key (skipped, or a
  persistent task)" (`orchestrator/metrics.ts` ~464, ~609) predates
  6a3c035, which gives a persistent task a key; the configure guide
  and a blog post quote it (found in J-46).
- **C (Windows)** Pages still say tasks run through `sh -c` everywhere
  or that Windows is unsupported, while 9b2b889 runs tasks through
  `bun exec` on win32: comparison.md ~199 and ~384, optimizations.md
  ~70, site quickstart ~8/~89, sandboxing ~70. Left for the Windows
  stream to settle once the port lands (found in J-46).
- **A** `tests/caching-doc-drift.test.ts:64` pins caching.md's
  `-- src/cache/cache.ts schema (SCHEMA_VERSION = 'v28')`; the DDL
  moved to `src/cache/schema.ts` in A-21 (34fb1a3). Retarget the pin
  and the line together (found in J-47).
- **B/C** `src/config.ts` doc comments (they generate `docs/api.md`)
  are stale: `SandboxConfig` "writes nothing" (it writes its TMPDIR);
  `SandboxGrants.network` "`true` allows all" / "omitted means no
  network" (the allowlist is one union per run); `WorkspaceConfig.timeout`
  precedence omits `--timeout`; `concurrency` "number of CPUs" ignores
  the cgroup cap; `dependsOn` `'^name'` "every transitive" (it is the
  nearest holders). Found in J-48.
