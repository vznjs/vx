# STATUS — the living handoff

**Read this first.** It is the one file a fresh session needs to pick the
project up: the direction, what shipped, what is in flight, what is next.
Update it in the SAME commit as the work it describes. Newest state wins;
delete stale lines rather than appending corrections.

## Direction (owner, 2026-09-02)

> "VX should be the Vite of task orchestration. Perf first, then
> modularity. Slim core; add features with plugins or replace
> functionality. Remove DTE / VX Cloud / agents — vx ships none of it, but
> gives people a way to implement it on top. Consider everything before
> this date legacy."

Concretely:

1. **Performance is the first decision driver.** Every change to the run
   path is measured (`packages/vx-bench/`), and a slower core is a regression even if
   it is prettier. Targets: the fastest warm no-op run and the lowest
   scheduler/hash overhead of any JS-monorepo task runner.
2. **Core is a pipeline with seams, not a product.** Core owns:
   discovery, config evaluation, the task graph, cache keys, scheduling,
   and the seams. Plugins own: WHERE a task runs (`executor`), WHERE
   artifacts live (`cache`), WHO observes (`telemetry`/reporters), and —
   as the seams widen — how the graph is shaped and prioritised and which
   CLI verbs exist.
3. **No distribution in the repo.** No agents, synchronizers, controllers,
   cloud, dashboards. The executor seam is the extension point for all of
   it; `@vzn/vx-reapi` (Bazel Remote Execution API) stays as the proof
   that the seam is wide enough.
4. **Native first.** Bun APIs over dependencies. A dependency needs a
   reason written down next to it.
5. **Adoption ready.** Docs, site, and design describe the product that
   exists — verified against the code, not remembered.

Process: push directly to `main`, no PRs. Gate before every push:
`bun packages/vx/src/bin.ts run ci --all`. Small, focused commits.

## Shipped — the record

The review arc (2026-09-02 → 09-09) and improvement-loop items 1–64,
with the bench numbers behind them, moved whole to
`docs/history/2026-09-review-arc.md` on 2026-09-10 so this file stays
the handoff and not the log; numbering continues from there. Keep it
that way: when the loop below passes forty items, move the oldest
batch there in one commit.

## Improvement loop (2026-09-09, after the review pass merged)

Open-ended, owner-delegated: find flaws, widen seams, sharpen DX,
refactor toward cleaner layers. One coherent commit per step, gated,
recorded here as it lands. Layer map measured first (imports between
`src/<module>` directories): util ← workspace ← cache, exec ← graph ←
orchestrator ← cli, `config.ts` a leaf, no back edges — the boundaries
test is telling the truth.

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

**Shard weights refreshed (2026-09-10, after items 65–67).** Three
suites moved to packages and `init.test.ts` shrank, so the deal was
running on stale numbers: twelve shards side by side on this four-core
box read 11.8–14.6 s (wall 14.7 s). Re-weighed from that run's JUnit
(`--weigh`), the same files deal to 13.5 s each by the new weights
against 14.6 s for the old deal's heaviest — the wall follows the
heaviest shard, so about a second. The weights are what a twelve-way
run on four cores measures, the condition the gate runs under.

**Plugin names, one convention (2026-09-10; superseded by item 69 the
same day).** `vx info` listed the repo's own plugins as `vzn/otel`,
`@vzn/vx-github`, `vx/mcp` and `vx/schedule-history` — three spellings
across four lines. The interim answer was `vx/<thing>` everywhere; the
owner's answer is that the name is the package name and nothing else,
which item 69 enforces. No first-party plugin fills `key`, where the
name is folded into the material, so nothing re-keyed either way.

**The guide pin under the sandboxed gate (2026-09-10, after item 67).**
CI's Linux job went red on 15136a6 in `@vzn/vx-docs#test`: the plugins
guide's type-check pin exited 1 with no diagnostic line captured. The
cause was the sandbox, not the types: item 65 had pointed the pin's
tsconfig `paths` straight at `packages/vx-schedule-history/src`, a
sibling the site does not depend on, and a sandboxed task may read its
project, its `node_modules` and what those link to — nothing else. The
fix is the honest one: the site declares `@vzn/vx-schedule-history` as
a devDependency, Bun links it into the site's `node_modules`, the
sandbox grants the link target, and the pin resolves the package
through that link. Reproduced and proven differentially under the real
sandbox here, not on CI alone — a probe refuted on the way: with the
link present, even the direct path passed, so the denial was never
about the route but about an ungranted target. Recipe, since the
container runs as root and the runtime refuses a nested user namespace
there: copy the bun binary somewhere world-readable, `chmod 1777
/tmp/claude`, and run `vx run <task> --no-cache --excludeDependencies
--cache-dir <writable>` as `nobody` with `HOME` set — bwrap works for
an unprivileged user on this kernel. The pin now carries oxlint's tail
when it exits non-zero without a diagnostic line, so the next such
failure names its cause on CI.

