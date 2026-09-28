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
- **J-49** architecture.md and patterns.md against source (patterns
  held): vx-otel exports logs, vx-schedule-history fills `commands`
  (`vx history`), and `workspaceScripts()` (N-5) joins the plugin
  tables; N-5 also made `--from scripts` valid, so J-39's `vx init`
  line was corrected in turn.
- **J-50** docs against the 58 non-docs merges since 02:55: an even
  stamp widens the racy window by two seconds, `--affected` follows
  tsconfig `paths`, vx's sandbox hints count as no violation,
  `vx help <name>` refuses a non-verb, and `workspaceScripts()` joins
  the fingerprint and migrate lists.
- **J-51** quickstart and sandboxing guide walked on a fresh fixture:
  the quickstart held (pinned samples match real output); a linked
  package opens only to a command task, not a group task, and the
  refusal names the link path from the workspace root.
- **J-52** every documented flag of show, info, why, last, lock, cache
  and help run on a fixture: `vx why` needs a task, a changed-file row
  names the path from the workspace root, and `vx last --list` ids are
  13 characters at least.
- **J-53** module pages against source changed since 03:55: five
  stale claims on four pages (secret-mask signatures and
  `exec.env.secret`, `initSandbox` `deniedDomains`, the import scan's
  alias branch, the scheduler's plain fd-exhaustion report).
- **J-54** every documented `vx run` flag and mode run on a fixture
  (filters, `--affected`, cache axes, numbers, continue, retry,
  timeout, output modes, reports, `--`, signals, help): one row
  wrong — a persistent task exits the run 1 only when it exits
  non-zero after ready.
- **J-55** plugins guide walked as an author: `vx init --plugin` for
  all nine seams, the seven samples type-checked and run, every
  "What core refuses" row driven; one claim wrong — the runnable
  examples cover nine seams, not every seam.
- **J-56** comparison.md's claims about vx against source (compare.mdx
  held): vx-migrate's six sources, workspace env inputs rejected by
  design rather than a gap, and the bin is `vx-migrate` — core has no
  `migrate` verb.
- **J-57** the docs index (README.md) and internals/diagrams against
  source: the diagrams page held; the index claimed a page per source
  file (145 files, 96 pages — a slice lives with its module).
- **J-58** all eleven Mermaid blocks in the core docs parsed with
  mermaid 12 and checked against source: flow 1 did not render (a `;`
  in a label ended the statement); five labels named a call, field,
  variable or exit code that is no longer so.
- **J-59** every `vx watch`, `vx init` and `vx completions` mode run on
  fixtures: the missing-plugin hint names no install command, `--mjs`
  keeps a `package.json` import when a script reads `npm_package_*`,
  and `vx watch a b` already runs several tasks (modules/cli-watch).
- **J-60** execution.md walked on fixtures (env, PATH, signals, grace,
  timeouts, retries, persistent tasks): run ids are UUIDv7 not ULID
  (six pages), a sandboxed task also gets the sandbox's proxy, CA and
  `TMPDIR` values, and large output is capped in the cached replay.
- **J-61** benchmarks.md's reproduction claims against vx-bench (every
  script, flag, count and timing mark): one wrong — `run.ts` prints
  the median and every rep, so the table's best-of-5 is the min.
- **J-62** recent-merge claims against source: a shell exit 126/127
  and the `X_OK` probe (execution, execute-task), comparison §9's
  pre/post, `WatcherPool` lives in `watch-fs.ts`, flows §5 names
  `watch-judge.ts`, dependency-spec has no `raw`, and plugin-commands
  returns the one plugin declaring a verb (the load refuses two).
- **J-63** guides/sandboxing.md and schema.md's `exec.sandbox` walked
  on fixtures: a Linux `unixSockets` path list opens every socket,
  `strace` is what fails an undeclared read (not only names it), and
  `weakerWhenNested` holds only when every sandboxed task sets it.
- **J-64** the leads J-63 left, against SRT's source and real runs:
  `gitConfig` is inert (SRT reads it only from its init config),
  `localBinding` does nothing on Linux, and sandbox-runtime.md's SRT
  environment list lacked five proxy families it sets.
- **J-65** eight cache module pages against source: outputs are
  marked changed before the save (miss-save, deferred-outputs),
  `LayeredCache.close()` summarises failures before delegating, the
  run summary carries four more totals, and four test references
  named files or rows that do not exist.
- **J-66** eight orchestrator module pages against source: admission
  named test rows that do not exist, `outcomeWord` also returns
  `aborted`, and the sandbox port bridge also calls `killTree`.
