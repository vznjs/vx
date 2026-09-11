# Shipped, 2026-09 — improvement-loop items 65–104

The record `docs/STATUS.md` carried until 2026-09-11, moved here whole
so the handoff stays readable. Nothing below is current state: STATUS
holds direction, what is in flight and what is next; this file holds
what shipped and the numbers behind it. Items 1–64 are in
`2026-09-review-arc.md`; items 105 onward continue in STATUS under the
same numbering.

65. DONE (core ships no plugin — the last built-in externalized, the
    owner's directive after #265 merged): `src/plugins/schedule-history`
    was core's one bundled plugin, a subpath export
    (`@vzn/vx/plugins/schedule-history`) with a root shim for the
    compiled binary, its own boundary rule (Rule 4: a plugin imports
    core only via `'@vzn/vx'`) and a `plugins` module in the boundary
    matrix. It is `@vzn/vx-schedule-history` now
    (`packages/vx-schedule-history`, laid out like the other plugin
    packages: manifest with `@vzn/vx` as a peer, root shim, the unit
    pins and the end-to-end critical-path pin moved with it, its own
    CI step). Core lost the directory, the shim, the exports subpath,
    the `plugins` files entry and the `plugins` module; the two
    boundary suites now pin the ABSENCE of `src/plugins` so a new
    plugin starts life as a package, and the shim suite pins the new
    package's shim. What core keeps is what a plugin needs from the
    façade (`LocalHistoryProvider`, the history types); nothing else
    moved. `docs/modules/plugins.md` now says what it should have
    said: the floor is not a plugin, every plugin is a package, and
    `architecture.md` no longer claims "a workspace that declares none
    fails" — it runs and caches. Zero warm-path effect by construction
    (a run never loaded the plugin unless declared); the core package
    is one directory and one export smaller.

66. DONE (adoption tooling leaves core — the owner's directive: core
    slim and fast, everything else a package built around it): `vx
migrate` was 1,475 lines of core that knew Turbo's and Nx's file
    formats (`cli/migrate*.ts`, `workspace/turbo.ts`). Three moves:
    (a) the Turbo mapper is `@vzn/vx-turbo`'s (it runs the mapping
    live; `mapTurboWorkspace` and its types are exported from there,
    and the façade no longer carries them); (b) the Turbo and Nx
    migrations are `@vzn/vx-migrate` — `bunx @vzn/vx-migrate` with its
    own bin, so it runs before any vx file exists, which a `commands`
    plugin verb could not (a plugin verb needs a workspace file that
    declares it); it depends on `@vzn/vx-turbo` for the mapping and on
    core for everything else; (c) what stays in core is the SEAM
    every adoption tool shares — `workspace/migration.ts`:
    `MigrationPlan`, the TypeScript emission, the overwrite guard, the
    writes, the report, exported from the façade as `applyMigration`
    with `quoteTsLiteral` and the persistent-name rule — and `vx init`
    (package.json scripts, `workspace/migrate-scripts.ts`), core's own
    mapper over it, now a 90-line verb (`cli/init.ts`). `vx migrate`
    prints the pointer and exits 1 (pinned), `vx init` names the
    package when a `turbo.json` or an Nx workspace sits beside the
    scripts unread. The suites split the same way: `tests/init.test.ts`
    keeps the scripts, empty-workspace, guard and pointer pins;
    `packages/vx-migrate/tests` holds the Turbo and Nx end-to-end pins
    through the package's own bin. Design note:
    `docs/design/adoption-tooling-2026-09.md`. Core after: no other
    runner's format anywhere in `src/`; the façade gained the seam
    and lost the mapper.

67. DONE (`vx prune` is `@vzn/vx-prune`): the Docker workspace-subset
    verb — 290 lines of copying, manifest rewriting and config scanning
    that no run ever needed — left core as a package with two ways in
    and one body: `bunx @vzn/vx-prune <project>` (its own bin, no
    workspace file needed) and the `prune` verb a workspace gets by
    declaring `prune()` (the `commands` seam, in use for the first time
    by a verb core used to own). For that, `migrate` and `prune` left
    `CORE_VERBS` — the validator refuses a plugin verb that names a
    core verb, so a moved verb must stop being one — and became
    `MOVED_VERBS`: the dispatcher prints the pointer only after the
    declared plugins had their chance, so the plugin's verb wins and
    a bare workspace still learns where the verb went. The façade
    gained `buildPackageGraph` (a project's transitive closure the way
    `vx run` computes it) and `nearMatches` (the "did you mean" core's
    own verbs give), so the package reimplements nothing. Its suite
    moved with it (ten cases through its bin) plus one through the vx
    CLI: a workspace without the plugin gets the pointer, one with it
    gets the subset. Core's verbs are now run, watch, cache, lock,
    init, upgrade, show, info, why, last — orchestration and its own
    cache, history and lock, nothing else.