**Two warm-path probes refuted after item 61 (2026-09-10).** Cold
config evaluation, measured by deleting `config_evals` and
`config_closures` on the warm 1,000-project copy: the `load configs`
stage reads 584 ms cold against 26 ms warm — 0.58 ms per config through
the worker, so a 2,000-project first run pays about a second there and
no batching lead exists; `scale-graph`'s 9.5 s `beforeAll` is its
generator, git and warm plan, not evaluation. And the accumulated
`output dirs` counter (52 ms over 1,000 proofs, 52 µs each for one or
two `statSync` calls) is not a cost to chase: an accumulated span
measures wall time between its start and end, and under the
scheduler's concurrency that window holds other tasks' work, so the
per-call figure over-counts. The rule for the stage table: stage rows
are exclusive and comparable; accumulated rows are upper bounds.

**Profiles after item 50 (2026-09-10).** `bun --cpu-prof` on the
pre-warmed 1,000-project copy, third run of three. `vx show` (93 ms
sampled): 28% in the discovery closure (`workspace.ts:303` — the
per-package readdir + manifest read, async continuation attributed to
the closure), 11% `JSON.parse` of manifests, 5% `listProjects`, then
the staged load and the eval-cache keys at 1–3% each. Warm `vx run`
(228 ms sampled): `statSync` 9% (the two output proofs, 2,000 stats,
chosen sync by the 2026-09-09 A/B: 100 → 54 ms on the run-graph
stage), `findConfigFile` 5%, `bun:sqlite` query 3.5%, package graph
2.5%, `hashProjectPackageJson` 2.4%, then a long tail under 2%. No
new hot spot: every frame over 2% is a measured decision already
recorded (discovery 8(e), the proofs' sync stats, the manifest hash).
The next warm-path gain is structural (8(e)'s stat-keyed discovery
memo), not a frame.

**Warm path after item 46 (2026-09-10).** Interleaved A/B, 1,000
projects, twelve reps, both orders, base = the immutable c0b20ca
worktree: main min 225 / med 242 ms vs head 231 / 246 in one order,
head 221 / 233 vs main 222 / 232 in the other — a tie inside
run-to-run jitter, the sign flipping with the order. The reset
property read (39), the env field check (44, on the eval path only)
and the orphan scan (35, prune only) cost the warm run nothing
measurable.

**Handoff after item 45 (2026-09-10, morning).** PR #265 carries the
loop, 70+ commits; every head is green on CI except the ones a
same-day commit fixed (d295a90 timing, 1414cf2 `.mcp.json`, f549719
unformatted tables, 92e1682/f4a0d48 a doc law reading outside the
sandbox — each recorded above). The shape since item 31: the owner's
two asks (item 43's `vx lock` report and item 45's suite speed) both
resolved to measurement first — a repro that round-trips, a JUnit
timing pass — and each fix carries a pin that fails on the old code;
three probes became laws (`doc-references`, `schema-unknown-keys`,
`sandbox-hint`); the reset notice (39), the orphan sweep (35) and the
doctor's orphans row (41) close the schema-bump story end to end. The
suite runs ~95 s of test bodies across eight shards on four cores;
what remains over a second is real work (rate floods, an 87k-edge
graph, Worker spawns, ~130 end-to-end CLI spawns at ~100 ms). Start
the next session from Next § 8: (e)/(f)/(g) are open with reasons;
(c) is done for every verb but `vx lock`, on purpose. The scratchpad
harnesses (`ab2.ts` warm, `ab3.ts` cold, `abshow.ts` for `vx show`,
`junit/` for suite timing) take two worktrees and two workspace
copies; recreate the copies with the bench generator.
Next-list 8(b) decided: `--max-size` keeps reading a bare integer
as bytes — it is pinned (`cli-arg-hygiene`: `--max-size 1` is one
byte), documented as `<bytes>`, and the zero bound is the guard;
refusing unitless there would reverse an earlier call for one
footgun the docs already name.

## In flight

**Open after the sandbox arc (2026-09-05).** Local `vx run ci --all` is
green, 36/36, no violations. CI is not, and every remaining item is
either a one-line decision or a known constraint, not a mystery:

1. DONE 2026-09-09: `@vzn/vx-docs#build` on Linux CI, red since
   2026-09-05 with exit 1 and nothing on either stream. Not the
   telemetry EROFS recorded before (real, but not what exited), not the
   runner's Node. A diagnostic frame from CI (hooking `process.exit` and
   both rejection channels) said `Cannot find package 'yargs-parser'
from …/node_modules/astro/dist/cli/index.js` — astro's OWN
   dependency, unresolvable because the task's write grants under
   `node_modules` (`.astro/**`, `.vite/**`) made `punchWritePaths` bind
   node_modules' children one by one, and bwrap mounts a SYMLINKED child
   (every package in Bun's isolated layout) as the directory it points
   at, so astro sat in a plain directory with no `.bun/` siblings.
   astro's and vite's caches now live under `.astro/` (astro.config.mjs)
   and the grants follow; `punchWritePaths` warns, naming the grant,
   whenever a punch meets a symlinked entry. The build also runs under
   `bun --bun` (half the wall time; no dependency on the runner's Node)
   and the telemetry define stays.
2. DONE 2026-09-09, and the diagnosis was wrong: the four perf baselines
   did not fail from eight-way contention but from ptrace. The Linux
   sandbox wraps every task in `strace -f -e trace=openat`, and without
   `--seccomp-bpf` strace stops the tracee on EVERY syscall and filters
   in userspace, so a stat-heavy micro-benchmark ran 2.5–7× over
   budget. Reproduced outside the sandbox: plain `bun test` 24/24, the
   same four fail under strace, 24/24 again under `--seccomp-bpf`. The
   flag is on (strace ≥ 5.3; older gets the slow form), which also
   takes that tax off every other sandboxed task on Linux — the gate's
   `time 138s · max 89s` on the last run is the number to compare.
3. DONE 2026-09-10 (item 79): a sandboxed task exposes a port on Linux
   through `allow.localBinding: [port, …]` — a per-port socat pair over
   a unix socket in the sandbox tmpdir, the task's side in front of the
   command, the host's side released when the task exits. The arming
   went as this entry said (the unix-socket allowance from the run's
   union at `initSandbox`), and found the reason the first probe still
   died: on Linux the availability probe initializes SRT with an EMPTY
   config and `initialize()` returns early ever after, so the run's own
   call — the domain union included — never reached the runtime.
   `initSandbox` now hot-reloads the run's config (`updateConfig`).
   Was: macOS works and is properly gated; on Linux every sandboxed task
   gets `--unshare-net`, so nothing saw the port.
4. DONE 2026-09-09: persistent tasks run inside their `exec.sandbox`.
   `wrapSandboxedCommand` is the enforcement half of `runSandboxed` on
   its own and the persistent path spawns through it; the violation
   report stays one-shot only, since it reads the trace after exit and a
   server exits at teardown. `vx-docs`'s `dev` and `preview` blocks mean
   what they say now. Pinned in the unsafe suite: a sandboxed server that
   reads a workspace-root file sees the denial, the same server without
   the block reads it.
5. **macOS violation reporting is lossy while any violation fails the
   task.** The unified log drops records under load, so the same task can
   pass or fail run to run. Enforcement is unaffected — the OS denied the
   operation either way — but the REPORT is not a reliable gate on that
   platform.

- **v0.0.18 is fully on npm; one owner step remains before the next
  release.** npm released the two held packages about ninety minutes
  after the publish: all five serve 0.0.18 as `latest` (2026-09-04
  00:20Z). `npm.yml` now publishes with trusted publishing only — no
  token read anywhere, `--provenance` explicit, the npm ≥ 11.5.1 +
  sigstore guard on both jobs, `permissions: {}` at the top, every
  action in `npm.yml` and `release.yml` pinned to a commit SHA, and the
  object-form `repository` npm was rewriting. OWNER STEP before the next
  release: on npmjs.com add the GitHub Actions trusted publisher (owner
  `vznjs`, repo `vx`, workflow `npm.yml`, no environment) to each of the
  five packages, then delete the `NPM_TOKEN` secret (it is no longer
  read; npm restricts it — v0.0.17's `E401`, v0.0.18's hold). The
  build half is PROVEN: a `workflow_dispatch` dry run of the new
  workflow (run 33812502741, 2026-09-04) succeeded on both jobs — pinned
  actions resolve, the npm ≥ 11.5.1 guard passes on macOS and ubuntu,
  all five packages build and assemble at the stamped version, and
  only the two publish steps were skipped, as `dry_run` intends. The
  auth half is proven by the next release. Documented in
  `docs/cli.md` § Releasing.

## Next (ordered)

1. **The live REAPI suites are green again (2026-09-04); the
   whole-graph run stays optional.** With OrbStack's docker back, the
   rehosted `vx-nativelink:bun-node` image on
   `tests/helpers/nativelink-exec.json5` ran all ten `@vzn/vx-reapi`
   files one process each with both endpoints set: 121 pass, 0 fail —
   the wire-level execution suite (15), the cache suite (16) and the
   `execute: true` composition proof (2) included, so the barrel
   narrowing and the by-name error classification (2026-09-03) changed
   nothing live. Not done: `vx run ci --all` of THIS repo at a worker —
   it needs a workspace that wires `reapi({ execute: true })` (none is
   checked in) and filesystem stores (the memory stores evict under a
   `node_modules` install, per the helper notes). An exercise, not a
   gap; do it when a worker-side change needs it.
2. **The remote seam still moves whole artifacts.** With save, ingest
   and restore bounded, `RemoteCacheLayer` is the last place a large
   artifact sits in memory: `put(hash, body: ArrayBuffer | Uint8Array)`
   gets the on-disk artifact via `Bun.file().bytes()`, and `get` returns
   an `ArrayBuffer` that ingest writes to its temp. Widening both to a
   `Blob` (a `BunFile` is one; bytes wrap in one) would let uploads
   stream from disk and downloads land in the temp directly — but
   `@vzn/vx-reapi` must digest the whole body before it can upload, so
   the plugin side needs a streaming digest and a chunked `writeBlob`
   first. A breaking seam change for plugin authors; do it with the
   plugins guide, the stub layers in the tests and `vx-reapi` in one
   commit, and measure a 150 MiB round trip through the stub before
   and after. Not started. Assessed 2026-09-04: the win is gated by the PLUGIN
   side — `@vzn/vx-reapi`'s wire zstd-compresses the whole body in
   memory and retries a wedged upload from it, so a core-side Blob alone
   measures nothing; streaming needs a two-pass digest and a chunked
   compressed upload through the adaptive-downgrade path. Do it when a
   real workspace uploads > 100 MiB artifacts, not before.
3. **DONE 2026-09-09 — zero-migration adoption as a plugin.** (Kept for the reasoning.)
   The Vite-shaped ecosystem lever: `plugins: [turbo()]` in a Turbo
   repo (or `nx()`) and `vx run build --all` works against `turbo.json`
   - `package.json` scripts with no generated files — a trial that
     commits nothing. The `project` stage is the right seam, and the
     mapping already exists in `migrate-turbo.ts` / `migrate-nx.ts`, but
     the seam gap that blocked it is CLOSED (2026-09-09): when any
     plugin declares `project`, a package without a config file is
     loaded as `{ tasks: {} }` for the stage to fill (pinned: a
     scripts-to-tasks plugin gives a config-less package a task that
     plans and runs; with no `project` plugin the package stays
     invisible, as before). DONE the same day: `@vzn/vx-turbo`. The
     mapper moved out of the CLI into `workspace/turbo.ts` (one mapping,
     two consumers — `vx migrate` renders it with preset splices, the
     plugin runs it live with the globals inlined), the façade exports
     it, and the plugin fills the `project` stage from it, never
     overwriting a written config. Pinned end to end over the migrate
     suite's Turbo fixture: plan shape, edges, cache blocks, inlined
     globals, second-run hits, `cache: false` uncached, hand-written
     config wins, gaps warned once. The maintenance-surface worry is
     answered by the shared mapper: there is one source of task truth
     for Turbo, and the plugin is 90 lines over it.
4. **DONE 2026-09-10 — the shipped binary's second core (item 77).**
   A compiled `vx` loading a `vx.workspace.ts` that imports `@vzn/vx`
   pulled a second copy of core from `node_modules` on every run — and
   made a binary user install the package at all. The 2026-09-03
   refutation was of `Bun.plugin`'s `onResolve` hook, which indeed
   never fires for a bare specifier imported by a dynamically imported
   user file; `build.module` — a VIRTUAL module for the exact specifier
   — does fire there (probed 2026-09-10 in a `--compile` binary: a
   plugin package's `@vzn/vx` import served from the bundled façade,
   and a workspace file with NO `@vzn/vx` installed anywhere loads).
   `registerCoreAlias` in bin.ts is that virtual module, lazy on the
   façade. The user-visible half was already
   closed (`isUserError` classifies by name across copies); the earlier
   note that the cost is NOT measurable as an A/B from a workspace file
   (2026-09-03: a workspace importing plugins by absolute source path
   also loads source, so both arms read equal, 77 vs 74–81 ms at 100
   projects) was measuring the wrong pair — the A/B is binary against
   binary, with and without the alias, on one workspace (item 77 has
   the numbers). What IS pinned since
   2026-09-10: the darwin job's bare-specifier workspace declares
   `@vzn/vx-schedule-history`, so a plugin package's own `@vzn/vx`
   import (the second copy) and the `schedule` hook it fills run
   through the compiled binary on every push — probed first by hand
   on Linux with a native `--compile` build, 12 sandboxed tasks as an
   unprivileged user. The plugins guide's "Publishing a plugin
   package" section (2026-09-10) was proven the same way before it
   shipped: a scratch `@acme/vx-thing` laid out exactly as it says
   loads and runs its sink through `bun bin.ts` and through the
   binary; delete its root `index.ts` and the binary says `cannot
find '@acme/vx-thing'` while `bun` still loads it.
5. **The watch e2e flake** — if `re-runs the task after a file change,
then exits on SIGINT` times out again, keep that run's stdout: the
   presence of `re-running...` separates a lost event from a slow
   re-run (see the 2026-09-03 watch entry).
6. **Re-measure the warm run after each day's work** — the hot path is
   the product. `bun packages/vx-bench/run.ts 100 5` and `1000 5`; an interleaved
   A/B against an immutable worktree settles any gap
   (`scratchpad/ab.ts`-style: alternate arms, min and median of N).
   REFUTED 2026-09-10 (afternoon), recorded so nobody re-runs it: a
   synchronous restore for small artifacts. The restore path makes
   ~8 `node:fs/promises` round trips per one-file artifact (exists,
   read, realpath, mkdir, write, chmod, utimes, rename), and a
   `restore: exists / rows / extract` span set (kept) showed the
   extract as the whole cost; the sync form measured 2× faster ALONE
   (sequential in-process restore of a 40-byte `dist/out.js`, median
   1.25 → 0.62 ms against 0.52 for the bare syscalls) and 30% SLOWER
   in the run (compiled binaries, three interleaved rounds on the
   1,000-project bench: `warm, restore` 1,176 / 1,110 / 1,218 ms →
   1,539 / 1,506 / 1,493), because four workers overlap their round
   trips and a blocking one stalls the other three. The lead left:
   `restore: rows` re-selects the output rows the batched probe
   already loaded (21 ms per 1,000, ~2%); threading `hit.outputRows`
   through needs a contract change for a row nobody sees.
   Closing figures for 2026-09-10, evening (the same container,
   `run.ts` medians of 5, after items 81–82): source form 100 projects
   123 ms warm / 181 restore / 369 cold; 1,000 projects 240 / 1,163 /
   2,519 — against the afternoon's 115 / 197 / 408 and 265 / 1,381 /
   2,988: the restore row −16% and the cold row −16% at 1,000, which
   is the restore lane and the save lane on the headline bench, and
   the warm row within the box's jitter (nothing touched it).
   Closing figures for 2026-09-10, afternoon (the same container,
   `run.ts` medians of 5, after items 70–80): source form 100
   projects 115 ms warm / 197 restore / 408 cold; 1,000 projects 265 /
   1,381 / 2,988 — the 1,000 warm read high against the morning's
   229, so it was settled as the A/B the box needs: main before this
   session (264f01a) against the head, BOTH as compiled binaries
   through `VX_BIN`, three interleaved rounds — warm no-restore
   246 / 251 / 235 vs 250 / 212 / 201 ms, restore 1,510 / 1,297 /
   1,186 vs 1,241 / 1,230 / 1,308, cold 3,423 / 3,128 / 3,432 vs
   3,465 / 3,180 / 3,157. A tie or a win in every column; the lone
   265 was the box. (Items 70, 71 and 77 moved surfaces this bench
   does not exercise — a sandboxed gate, the first warm run after a
   cold one, a plugin-bearing binary — and each carries its own A/B.)
   Closing figures for 2026-09-10, morning (the same container, `run.ts`
   medians of 5, after the three package moves and the CI work): 100
   projects 118 ms warm / 182 restore / 394 cold; 1,000 projects 229 /
   1,206 / 2,758. No core warm-path change landed today — the moves
   ran nothing on `vx run` — and the figures sit on yesterday's within
   the box's jitter.
   Closing figures for 2026-09-09 on a noisy 4-core Linux container
   (late, after the improvement loop's 25 items): head vs main
   (c0b20ca), 1000 projects, both orders, min 296/304 and 302/295 ms,
   20 reps 310/313 — within run-to-run jitter, no `VX_TIMING` stage
   moved (loop item 25). Every warm-path step was A/B'd at its commit.
   (not the owner's box — compare against 2026-09-04 only by ratio):
   `run.ts` medians before the day's perf commit, 100 projects 109 ms
   warm / 180 ms restore, 1000 projects 281 / 1337; the commit's A/B is
   in the review entry. LEADS from the profile, not taken: (a) each
   `vx.config.ts` is stat'ed twice on the warm path — `findConfigFile`
   in discovery and again for its identity in the config load;
   threading the discovery stat into `hashFiles` saves ~1,000 stats.
   REFUTED on the cheaper half (2026-09-09): making discovery's stat
   synchronous ties (interleaved, 8 reps: min 57.6 vs 62.5 ms, median
   68 vs 67) because the async stats overlap the package.json reads.
   TAKEN another way the same day: on Linux each async stat is a
   thread-pool round trip and a `.mjs` config pays four of them per
   project, so one readdir per project dir replaces them there (12 ms
   against 43 at the last name, a tie at the first; the macOS stat loop
   stays, measured the winner there on 2026-09-03). Discover projects
   65–79 → 29–34 ms; whole process interleaved both orders, 10 reps:
   min 318 → 304 and 328 → 292 ms, median 368 → 325 and 358 → 320;
   (b) TAKEN 2026-09-09: the hit path's `output dirs` + `output stat`
   are ~2 stats per task and inherent to the proof, but they were
   thread-pool round trips; synchronous, the run graph stage halved
   (review entry); (c) TAKEN 2026-09-09: `record history` was ~10 ms
   on an empty table and 57–79 ms at 166k rows because of the
   (project, task) index; dropped (review entry). Remaining on the
   profile after both: discovery's async stat (42 ms native self time
   at 1,000 projects, the one lead (a) above leaves), and the history
   reader's slice scan for plugin users (~1 ms per 1,000 rows); after
   the readdir change, discovery's remaining cost is the manifest reads
   themselves. Closing figures for 2026-09-04 (load 5.7, best of 5): 1000
   projects 159 ms warm / 538 ms with restore, 100 projects 66 ms /
   104 ms — the sandbox and CI work touched nothing the warm path
   runs. Closing figures
   for 2026-09-03, after wave 6 and the discovery change, best of 5:
   1000 projects 193 ms (table says 204, measured before discovery
   changed), 100 projects 81 ms, on a box that had run the gate all day.
   Floors on the 1000-project bench (in-process, 2026-09-03): discover
   20 ms, load configs 21–23, git enumeration 21–47 exposed (the walk's
   own noise), classify + probe 23, run graph 19–21, record history
   11; total 151–184. What is left is the git walk (~60 ms, exposed by
   whatever it fails to overlap), 1,000 task hashes (11 ms), 1,000 file
   and directory stats (18 ms), 1,000 manifest reads (10 ms) and the
   batched inserts (4 ms after `runs_hash` went). The next real win is
   structural (not needing a walk), not another stage shave; fsmonitor,
   untracked cache and `-unormal` are refuted (see Shipped).
   COLD floors (same bench, cache wiped, `VX_TIMING=1` — the miss path
   carries spans since 2026-09-03): 2.06 s wall for 1,000 `echo` tasks at
   concurrency 10, i.e. ~20 ms per task-slot: execute 13.8 ms, save 3.6,
   resolve outputs 1.4, clean 0.6, task hash 0.01; cold config load 340
   ms (1,000 evaluations, no eval cache yet). Of the 13.8, the shell IS
   the floor on macOS: bare `sh -c 'echo built'` costs 9.2 ms per slot
   at 10 concurrent against 2.5 for `/bin/echo` spawned directly
   (stable over three rounds; `runCommand` adds 0.2 over the bare
   spawn). LEAD, not taken: spawning a shell-free command (`tsc -b`,
   `vitest run`) directly would save ~7 ms per task-slot on macOS and
   ~0 on Linux (dash starts in ~1 ms), against the principle that the
   shell is the API — PATH order, builtins, `command not found` → 127,
   scripts without a shebang all have to read identically. The headline
   shape's tasks use `&&`, so its rows would not move. Decide with the
   owner. The save's 3.8 ms splits (spans `save: *`): pack 1.25, write
   temp 0.63, rename 0.55, scan 0.46, index tx 0.17. Two trims measured
   as not worth their code (< 1 ms per task together, ~0.15% of the
   cold row): a synchronous compress for tiny buffers, and indexing a
   locally built artifact from its plan instead of re-scanning it.
   `vx watch` start on the same bench: the initial run plus a sweep of
   all 1,000 configs (repeat loads through the worker) — the sweep is
   35 ms, no visible pause.

7. **First-run DX follow-ups (candidates, from the 2026-09-04
   walkthrough).** (a) DONE 2026-09-09: `--summarize` task rows carry
   `noCache: true` for a task with no `cache` block (present only when
   true; documented in `docs/cli.md` § --summarize). (b) DONE 2026-09-04: `init` no longer makes `lint` wait for `build`
   (`test` / `typecheck` still do, the Turbo starter's convention). (c) watch still pays one redundant cycle on a
   task's first undeclared write (the bytes are unknown until seen);
   hashing what the cycle wrote before re-arming would zero it — only
   if a real workspace shows the cycle mattering. (d) DONE 2026-09-04: a filter set that matches nothing is one
   error line naming the patterns and the nearest project name.
8. **Improvement-loop candidates (2026-09-09, in order).** (a) DONE as
   item 16 (`orchestrator/miss-save.ts`, behind the differential pin;
   the hit path followed as item 63, `hit-restore.ts`). (b) DONE 2026-09-10: `vx cache prune --max-size 10` is refused
   with the unit it wanted (`10M, 10G`); `10B` still passes, and
   `parseSize` keeps its bare-bytes contract for the computed
   `--memory` budgets. The zero guard speaks first for every zero
   spelling, as its pins require. (c) Anything else that reads config
   files raw: only `vx lock` remains, on purpose (it freezes the
   file's own evaluation). Grep for `loadProjectConfig(` before
   adding a fourth consumer of the staged load. (d) `logger.ts` (716)
   and `framed-output.ts` (528) are the last large files; split only
   if a concern separates as cleanly as the three splits today did
   (assessed 2026-09-09: neither does — one renderer, one formatter).
   (e) Discovery is the largest fixed cost a warm run pays before any
   task: `listProjects` reads 19–28 ms for 1000 packages (2026-09-09,
   isolated). The manifest reads are 3–5 ms of it (async `Bun.file`
   wins over `readFileSync` 3.4 vs 6.3 ms, re-measured — the comment
   in workspace.ts stands); the rest is the member glob, the config
   probe and the loops. A memo keyed on each member directory's stat
   would skip the reads on a warm run, but a directory mtime does not
   move when a file INSIDE it is rewritten in place, so the key would
   have to be the manifest's own stat — one stat per package, which is
   most of the cost already. Do it only with a measured design.
   Measured 2026-09-10 on the pre-warmed 1,000-project copy, min of
   seven, all in flight: today's per-package I/O (readdir + manifest
   read + `JSON.parse`) is 8.6 ms; the memo's key (a stat of the
   directory — entries added or removed — and a stat of the manifest)
   is 3.3 ms async, 2.8 ms sync. But the memo must hand plugins and the
   package graph the whole manifest, so it stores the parsed JSON and
   parses it back — the `JSON.parse` share stays — and reads 1,000
   rows from SQLite (~1 ms). Net ≈ 3–4 ms of a 230 ms run for a second
   staleness surface (directory mtimes across platforms). REFUTED as
   not worth it; revisit only if discovery's share grows.
   (f) DONE 2026-09-10 as item 75: `--cache-dir` on `vx why`, `vx
   last`, `vx info` and `vx cache prune`, through one parser and one
   resolver. Was: a `vx run` flag only, leaving the reading verbs on
   the default directory.
   (g) `vx why` names a plugin `key` part but shows its digests
   (`plugin tool/node-major a2d9… → e893…`), because `entry_inputs`
   rows reduce every value to a digest — right for env values, which
   can be secrets, but a plugin's own material (`node-major: 22`) is
   what its author wants to read. Assessed 2026-09-09: a new column
   means a SCHEMA_VERSION bump, and a bump DROPS every table — every
   user's cache and history — for a nicety; storing the raw value in
   the `hash` column for `plugin` rows needs no bump but persists
   whatever a plugin returned (a secret, if a plugin ever folds one).
   Neither is worth it today; revisit when a plugin's part is the
   thing people debug.
   (h) DONE as item 58 (the weighted deal). Was: shard balance
   (measured 2026-09-10, after item 45): `bun test
--shard` splits by file count, so shard 5 carries `output-memory`
   (a 4 s rate measurement that spawns RSS probes) plus `task-timeout`
   and runs 18 s wall while the others run 5–13 s — the critical path
   when the shards run in parallel. Giving the memory probe its own
   task (every shard adds it to `--path-ignore-patterns`; one task
   runs the file alone) would cut the path to ~13 s. Nine config
   edits and a CLAUDE.md line for ~5 s; do it when the next slow file
   lands in the same shard, not before. Refuted alongside: pre-bundling
   the CLI for the ~130 end-to-end spawns. One `bun bin.ts --version`
   costs 45–47 ms (bun's own start is 4 ms); a `bun build
   --target=bun` bundle of the same entry costs 83–90 ms, slower, as
   the flag-less compile was in item 32, and the `--bytecode` form's
   ~17 ms gain would buy ~2 s of suite for a build step in every test
   run. The spawns stay on source.

9. **Handoff after item 79 (2026-09-10, afternoon).** PR #269 (items
   70–77: perf — lazy sandbox, run-end snapshots, one core per process;
   complexity — the layer contract, the outcome vocabulary, the CAS
   substrate; DX — six CLI asks) merged into main as dba8f49 by the
   owner at 13:10Z. PR #270 holds items 78–82 (the façade trim, the
   Linux port bridge, completions, the restore lane, the save lane) on the same branch with main merged back in; it
   merges on the owner's word, never on ours.
   What a fresh session should know: (a) the warm floor is measured
   and recorded three ways in items 76–77 — module load and the git
   walk are what remain, and the compile flags are the right ones;
   (b) the façade is 34 runtime exports and a consumer widens it with
   the pin; (c) § In flight 3 — a sandboxed task exposing a port on
   Linux — closed as item 79 (`localBinding: [port]`, a socat pair per
   port), and the same item fixed the run's config never reaching SRT
   after the Linux probe; what remains in § In flight is a platform
   limit (macOS violation reporting is lossy, item 5); (d) the
   sandboxed check-in clone at `/home/user/sandbox-home/vx` is the
   way to measure this repo's own gate as an unprivileged user, and
   every A/B in items 70–77 ran there.
10. **Handoff after item 67 (2026-09-10, night).** The loop's Next
    items are spent; what a fresh session should know, in order:
    (a) PR #265 merged into main (d96a06f) and PR #266 (items 65–68
    and the day's follow-ups) merged as e099265, both by merge commit —
    the branch cannot be rebase-merged, and it restarts from main after
    each merge (a fast-forward; the next work opens a new PR).
    Schedule-history, migrate and prune left core, which went from 125
    files / 1,225,063 bytes under `src` to 119 / 1,172,583. Core's
    verbs are run, watch, cache, lock, init, upgrade, show, info, why,
    last; `src` holds no plugin.
    (b) The suite's floor is processes, not timers (the paragraph after
    item 58). The one lever left is converting the nineteen
    CLI-spawning suites (~250 cases at 91 ms) to in-process calls where
    process semantics are not the claim — about 14 s of file time,
    ~1 s of wall on twelve shards; do it only if a box with many cores
    shows the wall pinned by them. The gate on four cores is 15.7 s;
    the whole test graph under the REAL sandbox as an unprivileged user
    (twelve shards, the unsafe suite, eleven package suites) reads
    44 s, three reps 24/24 on 1bce329 — no flake at twelve-way
    concurrency behind bwrap.
    (c) DONE 2026-09-10: the darwin CI job's four slices run side by
    side (3 min 8 s sequential before). The canary step runs AFTER the
    test step and the sandbox suites are class-gated there, so the load
    lands on nothing `sandbox-exec` enforces; the canary stays the gate
    that would say otherwise. Measured on 2a2e693: the test step 73 s,
    the job 1 min 36 s, the canary 20/20 — the PR's CI wall went from
    ~3 min 10 s to under 2 min, and the Linux gate is the longest job
    again.
    (d) `executeCachedTask` (execute-task.ts, ~440 lines) is dense
    policy — probe, hash, clean, exec, save — with no clean seam left
    after the hit and miss paths moved out; leave it whole.
    (e) `run()` is 895 lines; the run-context record (25 lines of
    literal assembly) is the last cohesive block, and moving it buys
    nothing a reader needs. Stop slicing there.
    (f) Warm path: no lead in the stage table (the two refuted probes
    after item 61); the discovery memo and pre-bundling stay refuted.
    Superseded 2026-09-10 by items 70, 71 and 77: the lazy sandbox, the
    run-end snapshots and the core alias were all vx changes the stage
    table did show once read on the right workspace (this repo's own
    gate under the real sandbox, the binary rather than `bun bin.ts`).
    (g) Capabilities worth a design before code: streaming artifacts
    through the remote seam (Next 2, gated by the plugin side), and a
    `serve`-shaped embedder built OUTSIDE this repo on the façade
    (the seams are in place: `inflight`, `remoteCache`,
    `telemetrySinks`, the wire event form).

## Decisions (this arc)

- **One core per process (2026-09-10).** The running `vx` serves its
  own façade to every `@vzn/vx` import it evaluates. A plugin package
  never carries its own copy of core into a run; the host decides the
  runtime, as any host does. Item 77.
- **The façade names only what has a consumer (2026-09-10).** An
  export written for a consumer that no longer exists is a promise
  nobody collects and a surface nobody may change; item 78 took 41
  of them off. Core keeps every function behind its module contract;
  a new consumer widens the façade deliberately, with the pin.
- **No seam without a consumer (2026-09-10).** The `CASBackend` /
  `Digest` substrate left core after three months with zero callers
  (item 74). A content-addressed view of the artifacts directory comes
  back when a plugin needs it, shaped by that plugin's use — not
  before. The same rule retired `recordRun` / `recordRuns` from the
  layer contract (item 72).
- **A plugin's name is its package name; no overrides (owner,
  2026-09-10).** `definePlugin(import.meta, hooks)` reads it and stamps
  it; the workspace loader refuses anything else. Item 69.
- **Gap audit vs Nx 23 / Turbo 2.10 (2026-09-04, owner's ask).** Core
  is at parity or ahead on every must-have a developer would miss
  (graph, filter DSL superset, affected, strict caching, env
  isolation, persistent readiness, watch, prune, migrate, init, dry /
  graph / summarize / profile). The one game changer left is
  zero-config adoption — scripts as tasks with no generated file —
  whose mapping is a `project`-stage plugin and whose core half is one
  seam widening (§ Next 3). `.env` loading, configurations, cache caps,
  graph UI, release, test splitting, boundaries: plugin or the
  language. Windows is the only must no plugin can supply; parked.
  Full table in `docs/comparison.md` § Gap audit 2026-09-04.
- **Agents removed.** `@vzn/vx-agents` (synchronizer + persistent
  workers, Nomad/K8s backends) was an in-repo distributed-execution
  product. It used only public core APIs (`run`, `createEventBus`, the
  executor seam), which is the proof the seam suffices — so it lives
  outside this repo, if anywhere.
- **Predictive scheduling removed.** Opt-in, measured at ~280 ms of
  history loading on a large cache (more than a warm run), and a
  scheduler-priority policy is exactly what a plugin hook should decide.
  The scheduler keeps its `priorities` input; a `schedule` seam will feed
  it.
- **`vx mcp` removed; `metrics.ts` trimmed.** The MCP server read the
  dashboard-era analytics queries and predictive history. An MCP server
  is a good plugin (`commands` seam), not core. The queries `vx why` /
  `vx last` need stay in `metrics.ts`; the rest went.
- **`vx why` / `vx last` stay.** Cache-miss explainability is a core
  promise; both read the local run history core already writes.

## Legacy map (what the old memory called things)

- `docs/design/decision-log-archive.md` held the full 2026-05→08 log; it
  is deleted from the tree (git history: `git log -- docs/design/decision-log-archive.md`).
- "waves" = the old audit cycles. Their standing rules survive in
  `CLAUDE.md` § Rules.