- **J-67** eight workspace/graph module pages against source: the
  config-eval key seed folds vx's version, any non-inspecting handle
  prunes config rows, a `workspace:<range>` peer must be satisfied,
  and stable-keys' instability rules and one signature were wrong.
- **J-68** eight CLI/output module pages against source: a
  diff-selected empty plan exits 0, four test references named files
  without the rows, cli-doc-drift checks only that a flag is in
  `help.ts`, PB prints with no decimal, and `vx info`'s line has a
  colon.
- **J-70** security.md against source and a real run: the key and
  declared outputs are checked on arrival, not on a local read-back
  (an artifact copied over another restored as a hit), links and
  devices are skipped, declared outputs grant no sandbox write, the
  network allowlist is the run's union, and masking skips short
  values and path-named keys. api.md's wrong comments went to leads.
- **J-71** patterns.md and optimizations.md against source and a real
  run: a failed task's dependents are skipped, not aborted; Turbo's
  value is `dependencies-successful`; remote prediction calls `has()`,
  not an HTTP HEAD; the artifact sidecar also carries the key and exec
  usage; tar hardlinks are skipped, not rejected.
- **J-72** the last five pages (cli-cache, config-imports,
  util-bun-version, util-secret-mask, playground): `configImportOwners`
  is declared once, and bun-version.test.ts asserts `bunSupported`,
  not a flagged row. Every module page has now been walked.
- **J-73** docs against the 37 code commits merged 06:45–08:30Z:
  `.vx-sum` in every artifact entry list, `!` outputs (A-44), the
  sandbox's keyed walk (C-40), `DeferredOutputs.size` gone, the
  foreign-field hint, the root-project import exception (D-41, also
  cli.md), and vx-otel declining only with no endpoint.
- **J-74** guides/configure.md and guides/ci.md walked on a 4-package
  fixture: an `inputs.env` name alone reaches no vx-reapi worker,
  `exec.timeout` is in the key (the other timeout sources are not),
  and the CI sample's push trigger broke every new branch's first
  push (an all-zeros `before` is a bad object to `--affected`).
- **J-75** guides/migrate.md and guides/plugins.md walked on fixtures
  (Turbo walk, mapping table, an Nx snapshot, every plugin sample
  run): a `project`-stage refusal names the project's config file,
  not `vx.workspace`, and the cache sample's `put` swallowed a failed
  upload (fetch resolves on a 500). migrate.md matched.
- **J-76** docs against 17 code commits merged 08:25–09:20Z: a
  symlinked output whose target leaves the project is refused
  (schema.md), and `vx init` beside `turbo.json` or `nx.json` writes
  only a `vx.workspace.ts` declaring `turbo()` or `nx()` (quickstart).

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
- **A** `src/orchestrator/task-hash.ts:226-227` comment says a
  whole-second stamp covers any write "in its second"; since A-38 an
  even stamp covers two (found in J-50).
- **N/E** `src/util/verbs.ts:29-30`: the `vx migrate` pointer says
  vx-migrate maps "turbo.json or an Nx project graph"; it also maps
  moon, wireit, lage and fan-out scripts (found in J-50).
- **E/K** A quickstart user with a common tsconfig (`rootDir: "src"`,
  composite) gets `tsconfig.tsbuildinfo` at the package root, outside
  `dist/**`: vx wipes `dist` on a miss, `tsc -b` sees itself current and
  writes nothing, and the run saves an empty artifact with only a
  warning. No page claims otherwise; a first-run trap (found in J-51).
- **E** From J-52's runs: `help.ts:51` and `why.ts`'s header show
  `vx why [TASK | PKG#TASK]` though the task is required; `vx help why
extra` ignores the extra argument and exits 0 where every other verb
  refuses; `vx why app#build --run zzz` says "run zzz has no row for
  app#build" for an unknown run (`vx last zzz` says "no recorded run");
  `vx lock --help` prints a doubled blank line; the lock note says "1
  project has no vx.config; their tasks are never frozen".
- **L** Since L-14 `exec.env.secret` names are masked too, but comments
  still say only "secret-named": `src/util/secret-mask.ts:1` and `:40`,
  `orchestrator/hit-restore.ts:268`, `orchestrator/execute-task.ts:893`
  (found in J-53).
- **A** `tests/output-dirs-snapshot.test.ts` › "a cold build records its
  output directories by run end" failed once in a local gate on main
  (6e7cb615, shard 12, 2026-09-28 05:4x): `outputDirRows` read `[]`
  where `['dist']` was expected (line 57); the file passed 3 of 3 bare
  runs after. A write the row reads before it lands, under gate load.