68. DONE (the cold gate's tail, and `assume` for `@vzn/vx-schedule-history`):
    CI's Linux gate read 98.7 s for 53 tasks on four workers, and its last
    29 s were `@vzn/vx-docs#build` running alone — ready at the second
    second (its cross-compile deps take a second each) and started last,
    because the structural baseline ranks a task by what it unblocks and
    the docs build unblocks one. The history plugin would order it first
    on a machine that had seen it; a fresh runner has seen nothing. So
    the plugin grew `assume` (task id → ms for tasks the history has not
    seen; a recorded p50 wins; assumptions never feed the median), pinned
    four ways in its unit suite (control, lift, p50-wins, median-clean)
    and once end to end (the very first run starts the assumed-long
    chain), and this repo's `vx.workspace.ts` declares it with the one
    assumption — the first workspace to dogfood the `schedule` seam. The
    measured on the next run (9d84877, same runner class, cold): 98.7 s
    → 82.8 s for the same 53 tasks; the docs build started at second
    three, right behind the cross-compiles, and ran 50.8 s beside the
    shards instead of 29 s alone at the end — the run now ends when
    the package suites do. The remaining gap to the ~70 s ideal is
    that contention: the same work on four cores, which no order
    removes.

69. DONE (a plugin's name is its package name — the owner's rule,
    2026-09-10: "all plugins should have name taken from package name,
    no overrides allowed"): `definePlugin(import.meta, hooks)` is the
    one way to make a plugin. It reads the nearest `package.json` above
    the calling module, stamps the name under a registry symbol
    (`Symbol.for`, so a plugin package's own copy of core beside a
    compiled binary's stamps the key the binary checks), and the
    workspace loader — the one boundary every plugin crosses — refuses
    a plain object and a `name` set over the stamp, each with a message
    that says why. `PluginHooks` is `VxPlugin` without `name`, so a
    `name` on the hooks object is a type error and a runtime refusal.
    All nine first-party plugins converted; the core tests' inline
    plugins go through `tests/helpers/plugin.ts`, which gives each
    test plugin a package of its own under a temp root, in process or
    as fixture source. Pinned in `tests/plugin-name.test.ts` (five
    refusals, three controls) and by the façade snapshot. The same
    morning's `vx/<thing>` convention is superseded by this: `vx info`
    now lists `@vzn/vx-otel`, `@vzn/vx-github`, `@vzn/vx-mcp`,
    `@vzn/vx-schedule-history`.

70. DONE (the sandbox starts on the first task that executes, not up
    front): `armSandbox(nodes)` ran before classify + probe on every run
    with a sandboxed task — a sandboxed `true` through the runtime, the
    runtime module's own load, the proxy — 288 ms of this repo's 798 ms
    warm gate, paid when every task was a hit and nothing executed.
    `prepareSandbox(nodes)` now computes the domain union up front and
    hands `ExecuteArgs.armSandbox` a memoized `arm()` that execute-task
    calls before the first sandboxed spawn (both the cached path and the
    persistent path); `resetSandbox` runs at the end only when it armed.
    Interleaved A/B on this repo's warm `lint --all` as an unprivileged
    user, three reps each: 339–486 ms → 33–38 ms (classify + probe
    320–459 → 19–20 ms). An unavailable sandbox now fails the first
    sandboxed task instead of the run's first millisecond; a run of hits
    on a box without one succeeds, which is right — nothing ran. Pinned
    in the unsafe suite: the second run of a sandboxed workspace with a
    PATH that has only `git` on it (no bwrap, no sandbox-exec) hits and
    succeeds; the control edits an input and that miss fails on the probe.
71. DONE (the first warm run after a cold build no longer walks every
    output tree): the miss path took its output-directory snapshot right
    after the save, when the directories were milliseconds old — inside
    `OUTPUT_DIRS_RACY_MS` — so the snapshot was refused every time, and
    the next hit walked: on the 1,000-project bench, cold → warm read
    `run graph` 181 ms with 1,000 `output glob` walks (296 ms
    accumulated), and only the run after that 45 ms. The miss path now
    queues the request on `ExecuteArgs.outputDirSnapshots` and run.ts
    takes them at run end, 32 at a time, after the upload drain (a new
    `output dir snapshots` stage row). Pinned differentially: a cold run
    with a second task holding the run past the window leaves the
    `dist` row behind; with the run-end loop disabled the row is absent.
72. DONE (complexity pass, part 1 — the trimmed contract and the
    comments that lied): the deep-debug audit after item 71 listed what
    core carries that nothing uses or that no longer says what the code
    does. Removed: `recordRun` / `recordRuns` from the `CacheLayer`
    contract (`CACHE_LAYER_METHODS` 17 → 15; `recordRunBundle` is the
    one run-history write, no caller took the per-row forms, and the
    local `Cache` keeps them only for its own history tests), with the
    LayeredCache / ChainedCache delegations and the two tests that
    exercised them (rewritten on `recordRunBundle`); `parseFlaggedOutput`
    (git-inputs.ts, exported and test-only since `ls-files -s -v` folded
    the skip-worktree letter into the stage record) and its describe
    block; the logger's `streamed` set (written on every live chunk,
    read nowhere); a stranded `GitFilesCache` doc block in inputs.ts
    describing a memo that left with the enumeration rewrite. Corrected:
    the inputs.ts header (it named `ls-files --cached --others`; the
    enumeration is `ls-files -s -v` + `status -uall`), the cache.ts
    header (a second copy of the contract list, now a pointer to
    layer.ts), the `hashFile` doc (the stored digest is a git blob OID
    since v20, not an xxh3), the watch.ts ignore comment (the resolved
    cache dir is filtered, relocated or not — `IGNORED_SEGMENTS` is not
    what does it), the hit-restore SELECT comment (the batched probe
    loads output rows with the entry; only the lazy path pays the
    SELECT), and two config-schema doc blocks that sat on the wrong
    function. `EMPTY_SHORT_CIRCUIT` was one module-level `Map` shared by
    every run in a `vx watch` process; it is a factory now. One audit
    claim was refuted and recorded as a comment instead of a fix: the
    deferred-outputs path does not drop `outputs.workspaceFiles`,
    because `deferralEligibility` forces such a task eager
    (download-policy.test.ts pins it). Net −71 lines in src; the
    contract docs (modules/cache.md, layered-cache.md, chained-cache.md,
    caching.md, git-inputs.md) follow in the same commit.
73. DONE (DX batch from the feature-gap audit — four small asks and the
    stale rows): `--excludeDependencies` was the one camelCase flag in
    a kebab-case CLI; it is `--exclude-dependencies` now, and the old
    spelling — two edits past the suggester's reach — errors with the
    new name outright. `--concurrency <n>%` is that share of the CPUs
    (`50%` on eight cores is 4, never below 1, over 100% allowed for
    I/O-bound work), resolved at parse time so the run and its summary
    see one number. `vx cache prune --dry-run` picks the victims under
    the same policy and counts the orphans the sweep would take, then
    returns without touching the index or the directory (`PruneOptions.
dryRun` on the contract, so a layer that delegates gets it for
    free); pinned against the real prune with the same flags, which
    reaps exactly what the dry run named. `vx info --format json` prints
    the doctor's facts as one typed object (`InfoFacts`) that the pretty
    rows render — one source, no second list; `git` is null when not
    found and `gitStatusCache` null when git could not answer, where the
    pretty form says `(not found)` / `(unknown)`. Docs: comparison.md,
    architecture.md and patterns.md still called a Turbo-wire cache "a
    third-party plugin story" while `@vzn/vx-turbo-cache` and
    `@vzn/vx-nx-cache` sit in this repo; the rows name them now. Two
    audit items refuted on reading: `vx <verb> --help` has printed the
    reference since 2026-09-04, and cli.md's `vx migrate` / `vx prune`
    sections are the pointers to the packages, not stale verbs.
74. DONE (complexity pass, part 2 — one status vocabulary, and the
    seam nobody used): four renderers spelled the outcome words on their
    own — the framed block header and footer, the focused one-liner and
    hash-only audit line in logger.ts, the `--verbosity 1` table in
    cli/run.ts — and the table had drifted to `executed` where every
    other surface says `success` while its own comment claimed the
    shared vocabulary. `outcomeWord(o)` (bare word) and
    `outcomeLabel(o)` (with `(exit N)` on a failure) in events.ts are
    the one source now; the audit line keeps the bare word, so a
    `hash-only` consumer parsing it sees no change (output-flow.test.ts
    pins the exact line set). The CAS substrate — `cas-backend.ts`,
    `digest.ts`, `Cache.contentBackend()`, `FsCASBackend`,
    `MemoryCASBackend`, `Digest` — had no consumer in core or in any
    plugin (`@vzn/vx-reapi` carries its own `Digest` on the wire
    type), only its two test files and a module page; the 2026-06
    review that designed it (§4.3) planned a cache composed of CAS +
    index that was never built, and cache.ts reads and writes the
    artifacts directory directly. Removed with its tests, page and
    weights: −143 lines of src. Both are the pipeline principle
    applied to core's own insides: a seam with no consumer is a
    special case waiting to happen.
75. DONE (`--cache-dir` on the verbs that read what a run wrote): a run
    given `--cache-dir X` put its history, fingerprints and evaluations
    in X, and `vx why`, `vx last`, `vx info` and `vx cache prune` opened
    the workspace's cache regardless — so a relocated run could not be
    explained, replayed, reported on or pruned. All four take
    `--cache-dir <path>` now, through one parser (`parseCacheDirFlag`,
    the run's rules: a value required, the space form refusing a
    flag-shaped value) and one resolver (`cliCacheDir`, cwd-relative
    exactly as prepare.ts resolves the run's). Pinned end to end: a run
    with the flag is the one line `vx last --list --cache-dir` prints
    and absent from the bare list (`no recorded runs`), and `vx info
--format json --cache-dir` reports that directory with one run.
    The `--verbosity` help and flag row claimed `2+ = debug (reserved)`
    for a level nothing reads; de-claimed — `1+` prints the table.
    Refuted on reading: the audit's "duplicated glob-filter resolver"
    is three sites with three concerns (workspace membership, package
    enumeration, `workspaceFiles` matching), one `Bun.Glob` each and
    the partition rule already shared by comment; no shared resolver
    would be shorter. Considered and left: `--output-logs new-only`
    (frames for executed work, silence for hits) is a sixth mode over a
    matrix five wide; `broad` already prints executed one-liners and
    silent hits, and `full` frames both. A sixth column needs a user
    who cannot get there with `broad`. Warm check on this head as an
    unprivileged user under the real sandbox (`run lint.oxlint
lint.oxfmt` scoped to core, three warm reps): run 26–29 ms, whole
    process 94–100 ms, classify + probe 17–20 ms, the sandbox never
    armed — items 70 and 71 hold after the two DX batches.
76. DONE (`vx <verb> --help` is the reference cut to the verb): since
    2026-09-04 every core verb's `--help` printed the whole reference —
    120 lines to find `--older-than`. `verbHelpText(verb)` keeps the
    title, the `Usage:` lines that name the verb and every
    blank-line-delimited section that is `(for <verb>)` or lists a
    `vx <verb>` form, then `Full reference: vx help`; it reads the one
    text (as `documentedFlags` does), so there is no second list to
    drift, and an unknown verb gets the whole reference. Pinned: the
    run cut carries every flag `documentedFlags('run')` names and no
    other verb's section; the cache and last cuts carry their own
    examples only. Two probes on the warm floor, recorded so nobody
    re-runs them: (a) the `workspace config` stage (13–17 ms on this
    repo) is not core's — `findWorkspaceRoot` + `loadWorkspace` are
    under 2 ms in a fresh process and `loadWorkspacePlugins` is 9–11
    ms, the four plugin packages this workspace declares transpiling
    and importing; a workspace with no plugins pays nothing there, and
    an evaluation cache cannot hold plugin objects. (b) the compiled
    binary against `bun src/bin.ts` on the same warm scoped gate as an
    unprivileged user, three reps each: wall 101–109 ms vs 121–134 ms,
    run 13–15 vs 23–29 ms, classify + probe 10–12 vs 15–18 ms — the
    release form is ~20 ms faster end to end, and both are under the
    130 ms a process that loads ~200 modules costs before any graph.
    The remaining warm floor is module load and the git status walk,
    not orchestration.
77. DONE (one core per process — the shipped binary's second core is
    gone): every `import … from '@vzn/vx'` a run evaluates — a plugin
    package, the workspace file, a project config — resolved through
    `node_modules`, and in the compiled binary that was core's whole
    source transpiled AGAIN, per process: `@vzn/vx-otel` alone 20–25 ms
    (probe binary, three reps), this repo's four plugins 30–41 ms of
    `workspace config`, a live-evaluated config 22 ms for the identity
    `defineProject`. The 2026-09-03 refutation (§ Next 4) was of
    `Bun.plugin`'s `onResolve`, which never fires for a bare specifier
    from a dynamically imported user file; `build.module` — a VIRTUAL
    module for the exact specifier — does. `registerCoreAlias` in
    bin.ts serves `@vzn/vx` from this process's façade, loaded lazily
    on the first such import (cli/core-alias.ts). Interleaved A/B,
    binary against binary on the warm sandboxed `lint.oxlint
lint.oxfmt` gate as an unprivileged user, three warm reps each:
    wall 107–125 → 77–91 ms, `workspace config` 30–41 → 6.5–7.6 ms;
    the impure-config probe 22 → 2 ms; the 1,000-project bench (no
    `@vzn/vx` imports) equal both ways, as it should be. A workspace
    file with no `@vzn/vx` installed anywhere now loads through the
    binary (probed), so a binary user installs plugin packages only.
    Pinned differentially in `tests/core-alias.test.ts`: a fixture
    whose `node_modules/@vzn/vx` is a fake sees core's `definePlugin`
    with the alias and the fake without. Fallout in this repo: core's
    own `vx.config.ts` imported `./src/index.ts` relatively, which the
    alias cannot serve AND which made the config impure for the
    evaluation cache (the closure hashed core's source every run: 12
    ms of `load configs`); it imports `@vzn/vx` now and is served from
    the cache (1.1–1.5 ms). The registry-symbol brand on plugins
    (item 69) stays: a plugin compiled against another copy is still
    possible outside this alias, and the symbol costs nothing. Walked
    end to end on the head binary as an unprivileged user: a fresh
    workspace, `vx init`, the scaffold's workspace file replaced by a
    runtime `import { defineWorkspace } from '@vzn/vx'` with NO
    `node_modules` at all, two runs and `vx info --format json` — all
    green, nothing installed beside the binary.
    Compile flags re-probed the same day, so nobody re-runs it: `vx
version` through the binary is 32 ms with `--bytecode` and 75–82
    ms without it (`--minify` alone, plain), min of five; a compiled
    hello-world is 8 ms, bare `bun -e` 8 ms, `bun src/bin.ts version`
    49 ms. The release flags stand; the ~24 ms above the floor is the
    bundle's own module graph, the same on every verb.
78. DONE (the façade is the contract, so it names only what has a
    consumer): `src/index.ts` exported 155 names, 75 of them runtime;
    an audit against every plugin package, the site and the docs found
    41 runtime exports used by core's own tests alone, most of them put
    for "the distributed submitter / agent" — a consumer that left the
    repo in August (Decisions: agents removed). Gone from the façade,
    not from core: the graph primitives (`buildTaskGraph`,
    `expandRequested`, `markSurfacedDeps`, `isGroupTask`), the hashing
    seam (`computeTaskHash`, `createHashCache`, `deriveStableKeys`),
    the context capture (`capture*`, `detectCi`), input / output
    resolution and `cleanOutputs`, `GitFilesCache`, the lockfile
    reader, `loadWorkspaceConfig` / `resolveCacheDir`, `migrateScripts`
    (core's own `vx init` half; `applyMigration` stays for
    `@vzn/vx-migrate`), `parseSize` / `parseDecimalInt`, the cache
    policy parser, `EmptyHistoryProvider`, the logger and its view
    resolver, `assembleRunSummary`, the event bus and wire form, and
    every history reader but `whyDidThisRerunQuery` (which
    `@vzn/vx-mcp` serves). `runCommand` / `runSandboxed` went too: no
    executor plugin built on them — `@vzn/vx-reapi` speaks a wire. 34
    runtime exports remain, each with a consumer or a documented
    reason (the telemetry-sink helpers keep theirs). The pin in
    `tests/package-boundaries.unsafe.test.ts` is regenerated from the
    module; one core test moved its import to the workspace module.
    Nothing in the site's guides imported a removed name from
    `@vzn/vx`; the module docs that name these functions describe
    modules, not the façade, and stand.
79. DONE (a sandboxed task exposes a port on Linux — § In flight 3,
    the last capability gap in this file): `allow.localBinding` takes a
    port list beside `true`. On Linux a sandboxed task lives in its own
    network namespace (`bwrap --unshare-net`), so a dev server bound
    inside was invisible to the developer's browser and to a downstream
    task; each listed port is now bridged out the way SRT bridges its
    own proxy in: the task's side is a `socat UNIX-LISTEN:<tmpdir>/vx-
port-<tag>-<port>.sock … TCP:127.0.0.1:<port>` in front of the
    command inside the sandbox (reaped with the shell), the host's side
    a `socat TCP-LISTEN:<port>,bind=127.0.0.1 … UNIX-CONNECT:…,retry`
    spawned by `wrapSandboxedCommand` and released when the task's
    process exits (`releaseBridges`: the one-shot path after the child,
    the persistent path on the server's exit, `resetSandbox` for the
    rest). The task's side has to CREATE a unix socket under SRT's
    seccomp filter, so `prepareSandbox` arms `allowAllUnixSockets` for
    the run whenever a task declares a port list or `unixSockets` —
    per run, like the proxy allowlist. macOS: the host already sees
    the ports; a list means `true` there, and the per-task seatbelt
    rules are unchanged. The first probe still died on `socket(AF_UNIX)`
    with the flag set, which exposed a defect older than this item: on
    Linux `probeSandbox` initializes SRT with an empty config, SRT's
    `initialize()` returns early ever after, and the run's own call —
    the DOMAIN UNION of the earlier item included — never reached it.
    `initSandbox` now follows `initialize` with `updateConfig`, SRT's
    hot reload of exactly these fields. Probed end to end as an
    unprivileged user under the real sandbox: a sandboxed `Bun.serve`
    on a listed port answers `curl` from the host twice, its unix
    socket sits in `/tmp/claude`, and after the task exits the host
    bridge is gone and the port refuses. Pinned in the unsafe suite on
    Linux: a persistent sandboxed server on a listed port answers a
    downstream (unsandboxed) task's fetch, and the port is closed after
    the run; the control with `localBinding: true` fails the client on
    connection refused. The pure halves (grant, port dedup, both socat
    forms) and the schema (a boolean or a non-empty list of TCP ports;
    an empty list, `0`, `65536`, a fraction, a string refused) have
    their own units.
80. DONE (`vx completions bash|zsh|fish`, the gap audit's "later"):
    a script over the verb table and each verb's help cut — the verbs
    (the workspace's plugin verbs included at generation time) and
    every flag of each, read from the one text `vx <verb> --help`
    prints, so a flag cannot be documented and not completed; task and
    project names are not completed on purpose (evaluating configs on
    every Tab is the wrong price). `completions` joins `CORE_VERBS`,
    so a plugin may not claim the name. Pinned: the bash script parses
    (`bash -n`) and names every documented run flag, the zsh and fish
    scripts name every verb and run flag, an unknown shell is refused
    naming the three. The module page's verb table still listed
    `migrate` and `prune` as core verbs with files that left in item
    67; corrected in the same commit.
81. DONE (restores on their own lane): the scheduler admitted a
    confirmed cache hit's restore against the same `concurrency` cap as
    an execution, and a restore is disk I/O — ~8 filesystem round trips
    and no CPU — so a restore-heavy run was capped by the CPU count for
    no reason. Found by the refuted sync-restore probe (§ Next 6): the
    async round trips overlap across workers, so MORE workers is the
    lever, not fewer hops. Measured first on one binary: the
    1,000-project bench with every task a restore, `run graph` 683–754
    ms at `--concurrency 4` → 556–595 at 8, 571 at 16. Restore-tier
    tasks now count against their own lane, twice the exec cap
    (`--concurrency 1` stays serial for both); exec-tier work keeps the
    CPU-shaped cap and neither lane waits on the other. Interleaved
    A/B, binary against binary, four rounds of the restore-heavy run:
    `run graph` 813 / 1,101 / 1,041 / 1,095 → 554 / 968 / 870 / 854 ms
    (−12 to −32%, every round a win on a box that drifted up as it
    went); the bench's `warm, restore` row 1,363 / 1,224 / 1,386 →
    1,012 / 1,229 / 1,213. The all-hits-current run is unchanged
    (35–40 ms of `run graph` at any cap — nothing to overlap). Pinned:
    six misses and six restores on two workers peak at 2 and 4 with the
    lanes overlapping, and `--concurrency 1` keeps restores serial. The
    first cut let the exec-queue scan run past a full exec lane — pop
    and re-park every ready exec task on every tick, O(R²) on a wide
    frontier — and the 6,000-task scale pin caught it (0.5 s → 28 s);
    the scan now runs only when the exec lane can admit, the legacy
    O(1) gate kept per lane. Re-measured on that final cut, six
    interleaved rounds against the pre-lane binary: `run graph` 630 /
    832 / 765 / 794 / 805 / 969 → 558 / 845 / 693 / 684 / 701 / 804 ms
    — five wins of six, 10–17%, on a box whose baseline drifted 630 →
    969 across the rounds.
82. DONE (a miss's save runs off the execution slot): the cold profile
    of the 1,000-project bench put ~2.5 ms of `miss: save` (pack, write
    temp, scan, rename, index) and 0.6 of `miss: resolve outputs`
    inside every ~8.7 ms execution slot — a third of the slot was I/O
    holding a CPU-shaped cap, and 8 workers on 4 CPUs ran the cold row
    12–17% faster than 4, the same signature as item 81. The save now
    goes to a save lane (`orchestrator/save-lane.ts`): `saveMiss`
    keeps the slot-bound half in the slot — resolve the outputs, warn
    on an empty match, mark the git snapshot, which a same-project
    downstream task reads — and hands the pack + write + index +
    snapshot request to the lane, at most `2 × concurrency` in flight
    (each pack holds an artifact's bytes), drained by `run()` before
    the upload drain (the uploads are what the saves queued) and the
    snapshot loop (which reads what the saves pushed). A save that
    fails is one status line and a miss next time — the task's work
    ran; a cache error degrades to a miss like a remote one. An
    embedder that passes no lane gets the entry before the outcome, as
    before. Interleaved A/B, binary against binary, three cold rounds:
    `run graph` 2,543 / 2,379 / 2,414 → 2,071 / 2,070 / 2,350 ms
    (−19 / −13 / −3%), the drain at run end 1.5–2 ms. Pinned: the lane
    caps and orders saves, drains what a save deferred mid-drain, and
    reports a failed save without rejecting; and a run whose cache
    layer sleeps 300 ms per save starts the next task's execution while
    a save is in flight (an order log, not a clock, so it holds under
    any load) and still hits on the next run. One reader had relied on
    "outcome resolved ⇒ entry saved": admission's in-flight join, where
    a duplicate of the task in another run waits on a barrier and then
    probes — released at the outcome it probed a miss and ran the task
    twice (its two pins caught it). The barrier now lifts when the
    save has LANDED (`deferredSaves`, the lane's settled promise per
    task); the executor's own return is not held, only the joiners.
    The other reader is a DEPENDENT: its execute request carries the
    upstream's output rows, which the save writes (the executor
    capability pin caught a dependent reading `outputs: []`). The
    scheduler takes `settledOf(outcome)` — the same landed promise —
    and unblocks dependents on it while the freed slot admits other
    work at once; the bench's independent tasks lose nothing, a chain
    waits for the save as it always did.

83. DONE (a lockfile change re-keys only the projects it reaches;
    owner's ask, 2026-09-10): every lockfile at the root was folded into
    the workspace fingerprint every task key sees, so one `pnpm update
foo` invalidated the whole workspace and `--affected` selected every
    project. Two halves. Core grew its ninth seam, `VxPlugin.fingerprint
= { files, affected(change, ctx) }`: a plugin CLAIMS a lockfile,
    core leaves it out of the digest every task key folds (the
    config-evaluation cache still keys on every file — a config may
    import a dependency), and `--affected` asks the claimant which
    projects a change touches, handing it the bytes at the base ref and
    in the working tree, unioned with the path-owned projects; only
    "cannot tell" widens as before. The claims load lazily, so a diff
    with no lockfile in it never evaluates the workspace file for them;
    the schema refuses a claim on a name core never folds and a second
    claimant per file. `@vzn/vx-pnpm` (`pnpm()`) is the claimant: one
    digest per importer over everything it reaches — name, version and
    resolved-peer suffix (`foo@1(react@18)` is not `foo@1(react@19)`),
    resolution, patch, `link:` followed into the linked importer's
    reach, install-wide knobs (pnpmfile, package extensions, overrides,
    settings) into every one — for lockfile v5, v6 and v9, parsed by
    `Bun.YAML` with no dependency. The digest is Merkle over strongly
    connected components (pnpm writes cycles), Tarjan iterative,
    children first: the first cut walked one closure per importer and
    took 405 ms on 1000 importers × 3000 packages; the SCC pass takes
    20 (parse 42). Memoised on disk under the cache dir by the file's
    xxh3, so a warm run pays one read + hash + a small JSON, never a
    parse; per run the read happens once (a `WeakMap` on the key
    context — per task it was 1000 stats, 47 ms in `prepare (graph)`).
    Measured on the 1000-project bench with a synthetic 810 KB v9
    lockfile (1000 importers, 3000 packages, fan-out 2): bump one
    top-layer package → `plugins: []` 2,567 ms / 1000 miss, `pnpm()`
    551 ms / 12 miss · 988 up-to-date; bump one bottom-layer package
    (the whole fan-in reaches it) → 2,676 / 1000 miss vs 1,242 / 336
    miss. Warm `run build --all`, interleaved min-of-7: in-run `time` 464 →
    485 ms, `prepare (graph)` 2.5 → 9.6 ms — the read, the hash and the
    memo once, then a map lookup per task — inside the run's own noise
    (the bare arm spread 464–612).
    Pinned: the two digests (a claimed edit moves `all`, not
    `unclaimed`; a claimed file appearing moves neither), `--affected`
    (answer used, both sides' bytes, undefined widens, an unclaimed
    sibling widens, no load without a lockfile change), the claim
    through `planRun` and the CLI, the three schema refusals via the
    doc-drift table; and in the package: transitive bump, link, peer
    suffix, patch, install-wide knob, YAML key order, v6, alias, a
    cycle, `affected` (names, root-importer fallback, cannot-tell),
    `vx run` / `vx why` / `--affected` end to end, `scope: 'workspace'`,
    no lockfile, and the memo read instead of parsed (a planted
    sentinel keys the task). Not done, by design: other lockfiles
    (`bun.lock`, `yarn.lock`, `package-lock.json`) — the seam is the
    same, each is a package when someone needs it.

84. DONE (the seam is not a special case: a second claimant, and the
    shell moves into core): `@vzn/vx-pnpm` carried the claim, the
    per-project key, the memo and the `--affected` diff around its
    parser, and a `bun.lock` plugin would have copied all of it. Core's
    `lockfileClaim({ file, digest, version, scope })` (orchestrator/
    lockfile-claim.ts, on the façade with `reachDigests`, the
    Merkle-over-components digest both parsers use) is that shell; the
    pnpm package is its parser now, and `@vzn/vx-bun` is the second:
    `bun.lock` through `Bun.JSONC`, resolved the way Bun lays
    `node_modules` out (`p/d` under the package at `p`, else the nearest
    ancestor's, else the root's — a nested version counts for the
    package it is nested under and no other), a `workspace:` entry
    pointing at its importer so a dependant folds the linked package's
    whole reach, install-wide knobs (overrides, patches, catalogs) into
    every project. This repo declares `bun()` in its own
    `vx.workspace.ts`. Measured here, `run ci --all --dry` hashes
    before and after bumping astro's resolved version in `bun.lock`:
    59 of the gate's 61 tasks re-keyed without the plugin, 2 with it
    (`@vzn/vx-docs#build`, `#test`). Warm `run lint.oxfmt --all`,
    interleaved min-of-7: wall 372 → 367 ms (noise), `prepare (graph)`
    3.2 → 5.3 ms — the one read + hash + memo. Also fixed in the same
    push: `@vzn/vx-pnpm`'s own lint tasks were red on PR #272's first
    CI run for want of the per-package `.oxfmtrc.json` /
    `.oxlintrc.json` (without the ignore list oxlint reads
    `node_modules/@types/bun` and reports TS2688); both packages carry
    them now, and the package-level run (`cd packages/<p> && oxlint
--type-aware --type-check`, `oxfmt --check .`) is part of what a
    new package must pass before it is pushed. And the `VX_TIMING`
    table now ends `prepareRun` with two rows, `build graph` and
    `plugin stages` (the graph, key and schedule hooks), where one
    `prepare (graph)` row hid the key stage's cost all day: on this
    repo warm, 1.5 and 4–7 ms (the lockfile memo read plus the history
    plugin's read). Pinned: the shell in
    core with a fake digest (memo served across instances, a planted
    memo keys the task, a changed file or version ignores it, one
    parse for two tasks of one run, the root fallback, `scope:
'workspace'`, the `--affected` diff, `reachDigests` reach /
    numbering / cycle); the bun parser (hoisted bump, nested version,
    workspace link, install-wide knob, scoped nesting, refusal) and
    `vx run` / `--affected` end to end.

85. DONE (one package for every package manager; owner's ask,
    2026-09-10): `@vzn/vx-pnpm` and `@vzn/vx-bun` merged into
    `@vzn/vx-lockfile`, which exports `pnpm()`, `bun()`, `npm()` and
    `yarn()` — one plugin per manager, each a parser over core's
    `lockfileClaim` with the same two modes (`scope: 'project'`, the
    default, one digest per project; `scope: 'workspace'`, the whole
    file's hash through the plugin) and the same once-per-content /
    once-per-run cost. The claim's key part is named after the manager
    (`lockfileClaim` grew `part`), so `vx why` reads `plugin
@vzn/vx-lockfile/pnpm`. New parsers: `package-lock.json`
    (lockfileVersion 2 and 3: the `packages` map, `p/node_modules/d`
    then the ancestors then the root, `link: true` entries pointing at
    their workspace, root `overrides` into every project; version 1 is
    refused by name) and `yarn.lock` (berry: `name@npm:range`
    descriptors to entries, `workspace:` ranges by name, `__metadata`
    into every project; classic yarn 1: its own text format read
    line-wise, one root digest since the file records no workspaces —
    coarse and honest). This repo imports `bun()` from the merged
    package. Pinned per manager (hoisted / transitive bump, nested
    version, workspace link, install-wide knob, refusals) and `npm()`
    / `yarn()` through `planRun`; the pnpm and bun suites moved whole.
    Not done: yarn classic per-workspace precision — the file has no
    workspace entries to key on, and reading each `package.json` to
    seed the walk is a design for when a classic-yarn workspace asks.

86. DONE (CI runs vx tasks only; owner's ask, 2026-09-10): the
    workflows had grown steps that ran what vx should run — one
    `cd packages/<p> && bun test` per plugin package (all of them
    already inside `vx run ci --all`, so the job ran every suite
    twice), a per-file `bun test` loop for `@vzn/vx-reapi`, four
    hand-dealt `bun test --shard` slices on macOS, and two root
    `package.json` scripts (`docs:generate`, `site:check`) excused as
    "workspace steps" because they read across a project boundary.
    "If it won't work for us it won't work for anyone": each is a task
    now. `@vzn/vx-docs#import` generates the Starlight collection from
    `packages/vx/docs` with the sibling read declared on the task
    (`read: ['../vx/docs/**']`) and the same files as `workspaceFiles`
    inputs, outputs the generated set by name (every generated page is
    gitignored and marked; the tracked pages beside them are never
    wiped), and `build` / `test` depend on it — which also fixed a real
    stale-hit bug: `build`'s `workspaceFiles: ['docs/**']` named a
    workspace-root path that stopped existing when core moved under
    `packages/`, so a docs edit never re-keyed the site build.
    `@vzn/vx-bench#check.site` runs `update-site.ts --check` with its
    two sibling reads declared and folded. `@vzn/vx-reapi#test` is the
    per-file loop as a task, the four endpoint / require variables
    passed through AND folded as key inputs (a skip-mode pass never
    serves the live run), and no sandbox — the suites dial service
    containers on the host loopback, unreachable from a Linux sandbox's
    network namespace — so it joins `test.bun.unsafe` as the second
    unsandboxed task in the repo. The workflows now call `vx run ci
--all` (Linux), `vx run test --filter @vzn/vx-reapi` with the
    endpoints (the service job), `vx run test --filter @vzn/vx`
    (macOS) and `vx run build --filter @vzn/vx-docs` (the site deploy);
    the root scripts are gone. Still steps, on purpose: runner setup
    (bwrap, the cross-compile warm-up, the service containers) and the
    checks of vx's own artifacts as a user meets them — the compiled
    binary's version and launch, the bare-specifier workspace through
    the binary, the macOS enforcement canary — which run outside any
    sandbox by design. Verified on the unprivileged clone before the
    push, under the real Linux sandbox (`VX_REQUIRE_SANDBOX=1`):
    `import` 287 ms success with the sibling read granted, `check.site`
    824 ms success, `@vzn/vx-reapi#test` 28 s success in skip mode; and
    `run test --filter @vzn/vx --dry` selects the thirteen core test
    tasks and nothing else. The first CI run of the change had the service job
    red in 24 s: `@vzn/vx-reapi#test` reaches core's four compile tasks
    through `install → ^build`, they run sandboxed, and that job had no
    sandbox runtime — so the Linux runner setup (sandbox deps, the
    probe, the cross-compile warm-up) is one composite action
    (`.github/actions/vx-runner`) that every Linux job uses.

87. DONE (core has no `build`; dependants stop compiling the release
    binaries): every package's `install` depends on `^build`, and
    core's `build` was the four `bun build --compile` targets, so `vx
run test --filter @vzn/vx-lockfile` on a fresh checkout compiled
    four binaries first, the CI service job needed the whole sandbox
    runtime to run one suite, and a root container that cannot sandbox
    failed every package's tasks at the compile step (all day,
    2026-09-10). What a dependant needs from core is its source, which
    needs no build — so core has no `build` task at all: the four
    release targets stay `build.bun` (release.yml calls it by name),
    and `check.binary`, new in core's `ci`, compiles THIS host's target
    the way release.yml does (re-signed ad hoc on macOS, as the release
    does), runs it and asserts `--version` reports the manifest version
    — the check ci.yml carried as a step, now a task that every gate
    runs, on a laptop too. `vx run ci --all --dry` lists no
    `build.bun.*` task; `run test --filter @vzn/vx-lockfile --dry`
    selects the package's own tasks and nothing of core's. Cold gate on
    the unprivileged clone, `rm -rf .vx/cache` then `vx run ci --all`:
    121.2 s → 99.8 s wall (−18%); the four compiles took 4.9 / 12.5 /
    13.7 / 13.8 s under the gate's contention, `check.binary` takes
    1.0 s. (Both runs' one red task is `@vzn/vx-docs#build` refusing
    that box's Node 20 — environment, green in CI.) The `install →
^build` chain itself is untouched and right: a dependant's tasks
    wait for what its deps BUILD, and core builds nothing a dependant
    consumes — it is consumed as source.

88. DONE (tasks a package does not have to write): the gap analysis
    the owner asked for (2026-09-10) put task inference first among
    what is closable — Nx gives a package its tasks from `vite.config`
    / `next.config` / `jest.config` with no config file, and vx had the
    seam (the `project` stage) with one plugin on it, the Turbo one.
    `@vzn/vx-infer` is the family: `vite()` (`build` cached on sources,
    `public/`, `index.html`, the config, `.env*`, output `dist/**`;
    `dev` and `preview` persistent, ready on `Local:`), `vitest()`
    (`test`, from its own config or `vite.config` when vitest is a
    dependency), `next()` (`build` with outputs listed as what `.next/`
    holds besides Next's own `cache/` — the schema refuses a negated
    output glob, rightly, and `.next/cache` must survive between
    builds; `dev` and `start` persistent), `tsc()` (`typecheck`,
    `--noEmit`, only with `typescript` in the manifest) and `scripts()`
    (every `package.json` script an UNCACHED task — a script says
    nothing about what it reads, and a guessed key is a stale hit;
    `build` waits on `^build`, `dev`/`start`/`serve`/`watch` are
    persistent, lifecycle scripts skipped, `exclude` for more). Each
    fills what the package did not declare and never overwrites;
    order is precedence, so tool plugins go before `scripts()`. The
    sandbox is never inferred. Pinned through `planRun` over
    config-less packages: each shape, the package's own declaration
    winning, a package without the tool getting nothing, `exclude`,
    and the plugins composing. Docs: the package README, the site
    guide (`guides/inferred-tasks`), the comparison row, the listings.

89. DONE (a hosted cache in three commands): the gap analysis' third
    row — Turbo's `turbo login && turbo link` gives a team a remote
    cache in a minute, and vx said nothing about it — was mostly a
    doc gap and one default. `@vzn/vx-turbo-cache` already speaks
    Vercel's wire; it now treats a token with no `apiUrl` as Vercel's
    hosted Remote Cache (`https://vercel.com/api`), exactly as `turbo`
    does, so `turboCache()` with `TURBO_TOKEN` / `TURBO_TEAM` set is the
    whole hosted setup; no token still declines. Pinned in the config
    resolver. The remote-caching guide leads with the three commands
    and names the Nx wire beside it.

90. DONE (the `^build` convention stays visible on a package with
    nothing to build): the owner's point on item 87 — deps must be
    built before a project uses them — is the `install → ^build`
    chain, which item 87 kept; what it removed was core's `build`
    group, so core's config no longer said what it means. It does
    now: `build: { dependsOn: [] }`, an explicit empty group with a
    description ("nothing to build — core is consumed as source; the
    release binaries are build.bun"). The schema already accepted the
    form (only the OMITTED field is the typo guard), the graph runs
    nothing for it, and a dependant's plan carries nothing of core's;
    schema.md says so in both places group tasks are described.
    Pinned: the loader accepts it, and through `planRun` a dependant
    whose `^build` reaches an empty group runs only its own task
    (control: a `build` that does work is pulled in).

91. DONE (owner's decision, 2026-09-10, night — technology plugins
    are the community's): `@vzn/vx-infer` (item 88: `vite()`,
    `vitest()`, `next()`, `tsc()`, `scripts()`) is retired the day it
    shipped. The point stands and the seam stays — the `project`
    stage visits every package, a config-less one as `{ tasks: {} }`,
    and a plugin fills what the package did not declare, with the
    package's own config always winning — but core's authors name no
    tool: people write configs and import what they need, plugins may
    auto-configure on top and modify project configs, and a plugin
    for a given framework is for whoever uses that framework to write.
    `@vzn/vx-turbo` stays as the adoption plugin it is. The recipe
    lives in the plugins guide; the comparison row records the
    decision. Recorded in Decisions.
92. DONE (owner's ask, 2026-09-10, night): Bun, every dependency and
    every CI action brought current in one commit. Bun 1.4.0 → 1.4.2
    (`packageManager`, `bun-version` in ci/docs/npm); root dev deps
    `@types/bun` 1.4.2, `oxlint` 1.82.0, `oxfmt` 0.67.0 (its new
    reflow touched eight files — three design docs, scheduler.md,
    plugin.ts, tally.test.ts, README, comparison), `oxlint-tsgolint`
    7.0.2001; the site on astro 7.3.2, starlight 0.42.0, mermaid
    12.0.0 (152 pages build). Every workflow action now pins a commit
    SHA with its tag beside it: checkout v7.0.1, setup-bun v2.2.0,
    setup-node v7.0.0, upload-artifact v7.0.1, download-artifact
    v8.0.1, upload-pages-artifact v5.0.0, deploy-pages v5.0.1,
    action-gh-release v3.0.3. Dev-dep versions are exact now, not
    caret ranges: the lockfile already froze them, so a range only
    said less than the lock. Proven under 1.4.2 before the push: the
    twelve core shards and the unsafe suite, all twelve package
    suites, docs import/test/build. One refutation: shard 9 reddened
    once on `Cache.key` scaling ratio (51× against the 30× guard) —
    thirteen shards side by side on this four-core box, not the
    upgrade: the guard passes alone under 1.4.2 and 1.4.0 alike,
    interleaved twice each, and the shard alone reruns 203/203.
    One thing the local gate missed and CI caught (run 34503612332):
    astro 7 makes `@astrojs/markdown-remark` an optional peer, and
    `markdown.remarkPlugins` refuses to run without it — the local
    build passed only because two stale 7.2 copies still sat in the
    store. Moving them aside reproduced CI's failure; the site now
    declares `@astrojs/markdown-remark ^7.3.0` and builds 153 pages.
93. DONE (owner's ask, 2026-09-10, night — "we know hashes and past
    runs"): local flaky-task detection, three surfaces over the one
    rule `failure-mode.ts` already held. A task is flaky when its
    exact cache key has both passed and failed on record (a hit is a
    pass) or it needed a retry this run; a failure on a key that never
    passed is a break, and a task with no `cache` block is never
    judged (its key says nothing about inputs — one bad network day
    would read as a month of flakes). `detectFlaky` judges the run's
    executed keyed outcomes BEFORE its rows land: the footer's
    `Flaky:` section (`✓ app#test — passed on inputs that failed 1×
before · 2 attempts this run`), `--summarize`'s per-task
    `flaky: { passes, failures, attempts }` (present only then), and
    `vx info`'s `flaky tasks` row (`flakyTasks` in JSON: the standing
    list over the 30-day history, most failures first). Cost follows
    the run's colour: no candidate, no query; a green miss probes
    `runs_failed`, a new PARTIAL index over failed rows (a green run's
    inserts only evaluate its predicate — 3.2 ms per 1,000 rows either
    way), so the common case is 0.01 ms at 170k rows against 10 ms
    scanning; only a key that failed before or a task failing now pays
    the ~10 ms projection scan. Pinned: the rule at the unit (probe
    served `USING INDEX runs_failed`, no scan on green keys, chunking
    past 500, the index created on an older database) and end to end
    (`tests/flaky.test.ts`: red then green on one key names it in all
    three surfaces; a hit and a changed-key break are the controls).
    Comparison row: Nx has this behind Nx Cloud, Turbo not at all.
94. DONE (owner's ask, 2026-09-10, night — "confidence that what
    works with nx turbo will work with vx"): two parity suites over
    the real CLI, `tests/parity-turbo.test.ts` (26 cases) and
    `tests/parity-nx.test.ts` (19), on one four-package fixture
    (`tests/helpers/parity.ts`: `app → ui → lib`, `app → lib`, `docs`
    alone), every case named for the upstream contract it stands in
    for — `dependsOn` in its four forms, the filter DSL, `[ref]` and
    `--affected`, hits/restore/replay, inputs narrowing and the
    cascade, `env` vs `passThrough`, `cache: false`, `--force` /
    `--no-cache`, forwarded args in the hash, the lockfile and the
    manifest in the hash, `--continue` modes, failures never cached,
    `--output-logs`, `--summarize`, wildcards, groups, runtime and
    root-file inputs, `nx show` / `vx show`, and Nx Cloud's flaky
    flag answered locally (item 93). Selection cases read
    `--dry=json`, so most of the 45 never execute; the two suites
    run in ~9 s. `docs/parity.md` is the map: upstream → vx spelling
    → the deep pin, with the three divergences that change what a
    command selects or leaves on disk marked and pointed at the
    reasoning (union not intersection, changed-not-dependents,
    cleaned-not-additive). Two things the suites caught in the
    writing, both mine: DOT edges point dependency → dependent, and
    `--summarize` after `--` is the task's argument. The 2026-07
    parity design doc's gap lists stay the backlog for edge cases;
    this is the front door.
95. DONE (owner's ask, 2026-09-10, night — "redo website and docs;
    focus on what vx can do and why it's better; vx compiles, it
    should not require node or bun; one thing, build on top; what Nx
    should be if it weren't a product"): the positioning surfaces
    rewritten on that sentence. Landing page: title, hero, badges
    (`One binary · no Node, no Bun`), install pill (`npm install -g`),
    two new feature cards (the lockfile keyed per project; flaky tasks
    from your own history), the platform section renamed to the seams
    ("built to be built on"), the migrate CTA and footer point at the
    parity map; the stale "even vx's own local executor and cache are
    plugins" claim replaced by the floor (README too). Introduction
    rewritten: one thing built to be built on, the ten seams (the
    `fingerprint` seam included) and every first-party package on
    them, community owns technology plugins, flaky detection, the
    parity map, requirements that say what is true — one self-
    contained binary, git, a workspace, Linux/macOS with Windows under
    WSL. Quickstart and the adoption page stop assuming Bun; the
    sandboxing guide and the comparison's three Windows rows say WSL;
    the REAPI guide's "requires Bun" names the runtime the binary
    embeds; the extensibility guide's "declares the local executor and
    cache" is the floor; the CI guide's stale "planned as
    `@vzn/vx-github`" says what ships and gains a "Flaky tasks,
    without a service" section; the Nx migration guide's `nx affected`
    row maps to `...[ref]` (Nx includes dependents) and both migration
    guides link the parity map. The comparison's vx paragraph, the
    docs overview and the README carry the same positioning. Not
    touched on purpose: the module and design pages (internals), and
    the benchmark figures (item 6 re-measures those).
96. DONE (2026-09-10, late night — two 2026-07 parity findings that
    were still live): (a) an option-like `--affected=<base>` reached
    `git diff` as an option — `--output=<path>` is an arbitrary file
    write from a CI-supplied string, stopped only by `verifyRef`'s
    exit-1 branch. `affectedProjects` now refuses an empty or
    `-`-leading base before any spawn, and every git call in the
    module ends its options (`--end-of-options`) before the ref, so a
    second caller cannot lose the guard. Pinned for five shapes with
    the assertion that survives a refactor (the file does not exist
    afterwards) and a control that proves the injection is real
    (bare `git diff --output=` writes the file). (b) The runtime-input
    probe reads vx's ambient env, never a task's `exec.env`, and the
    per-run memo keyed on (projectDir, command) is sound only because
    of that; nothing pinned it. Now an e2e does — two tasks, one
    probe, different `define`s, one line in the probe's log carrying
    the ambient value — and the comments at the memo key and the spawn
    say why (Nx pins the same regression). Both closed in the design
    doc.
97. DONE (2026-09-10, late night — parity finding M11): an exact
    `cache.inputs.tasks` entry that no `dependsOn` entry names
    (`['buidl']` for `['build']`) matched nothing at hash time and
    folded no upstream hash — the task silently decoupled from its
    dependencies, a stale hit waiting for the next upstream change.
    The loader refuses it now, naming the entry and the task's
    `dependsOn`; an entry a `dependsOn` pattern matches (`build.*`
    names `build.bun`) passes, and patterns, wildcards and negations
    stay silent, as the 2026-07-10 wildcard decision requires (a
    preset-spread pattern legitimately matches nothing in some
    projects). A config-level rule on purpose: the graph's edge set
    bends under `--exclude-dependencies`, the declaration does not.
    The pattern glob is mirrored from the graph module (workspace may
    not import it); the runtime filter is unchanged. Pinned in the
    loader suite with the pattern case and a control for every silent
    form. Closed in the design doc.
98. DONE (2026-09-10, late night — parity finding M2): nothing said
    the task graph a key is derived from is invariant to the order
    tasks are requested or projects are discovered; Nx pins it after
    its pass-through nodes once took shape from target order. The
    sparse fixture (an app whose dependency declares no task at all,
    bridging `^test` and `^lint` to the holders behind it) now builds
    under two request orders and a reversed discovery order and
    asserts one shape: ids, sorted deps, requested flags, surfaced
    count. Closed in the design doc. What the 2026-07 doc still lists
    is edge-case coverage (cycle topologies, odd filenames, watch
    timing), none a live defect after items 96–98's sweep.
99. DONE (2026-09-10, late night — parity finding M12 was live, and
    worse than listed): a restore across an output-shape change.
    Probed every ordered pair of `dist/out` as a directory, a file
    and a symlink: restoring the directory entry over a symlink and
    the file entry over a directory failed as "corrupt artifact"
    (an obstruction on disk, misnamed), and a task whose output is a
    symlink cached NOTHING — the glob scan (`onlyFiles`) drops every
    symlink, so the save captured no file and the "hit" restored an
    empty tree under a green run, while `planArtifact`'s comment
    claimed the link was stored as its target's content. Fixed on
    three sides: the output scan lists symlinks (never followed, never
    descended; one `lstat` per entry on the miss path), so the save
    packs the target's bytes and the clean unlinks the link; a link to
    a directory or a dangling one is refused by name at save time and
    caches nothing (the task's own success stands, the next run
    executes again); the clean prunes the directories it emptied,
    never the project root, so a directory-shaped tree does not block
    a file entry; and an obstruction the globs do not cover fails the
    restore naming the path and the errno, no longer as a corrupt
    artifact. `tests/output-shape.test.ts` drives all six transitions
    both ways plus the stray and the two refusals; the containment pin
    that had recorded "the link is never yielded" as a fact now
    asserts the link is unlinked and its target untouched. M9 (a task
    reading stdin sees EOF) pinned in the runner suite alongside.
    Measured, since the scan is on the miss path: 1000 projects,
    `run.ts 1000 3`, interleaved twice against a worktree at main —
    no-cache 2,645 / 2,864 ms before against 2,683 / 2,820 after (the
    loaded box's noise; the arm's own standalone median was 2,501),
    warm arms identical. One `lstat` per output entry, twice per
    miss, is invisible at this scale.
100.  DONE (2026-09-10, late night — parity findings M1 and M5): the
      `--graph` DOT writer interpolated task ids and labels raw, and a
      task name is any config key, so a quote, a backslash or a newline
      ended the string early and broke the document (the third sibling
      formatter to ship this class). One DOT quoter now, pinned by a
      per-line balanced-quotes check over a name carrying all three.
      Odd filenames — a space, a quote, a backslash, non-ASCII — were
      never pinned through hashing or the artifact: they are now, on the
      enumeration side (git's `-z`, tracked and untracked) and the tar
      round-trip (name- and byte-identical after a wipe and restore).
      No live defect on the filename side. The 2026-07 parity doc's
      remaining rows are cycle topologies (Nx M1), watch timing (M7, M8)
      and the LOW list; none names a wrong result.
101.  DONE (2026-09-10, late night — Nx's cycle matrix): six topologies
      pinned where vx had two — a task cycle through every project and
      one bridging a project without the task are refused; a package
      cycle wrapping back through pass-through projects and one between
      projects that makes no task cycle build; two disjoint package
      cycles resolve independently in one graph; a two-task same-project
      cycle is refused. No defect: the walk seeded with the declaring
      project (the 2026-07-26 fix) holds on every shape. What the
      2026-07 doc still lists is watch timing (M7, M8) and the LOW rows.
102.  DONE (2026-09-10, night — owner's ask: "go through all tests of nx
      and turbo"): two survey passes over fresh sparse clones, every
      upstream test classified with grep evidence — Turbo 568 tests, 10
      core gaps; Nx ~380 cases, 7 — recorded with the decisions in
      `docs/design/turbo-nx-survey-2026-09.md`. The first fix, and the
      one that mattered: a LITERAL directory in `cache.inputs.files` or
      `outputs.files` (`src/`, `dist`) matched nothing — a glob matcher
      sees only the literal path — so the most common turbo.json shape
      migrated into a config that folded zero inputs (a key that never
      moved) and cached an empty artifact. A literal is the file or its
      whole tree now, in inputs, workspace files, outputs and their
      negations (`asTrees` in inputs.ts); the literal-input guard
      settles on the tree too. Self-healing: only a key that was already
      wrong changes. Pinned on both sides.
103.  DONE (same night — Nx's top gap): a negated workspace package glob
      (`!packages/fixtures`, which pnpm, npm, yarn and Bun all take) was
      handed to `Bun.Glob` raw, where a leading `!` negates the WHOLE
      pattern — every manifest in the tree matched, the excluded package
      ran under `--all`, and a fixture repeating a name killed the run
      with "Duplicate package name". Negations subtract now, in
      discovery and in the root-claim walk, a literal one as its tree;
      pinned across three manifest spellings.
104.  DONE (same night): `--affected` / `[<ref>]` diffed from the ref,
      not from the merge base of ref and HEAD — on a branch off a moved
      trunk it selected everyone else's changes and would hide your own
      when trunk later landed identical bytes; the module's own header
      claimed the three-dot form the code never used. One
      `git merge-base --end-of-options <ref> HEAD` (the ref itself when
      there is no ancestor) feeds the diff and the claimed-file bytes;
      pinned with Turbo's diverged-base fixture.