- **E** From J-54's runs: `vx run --help` usage shows `[TASK | PKG#TASK]`
  without `...` though several tasks are accepted; `vx info --formt` /
  `vx lock --chek` say "unknown argument" where `vx run` says "unknown
  flag"; bare `--affected` with `refs/remotes/origin/HEAD` pointing at a
  deleted branch fails `git ref "origin/master" did not resolve` instead
  of the HEAD~1 fallback or the no-base hint.
- **N** `packages/vx-migrate/src/index.ts:33` says "the Turbo, Nx and
  moon project stages"; wireit and lage are exported below it (found in
  J-56).
- **A** `output-dirs-snapshot.test.ts` (the row logged in J-52's batch)
  failed again in a local gate at 06:30 on main, same line 57 `[]` for
  `['dist']`: two of the last four gates. Not load noise to wave off.
- **D/E** `src/workspace/project-loader.ts:216-219`: any unresolved
  `@vzn/vx*` import is told `bun add -d @vzn/vx`, naming core, not the
  missing package (`cannot find '@vzn/vx-otel'; … bun add -d @vzn/vx`;
  reproduced in J-59).
- **bench** `packages/vx-bench/compare.ts` ~650: a comment says the
  baseline floors "take one [minute]"; two passes over 2,180 one-second
  sleeps at `-P 10` take ~9 min, as benchmarks.md says (found in J-61).
- **N** Since the Yarn PnP change (035c3868) only `turbo()` runs
  `yarn run` under PnP (`turbo-map.ts:643`); `nx()` (`nx-map.ts:714`),
  lage, wireit and scripts still inline the script, and the vx-migrate
  README:54 says "same rules for `nx:run-script`". `turbo()` also reads
  `.yarnrc.yml` without claiming it as a fingerprint (found in J-62).
- **B** sandbox (security): on Linux a `unixSockets` path list, or a `localBinding` port list, opens EVERY AF_UNIX socket to the task (SRT's seccomp cannot filter by path), incl. `/var/run/docker.sock` or an ssh-agent socket. Docs now say so (J-63); consider refusing a path list on Linux, or warning.
- **B** sandbox (cache correctness): with no `strace` on PATH an undeclared read is denied but unreported, so the task passes and caches; `vx info` still says "available" and the run prints no warning. Surface it in `vx info` and the run.
- **B** sandbox: the "SANDBOX VIOLATIONS (N)" header counts hint lines, so it disagrees with the status count ("(2)" vs "1 sandbox violation"; "(1)" with no count for the `File exists` hint).
- **B** sandbox (product bug): `allow.gitConfig` is inert. vx passes `allowGitConfig` per call (`sandbox-binds.ts:185`), SRT reads it only from the init config (`getAllowGitConfig`). The unsafe row at `sandbox-runtime.unsafe.test.ts:3625` checks only that the field is set. Set it on the init config or drop the key. Docs say inert (J-64).
- **B** sandbox (security, moderate): SRT's mandatory deny of `.git/config` and `.git/hooks` searches 3 levels from the workspace root, so a nested repo at depth 4 inside a write grant (`p/work/.git/config`) was writable with `gitConfig: false`; a task could plant `core.fsmonitor` there.
- **C** `orchestrator/plugin-host.ts` `resolveCache` comment says "One layer is used as is"; one plugin layer that does not wrap the local handle is chained with the local store at the tail. `cache/layered-cache.ts` `doPullFromRemote` comment names an `x-artifact-duration` HTTP header the seam does not carry. (J-65)
- **B/C** `Cache.close()` prunes month-old run history and `config_evals`/`config_closures` rows on any non-inspecting handle, including a `--cache=local:` or `local:r` run that config-cache.md says neither reads nor writes the store (`cache/cache.ts:1880`). Misses only, no stale hit. (J-67)
- **B (cache correctness, security)** the `cache.inputs.runtime` probe (`cache/inputs.ts:386`) spawns a bare `sh` on a PATH led by the project's `node_modules/.bin`, so a dependency shipping a `sh` bin interprets the probe and its output enters the key. `util/which.ts` fixed this class for task commands; `executablePath('sh')` would close it. (J-69)
- **A** `util/errors.ts` `gitSpawnRefusal` comment still names "a watch judgement" (the watch judge swallows the failed spawn); `tests/framed-output.test.ts:430`'s title says "section headers render dim" while it asserts bold coloured labels. (J-69)
- **B** `tests/runner.test.ts:1213` "a timed-out command returns only once its group is gone" failed on macOS CI on docs-only #1660 (`durationMs` 143, wants ≥ 400). Likely the backgrounded child's `trap "" TERM` is not yet installed when the 100 ms timeout's TERM lands; wait on a marker the child writes after its trap before the timeout counts. (J-68)
- **B (cache correctness)** a local restore never compares the artifact's recorded key or its declared outputs: `writeArtifactAndIndex` checks `scanned.key !== hash` on arrival only (`cache/cache.ts:1416`), `extractArtifactStream` reads neither. A real run with artifact A copied over B restored A's bytes as a green local hit. Security.md now says "on arrival" (J-70).
- **A/C** `api.md` is generated from source doc comments, so these need source fixes then `VX_UPDATE_CONTRACT=1`: `VxPlugin` (`orchestrator/plugin.ts:31`) names a `src/plugins/` that does not exist, "no fallback outside the list" (the local floor), and a bare `{ name, setup }` plugin that `definePlugin` and the loader refuse; `splitTaskId` says a `#` in a task name is legal (`taskNameProblem` refuses it, item 1000); `CacheLayer` calls `Cache` "the local v10 implementation". (J-70)
- **Coordinator** CLAUDE.md's live invariants say `CACHE_VERSION` `vx-cache-v35`; `vx info` reports `vx-cache-v36`. (J-70)
- **L** security.md:87 says every CI action is SHA-pinned "held by a test"; on main only `attest-build-provenance` is held, the general law (`supply-chain.unsafe.test.ts`, L-18) sits on unmerged `ws-l/supply-chain`. True once that merges. (J-70)
- **B (blocking CI)** `tests/runner.test.ts` rows `:1213` and `:570` failed 3 of 4 macOS runs on docs-only #1660 and #1664 (`durationMs` 143–156 vs ≥ 400): the backgrounded child's `trap "" TERM` is likely not installed when the 100 ms timeout's TERM lands. Wait on a marker the child writes after its trap before the timeout counts. (J-68, J-69)
- **B/C** source comments `cache/layer.ts:553` and `orchestrator/plan.ts:7` say the remote prediction is an HTTP HEAD; core calls `has()`, whose cost the plugin decides (REAPI: `getActionResult` + `findMissingBlobs`). optimizations.md row 22 says both `AbortError` and `TimeoutError` are caught; `vx-migrate/src/remote-deadline.ts` names only `TimeoutError` (others still degrade to a miss). (J-71)
- **A** `util/bun-version.ts:35` documents `unsupportedBunMessage` as "the warning a CLI entry prints once, before the verb runs", and `tests/bun-version.test.ts:4` says "`bin.ts` warns now"; no source calls it (only `vx info`'s row reports the floor). De-claim or drop the export. (J-72)
- **G/N** vx-migrate's turbo, nx and wireit mappers still say "vx outputs have no negation" and run `!`-output tasks uncached (`turbo-map.ts:936,955`, `wireit-map.ts:235`), though core takes `!` since A-44: lit's 12 wireit tasks still run uncached. Over-running only. **K** the vx-migrate README (lines 53, 58, 109, 176, 278) repeats "no negation" and "no workspace-root tasks", false since A-44 and D-39. (J-73)
- **F** `reapi({ endpoint })` against a refused port made a 5-task `run build --all` take 17.5 s wall (summary said 6.45 s) and a `--dry` with `execute: true` 13 s: a down server is a miss, but every run pays over 10 s. (J-74)
- **E** `vx why` on a dependent that ran under `--continue=always` and was not saved says "re-executed on the same key (--no-cache / --force, or unrelated)", not the real cause. (J-74)
- **A/C** `tests/output-dirs.test.ts` › "does not descend a symlinked directory, records a missing prefix as absent, and nothing over the cap" timed out its hook (14.6 s) on Linux CI on history-only #1690.
- **G/N** `nx()` wrote `workspaceFiles: ['shared.json', 'shared.json']` when a file was both a `{workspaceRoot}` input and a `json` input (harmless duplicate). (J-75)
- **A** (unrun) d478d5de passes the project dir as `within` to `planArtifact`, so a symlinked `outputs.workspaceFiles` output whose target is inside the workspace but outside the project is likely refused "outside the project". (J-76)
- **E/N** (unrun) `adoptionNext` prints `yarn add -D @vzn/vx @vzn/vx-migrate` in a yarn repo; at a Yarn 1 workspace root that errors without `-W` (the pnpm branch passes `-w`). (J-76)
