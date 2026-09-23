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
`docs/history/2026-09-review-arc.md` on 2026-09-10, items 65–104 to
`docs/history/2026-09-improvement-loop-65-104.md` on 2026-09-11, and
items 105–144 to `docs/history/2026-09-improvement-loop-105-144.md` on
2026-09-16 (with the Next list's record to
`docs/history/2026-09-status-next-log.md` the same night), and items
145–202 to `docs/history/2026-09-improvement-loop-145-202.md` later
that day (the 2026-09-10 measurement paragraphs to the 65–104 file, and
handoffs 14g–14i to the next-log file), and items 203–242 to
`docs/history/2026-09-improvement-loop-203-242.md` that night (handoffs
14j–14p to the next-log file), and items 243–281 to
`docs/history/2026-09-improvement-loop-243-281.md` that afternoon
(handoffs 14q–14v to the next-log file), and items 282–305 to
`docs/history/2026-09-improvement-loop-282-305.md` that evening
(handoffs 14w–14y to the next-log file), and items 306–332 to
`docs/history/2026-09-improvement-loop-306-332.md` late that night
(handoffs 14z–14ad to the next-log file), and items 333–352 to
`docs/history/2026-09-improvement-loop-333-352.md` on 2026-09-19, and
items 353–372 to
`docs/history/2026-09-improvement-loop-353-372.md` that night
(handoffs 14ae–14af to the next-log file), and items 373–392 to
`docs/history/2026-09-improvement-loop-373-392.md` on 2026-09-20
(handoff 14aj to the next-log file), and items 393–412 to
`docs/history/2026-09-improvement-loop-393-412.md` later that day
(handoff 14am to the next-log file), and items 413–432 to
`docs/history/2026-09-improvement-loop-413-432.md` on 2026-09-20
(handoff 14an to the next-log file), and items 433–452 to
`docs/history/2026-09-improvement-loop-433-452.md` on 2026-09-20
(handoffs 14ao–14ap to the next-log file), and items 453–572 to six
files of twenty, `docs/history/2026-09-improvement-loop-453-472.md`
through `-553-572.md`, on 2026-09-22 (item 573), and items 573–591 to
`docs/history/2026-09-improvement-loop-573-591.md` later that day
(handoffs 14aq–14au to the next-log file, item 592), and items 592–611
to `docs/history/2026-09-improvement-loop-592-611.md` on 2026-09-23
(handoffs 14av–14ax to the next-log file, item 612), so
this file stays the handoff
and not the log; numbering continues from there. Keep
it that way: when the loop below passes forty items, move the oldest
batch there in one commit, and move a Next entry's record the same way
once it is closed.

## Improvement loop (2026-09-09, after the review pass merged)

Open-ended, owner-delegated: find flaws, widen seams, sharpen DX,
refactor toward cleaner layers. One coherent commit per step, gated,
recorded here as it lands. Layer map measured first (imports between
`src/<module>` directories): util ← workspace ← cache, exec ← graph ←
orchestrator ← cli, `config.ts` a leaf, no back edges — the boundaries
test is telling the truth.

612.  DONE (2026-09-23, the trim the loop reached twenty at). Items
      592–611 moved to `docs/history/2026-09-improvement-loop-592-611.md`
      and handoffs 14av–14ax to the next-log file in this commit. What
      that loop was: the Nx surface finished (`nx()`, `nx-exec`, the
      mapper's rules, the guides and their walks, the migration path on
      real Nx 22), the plugin-cost arc closed by measurement (608–610:
      the stage reads 51–59 ms at 1,000 projects against ~24 for
      evaluated configs, and the per-task floor is Nx's own, 611), and
      two simplifications with no behaviour in them (606, 611). Next
      trim at 632.
613.  DONE (2026-09-23, 611's sweep finished and made a law). The rest
      of the repo: 12 more values in core (`describeSandbox`,
      `renderInfo`, `restoreTierExclusions`, `MIN_PLAUSIBLE_PEAK_BYTES`,
      `outputContainer` — exported, imported by nothing, on no module's
      index), five in the test helpers, the shard dealer and the bench,
      and one dead helper (`insideSandbox`, a sandbox gate nothing gated
      on). The hand sweep missed core the first time (a shell loop that
      printed nothing), which is why it is
      `tests/exports-referenced.unsafe.test.ts` now: every exported
      VALUE outside an index, a bin or a framework's config file is
      named by another code file, or the law says which is not
      (differential: re-exporting one helper fails it by name). Types
      are not in it, and the first draft that had them taught why: 15
      option and result interfaces are the module pages' documented
      surface and `PersistentConfig` is the schema doc's, two pins that
      hold whether or not another file names the type — so a type in an
      exported signature stays exported, and `cli-watch.md` stops
      listing `outputContainer` as surface. Found alongside and fixed:
      `test.bun.unsafe` keyed on this package's files alone while eight
      of its laws read every package, the workflows and the root — an
      edit elsewhere left the suite an up-to-date hit in a warm gate. Its
      inputs declare them now (`workspaceFiles`); the key costs 13 ms.
614.  DONE (2026-09-23, the sweep's second shape: what core reads from
      the environment against what a user can find). Core reads eight
      `VX_*` names; two were documented nowhere a user looks
      (`VX_WATCH_POLL` in two history files, `VX_CONFIG_WORKER_TIMEOUT_MS`
      in a code comment), `vx watch`'s poll fallback — the 2 s probe, the
      250 ms poller, the notice — was in no page at all, and the forced
      poller announced nothing. Now: `docs/cli.md` § "Environment
      variables vx reads" (one row per name: value, default, effect,
      the fallback-not-clamp rule each timeout keeps) and § `vx watch` ›
      "How changes are seen"; `VX_WATCH_POLL=1` prints its one line like
      the fallback does, and a `watch-loop` row proves the polled loop
      re-runs on an edit and says so. The pin
      (`tests/env-doc-drift.test.ts`) reads the `process.env` sites
      themselves — literal and through the `_ENV` constants, which is
      how `VX_RUN_WORKSPACE` and `VX_RUN_TASK` were found read back for
      the nested-run refusal — and holds the table to them in both
      directions (differential: a ghost row fails it by name). The site
      guide of the same name is a task's `exec.env` model; the section
      title says which side it is.
615.  DONE (2026-09-23, the cold path measured and its one hot spot
      cut). A cold run at 1,000 projects (`.vx` removed) profiled 24 %
      in `spawn` (the tasks) and 18 % in SQLite's `run`; a preload that
      tallies statements found 14,023 of them, and three tables written
      once per config in autocommit — `config_evals`, `config_closures`
      and the `file_hashes` memo the slow path wrote while keying — each
      insert its own transaction. Microbenchmark: 1,000 such inserts
      180–240 ms, the same in one transaction 2.5 ms. Now the loader
      collects what a round learned and writes it once per table at the
      end, in `finally` (`ConfigEvalStore.putConfigEvals` /
      `putConfigClosures`, optional, one transaction each; a store
      without them is given the entries one by one), the slow path keys a
      closure file from the bytes it already read to scan it
      (`hashBytes`, no memo row — the first warm load builds the memo in
      `hashFiles`' one transaction), and the closure upsert is prepared
      once, not per call. Interleaved A/B on the same workspace, five
      reps, `.vx` removed before each: `load configs` cold 507–607 ms
      before, 207–272 after (min 507 → 207); the whole cold run
      2,938–3,420 → 2,680–2,997 (min −258 ms, 9 %). The warm path does
      not touch these writes, so it has no arm. Rows: a round lands in
      one batched call per table with the bytes-keyed slow path (fails
      on main: 0 batched calls), the batched puts honour the write axis,
      `hashBytes` is `hashFile` of the same bytes with no row. No
      `CACHE_VERSION` bump: the stored bytes and the keys are unchanged.
      Alongside: 614's pin asked `git ls-files` from inside a sandboxed
      shard, which has no git, and darwin CI failed on the empty set —
      it walks `src` now (a law that reads the tree reads it; git is for
      the unsafe suite). And `sandboxReportingReliable`, the darwin gate
      whose pins went with `--verify`, is gone: oxlint named it once 613
      un-exported it.
616.  REFUTED (2026-09-23, the next cold-path lead measured and put
      back). After 615 the cold profile's largest per-save span was
      `save: scan`, 0.67 ms summed per task: a local save decodes the
      artifact it just packed to read its rows out of the bytes, the way
      an ingest must. Indexing the save from its pack plan instead (the
      sidecar is written from the same stats) was built, with a law that
      a save's rows, a scan of its bytes and an ingest of them agree —
      and the interleaved cold A/B, five reps, read run graph 2,198–2,503
      ms before against 2,134–2,460 after (min −64, medians −56), the
      whole run 2,635 → 2,573 at the minimum: 2–3 %, a tie on a box that
      resolves nothing under 6 %. The 700 ms the span summed was I/O
      overlapped under four workers, not cost. So the decode stays — it
      is the save path's own check that the bytes on disk are an
      artifact — and the law stays as
      `tests/save-index-from-plan.test.ts`, holding the agreement the
      design already promises. Recorded alongside, measured and not
      taken: the run-end output-dir snapshots are one transaction per
      task (69 ms at 1,000 on a restore run, 49 cold); batching them is a
      `CacheLayer` seam change for a stage that small. And
      `synchronous = NORMAL` is already set, so an autocommit here is a
      WAL append, not an fsync — 615's win was the count, not the sync.
617.  DONE (2026-09-23, three rules the morning taught, in CLAUDE.md's
      list: a stage's SQLite cost is its statement count before its
      sync mode, with the tally preload (`packages/vx-bench/sqlite-tally.ts`
      now, beside `profile-summary.ts`) and its one trap; a summed span
      is not a cost until the wall is A/B'd; a sandboxed shard has no
      git). Handoff 14az with it; Next 6 carries the cold-path number.
618.  DONE (2026-09-23, 614's sweep turned on the plugins, and the
      spelling it missed). `@vzn/vx-reapi` reads three variables through
      `Bun.env`, which 614's pin and sweep did not spell — a negative
      grep is a claim about every spelling — and one of them,
      `VX_REAPI_EXECUTE=1`, was named nowhere a user looks. Now: the core
      pin matches both spellings (core reads none through `Bun.env`,
      `exec/sandbox-runtime.ts` says why, and the plugin reads through
      `process.env` for the same reason); the README names the execute
      switch beside the endpoint and instance; and
      `tests/readme-env.test.ts` in the plugin holds its README to its
      source both ways (differential: the sentence removed fails it by
      name). The other plugins read no `VX_*` at all (the GitHub plugin
      reads `GITHUB_STEP_SUMMARY`, named three times in its README).
619.  DONE (2026-09-23, the `vx mcp` walk and two small finds). The MCP
      server walked as an agent would, newline-delimited JSON-RPC over
      stdio from this repo: `initialize` answers with the protocol,
      the six tools list with their schemas, `getWorkspaceInfo` and
      `listTasks` answer for all ten projects and 85 tasks, a wrong
      argument shape and an unknown tool each come back as an
      `isError` result naming the problem, nothing on stderr. Nothing
      off. Found alongside: the tally preload's summary is written
      with `writeSync` (a buffered stderr write on the exit path is
      what item 175 says Bun drops), and its usage line carries the
      `./` a bare `--preload` path needs — Bun resolves it as a module
      specifier and reported the file not found. And the site's
      environment-variables guide, which is a TASK's env model, now
      points at the CLI reference's table of what vx itself reads.
620.  DONE (2026-09-23, the README shape turned on `vx mcp`, and where
      it stops). `packages/vx-mcp/tests/readme-tools.test.ts` holds the
      README's tool table to `listTools()` in both directions
      (differential: a row removed fails it by name); the table was
      right, and stays right. The same shape tried on every plugin's
      index found 28 exports no README names — `digestOf`,
      `renderJobSummary`, `pnpmLock`, `handleMessage` — which are the
      packages' test hooks and internals riding their public index,
      not documentation gaps. Whether a plugin's index should carry
      only what a workspace calls is a decision for the API pass before
      0.1.0 (the notes in `docs/history/release-0.1.0-notes.md`), not a
      pin; recorded here so the next sweep does not re-find it.
621.  DONE (2026-09-23, the CLI's refusals held to their words). A sweep
      of every `vx <verb>: …` line core writes to stderr against the
      tests found four a user meets with no row naming them: `vx cache`
      with no subcommand, the picker's `invalid selection: <answer>` (a
      word and an out-of-range number, each named), `no tasks declared
in any project` when the menu would be empty, and the non-TTY
      refusal — `missing task name (stdin is not a TTY)`, which the
      existing row matched only by its first half, so a CI user asking
      why nothing was asked would have found no test of the answer.
      Rows in `cli.test.ts` and `cli-picker.test.ts`. Two of the
      remaining lines are unreachable from the CLI (`no projects in
scope`: an empty scope is refused earlier as "not inside a
      project" or "no projects matched"), and the three watch failure
      lines (`cycle failed`, `cannot re-read`, `cannot watch root`) need
      a fault a test would have to inject. Alongside: plan F5 is struck
      through — the trim is a duty at every twenty since 573.
622.  DONE (2026-09-23, the lead 616 declined as a seam change, done
      without one). The run-end `output dir snapshots` stage was one
      transaction per task — 1,000 commits, 47–72 ms cold and 64–75 on
      a restore at 1,000 projects. A snapshot is read by the NEXT run's
      hit check, never by the task that took it, so `OutputIndex` keeps
      the rows pending and lands them in one transaction at the first
      read, at prune (before any entry can cascade), at stats and at
      close — the deferral `accessed_at` bumps already use. Interleaved
      A/B, five reps: the stage cold 52–70 ms → 10–17, restore 64–75 →
      12–14, `close` +5 ms for the flush; net ~50 ms per cold or restore
      run, invisible end to end on this box, exact on the stage rows.
      REFUTED first: the walk's `lstat`/`readdir` through the async pool
      was the suspect (615's lesson), and a synchronous walk measured a
      tie (47–72 → 49–63 cold) — the pool was not the cost, the commits
      were. Row: two snapshots stay pending under a direct count, land
      together on the batch read, and a later snapshot for the same hash
      replaces its rows, again deferred.
623.  DONE (2026-09-23, the part of 620's API question that needed no
      decision). Fourteen names left the plugin indexes that nothing
      outside their package called and no README named: the REAPI
      digest helpers, the GitHub summary sink and its clamp and cap, the
      OTLP sink class and config-resolving helpers, every MCP handler
      and type (the index is `mcp()` now), and the two migration
      re-exports. Every plugin's tests import those from their files
      already, so no test moved. Three kept exports gained the README
      line they lacked (`ReapiRemoteCache`, `GithubPluginOptions` with
      `renderJobSummary`, `OtelPluginOptions`). NOT done, and the law
      draft that showed why was dropped: "every index export is named in
      the README" fails `@vzn/vx-reapi` on about fifty names — its wire
      and merkle library is a deliberate public surface documented by
      the design note, not the README, and whether it stays public is
      the 0.1.0 API decision 620 recorded. The 620 probe's count of 28
      was a shell loop that read single-line export lists only; the
      real number is in the law's output above.
624.  DONE (2026-09-23, the release notes the owner cuts from, brought
      to today). `docs/history/release-0.1.0-notes.md` was drafted at
      581 and said nothing of the Nx surface: it opens with "Nx and
      Turbo repos, unchanged" now (`nx()`, `nx-exec`, the migration
      walks, the refine and Nx 22 proofs with their numbers), carries
      615 and 622's cold-path rows under Caching, 614 and 621 under CLI,
      618, 620 and 623 under Plugins, and 613 and 617 under Internals;
      the PR count is 377, counted from `v0.0.21..main`. Closed by
      reading, from 14ba's list: `vx watch` cannot see a stale snapshot
      through the deferral, because each cycle's `run()` closes its
      cache and close flushes — the second cycle reads rows the first
      wrote.
625.  DONE (2026-09-23, the harness rows after the cold-path work — Next
      6's duty for the cold and restore arms). `bun packages/vx-bench/run.ts
1000 5` and `5000 3` on this container class: 1,000 projects warm
      239 ms (231–265), restore 906 (831–1,009), cold 2,634
      (2,418–2,814); 5,000 warm 711 (702–733), restore 3,253
      (2,993–3,630), cold 10,950 (10,896–11,547). Against the
      2026-09-20 rows of the same class: cold −16 % and −23 %, restore
      −12 % and −17 %; warm within the ±13 % spread, claiming nothing.
      Scaling at 5×: warm 2.97×, restore 3.59×, cold 4.16× (was 2.98,
      3.81, 4.51). Rows in `docs/benchmarks.md` under the second
      machine's table.
626.  DONE (2026-09-23, the head-to-head on this container class — the
      other half of Next 6's duty, against the other runners).
      `bun packages/vx-bench/compare.ts 10 5 1` here (46 packages,
      Turbo 2.11.3, Nx 23.2.1, daemons on, vx compiled): vx cold 10.29 s /
      warm 78 ms / restore 98 ms; Turbo 10.44 s / 112 / 150; Nx
      27.21 s / 754 / 711; CPU cold 755 ms / 1.38 s / 1m 2s. The
      2026-09-03 macOS warm tie (76 vs 71) is a 1.4× lead here, and
      Nx's cold run 2.6× off (was 1.9×). A different machine, so the
      page says only the ratios compare; the committed
      `packages/vx-bench/RESULTS.md` stays the owner's dev-box run.
      Block under the 2026-09-03 table in `docs/benchmarks.md`.

## In flight

**The gate's runtime (settled 2026-09-21, item 572; plan F4).** A gate
under Bun 1.4.2 is the only gate: the 2026-09-19 container shipped
1.3.11, below `engines.bun: >=1.4`, and every "flapper" of that arc — the
shard-9 SIGILL (3 of 24 reps on 1.3.11, 0 of 24 on 1.4.2), the three
recorded failing tests, the inert symlink tripwires that scored three
containment guards as survivors — was the version. `bun upgrade` is
refused there; the release asset
`github.com/oven-sh/bun/releases/download/bun-v1.4.2/bun-linux-x64.zip`
downloads through the proxy and the gate with it first on PATH is 44 of
44 green. A shard failure under 1.4.2 is the diff's. The diagnosis of
the 23-test baseline as it stood on 1.3.11 is in
`docs/history/2026-09-status-next-log.md` § "In flight as it stood
2026-09-22"; the `ci` task refusing a Bun below the floor is plan F4.

**The sandbox arc (2026-09-05) is closed.** Its four Linux items closed
by 2026-09-10 (`docs/history/2026-09-status-next-log.md`); the fifth,
macOS violation reporting being lossy under load, is a recorded decision
since item 586 (Decisions below), not an open item.

**Releases.** v0.0.21 is on npm, the four platform packages with it
(2026-09-15, handoff 14d in the history file), published through
`npm.yml`, which reads no secret and sets no token — its publish is the
OIDC exchange or nothing — so the trusted publishers on npmjs.com are in
place. The v0.0.18 record (the token's `E401`, the held packages, the dry
run of the token-free workflow) moved to the history file with the
items above.

**Launch checklist (2026-09-10, the owner's "what is needed to go
fully live").** What a public announcement needs, in order, with the
state of each:

1. DONE by 2026-09-15 (0.0.21 published through the token-free
   `npm.yml`, so the trusted publishers exist). OWNER residue: delete
   the `NPM_TOKEN` repository secret if it still exists — nothing reads
   it. Documented in `docs/cli.md` § Releasing.
2. OWNER: cut the release — the notes are drafted in
   `docs/history/release-0.1.0-notes.md` (item 581); a GitHub release with the tag is the whole
   process (`release.yml` builds and signs the binaries, `npm.yml`
   publishes with provenance). Pick the version the articles will name;
   `0.1.0` says "first real release" where 0.0.19 says "another nightly".
   The release notes are the changelog — there is no CHANGELOG file, and
   GitHub's generated notes from merged PR titles are accurate since
   every merge is one titled PR.
3. OWNER: the site's address — it deploys to
   https://vznjs.github.io/vx/ on every push to main (`docs.yml`). A
   custom domain is a DNS record plus `SITE_URL` / `BASE_PATH` env in
   that workflow (`astro.config.mjs` reads both); every internal link is
   base-relative, so nothing else moves.
4. DONE 2026-09-10: the blog and its thirty posts, README and site
   numbers, LICENSE holder, SECURITY.md, CONTRIBUTING.md (items 115,
   116, 118).
5. OWNER, optional: enable GitHub private vulnerability reporting
   (Settings → Security) so `SECURITY.md`'s instruction is live; issue
   templates are not needed for a first announcement.
6. DONE 2026-09-16 as item 226: the site's introduction has a
   "Known limits" section — Bun ≥ 1.4 for source installs (the binary
   needs nothing); Linux sandboxing needs `bubblewrap`, `socat` and
   `ripgrep` (the third named 2026-09-16, item 246) and cannot run as
   root inside a container; Windows is WSL; macOS
   violation reporting is lossy under load (In-flight 5); the remote
   seam moves whole artifacts in memory (Next 2, fine below ~100 MiB);
   a task's replayed output is its first and last 8 MiB (229); a project
   inside a submodule is enumerated by its own repository (221). An
   article links it.

## Next (ordered)

0. DONE 2026-09-10 as item 87 (history) — core has no `build`; dependants stop compiling the release binaries.
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
3. DONE 2026-09-09 as item 88 → `@vzn/vx-turbo` (history) — zero-migration adoption as a plugin on the `project` stage.
4. DONE 2026-09-10 as item 77 (history) — one core per process; the shipped binary serves its own façade to every `@vzn/vx` import.
5. DONE 2026-09-11 as item 148 — the watch e2e flake was the arm
   instant on the wrong clock; the macOS intermittent extra cycle stays
   recorded under item 130.
6. **Re-measure the warm run after each day's work** — the hot path is
   the product. CI wall time is the other number this duty carries
   (plan I2): 2:23–3:16 per push run on main over 2026-09-21's eleven,
   all three jobs; a run past six minutes is the signal to fold the
   heaviest witness files onto a shared fixture. `bun packages/vx-bench/run.ts 100 5` and `1000 5`; an interleaved
   A/B against an immutable worktree settles any gap
   (`scratchpad/ab.ts`-style: alternate arms, min and median of N).
   The closing figures of 2026-09-03 → 09-10 and the refutations
   recorded under this duty (a synchronous restore for small
   artifacts, discovery's stat memo, the `restore: rows` lead) are in
   `docs/history/2026-09-status-next-log.md`; the latest day's A/B is
   item 285 (2026-09-16, a tie; 274 was the one before), and the
   restore arm's floor is the note under item 193 (history). 2026-09-16, after item 225: 5,000 projects
   687 ms warm / 2,854 restore / 12,152 cold (medians of 3) against
   1,000's 231 / 718 / 2,436 — the warm stage table grows 3.4–3.9× for
   5× the projects (discover 23 → 89 ms, load configs 24 → 87, classify
   56 → 190, run graph 42 → 144), git's own enumeration 6× (9 → 55),
   nothing super-linear; the fixed ~30 ms of startup and workspace
   config is what makes 5,000 cheaper per project than 1,000. PARKED for
   the 2026-09-19 arc (items 341–362): it changed docs, comments and
   tests only, so there is no run-path delta to A/B, and the arc ran on
   a shared 4-core container whose own baseline fails 23 tests for
   environmental reasons — an absolute figure from it is not comparable
   to the table above, and an A/B has no arms. Re-measure on the first
   run-path change. REFRESHED 2026-09-20 (item 420): this container, at
   1,000 projects, reads warm 271 ms / restore 1 031 / cold 3 147, and at
   5,000 warm 807 / restore 3 931 / cold 14 181 — the dev box's figures
   below are a DIFFERENT MACHINE and only the 1k→5k scaling (×2.98 warm
   here against ×2.97 there) compares. The harness's warm arm spreads
   ±13 % on identical code. UNPARKED 2026-09-20 (item 404), with the
   container's own noise floor measured first: interleaved min-of-7, one workspace
   copy per arm pre-warmed by that arm, 1,000 projects warm all-hit —
   the A/B read 232.1 ms before against 218.9 ms after, and the A/A
   CONTROL (the same arm against both copies) read 246.4 against
   259.0. A 12.6 ms spread between identical code is the same size as
   the 13.2 ms "difference", so this box resolves nothing below about
   6 % even at min-of-7. Absolute figures here, for the record and not
   for the table: 1,000 projects warm 194–204 ms total
   (`bun packages/vx-bench/run.ts 300 3`: no-cache 987 ms, warm
   172 ms, warm-restore 329 ms). Any future claim on this container
   needs an A/A control beside it. 2026-09-22 (item 580), the sweep week
   (items 342–572, PRs #488–#681) as one arm: base 164.7 ms, head
   167.8 ms warm min-of-15 at 1,000 projects, A/A 170.1 against 169.2 —
   a tie. Item 588 (the additive hit path, every task's): main 173.5
   against head 170.5, A/A 168.3 against 164.2 — a tie. The COLD path
   has its own number since 2026-09-23 (item 615): 1,000 projects,
   `.vx` removed, 2,938–3,420 ms before against 2,680–2,997 after, the
   `load configs` stage 507–607 → 207–272; a cold arm is five reps with
   the cache removed before each, no A/A needed at that size.

7. CLOSED — the 2026-09-04 walkthrough's four follow-ups landed
   ((a) `noCache` in `--summarize` rows, (b) `init` no longer makes
   `lint` wait for `build`, (d) an empty filter set names its patterns)
   or were measured out ((c) watch's one extra cycle on an undeclared
   write is the price of not declaring it). Record: history, next-log.

8. **Improvement-loop candidates (2026-09-09).** (a), (b), (f), (h)
   DONE as items 16/63, 8(b) 2026-09-10, 75 and 58; the measurements
   behind (e) and (h) are in `docs/history/2026-09-status-next-log.md`.
   Still standing: (c) `vx lock` reads config files raw on purpose,
   and the doctor, the selector and watch fall back to a raw per-file
   read only when the staged load throws (five call sites by
   2026-09-16, each read and confirmed against a `turbo()` workspace:
   `vx info` counts the plugin's tasks) — grep for `loadProjectConfig(`
   before adding a consumer that is not a fallback; (d) was "`logger.ts` and
   `framed-output.ts` are the last large files" — by 2026-09-16 they are
   699 and 518 lines and the largest are `cache/cache.ts` 1,583,
   `cli/watch.ts` 1,121, `orchestrator/run.ts` 1,040 and
   `exec/sandbox-runtime.ts` 1,034, each one concern (the split of
   cache.ts is item 8's), so the note is closed; (e) REFUTED: a discovery memo keyed on directory and
   manifest stats saves ≈ 3–4 ms of a 230 ms run for a second staleness
   surface — revisit only if discovery's share grows; (g) `vx why` shows
   a plugin `key` part's digests, not its material, because a raw
   column is a `SCHEMA_VERSION` bump or a persisted secret — revisit
   when a plugin's part is the thing people debug.

9. Superseded by 14 (items 70–80 landed as PRs #269–#271, 2026-09-10).
10. Superseded by 14 (items 81–95 landed as PRs #272–#273, 2026-09-10).
11. Superseded by 14 (the survey and parity rounds, items 96–111, 2026-09-10).
12. Superseded by 14 (items 102–112 landed as PRs #275–#279, 2026-09-10).
13. DONE 2026-09-10 as item 120 — `vx watch` watches the projects a cycle can run.
14. The handoffs after items 153, 130, 166, 170, 176, 183, 189, 192,
    197, 202, 208, 211, 214, 221, 225, 230, 236, 240, 242, 252, 263,
    270, 275, 281, 287, 293, 299, 305, 312, 319, 326, 332, 383 and
    394, 400, 403, 409, 412, 419, 426, 432, 441 and 452 (14–14ap) are
    in `docs/history/2026-09-status-next-log.md`; items 453–572 are in
    `docs/history/2026-09-improvement-loop-453-472.md` through
    `-553-572.md`; items 573–591 are in
    `docs/history/2026-09-improvement-loop-573-591.md` and 592–611 in
    `docs/history/2026-09-improvement-loop-592-611.md` (handoffs
    14aq–14ax in the next-log file). The loop above is the record since
    612; 14ay, 14az and 14ba are below, and the next handoff written
    here is 14bb.
15. **The plan after the sweep week: `docs/design/plan-2026-09-22.md`.**
    Fixes F1–F6, improvements I1–I7, arcs D1–D5, in the order that
    document gives (F4 → F1 → F3 → F2; F5 → I1 → I4; D3 → D1, D5
    alongside, D4 with the owner, D2 when a workspace asks). Each entry
    names its seam, the constraint that must survive, the measurement
    and what not to do; strike an entry through there when its item
    lands here.

14ba. **Handoff after item 623 (2026-09-23, late morning).** Six items
since 14az, each its own PR, merged in turn (#712 618, #713 619, #714
620, #715 621, #716 622, and 623 with this handoff): the REAPI plugin
names its execute switch and the env pins spell `Bun.env`; the `vx mcp`
walk found nothing off; the MCP README's tool table is a pin; four CLI
refusals gained the rows that name them; the run-end output-dir
snapshots land in one transaction (the stage 52–70 ms → 10–17 cold,
64–75 → 12–14 on a restore, at 1,000 projects); and fourteen internals
left the plugin indexes. WHAT STANDS: the loop holds 612–623, twelve
items, so the trim is due at 632. The cold run at 1,000 projects is
~2.7 s with the tasks' own `spawn` a quarter of it; the restore run
~0.8 s; the warm path unchanged since 589, so the warm A/B duty has no
arm; 615 and 622 changed the cold and restore paths and carry their own
A/Bs. Two decisions wait for the 0.1.0 pass: whether `@vzn/vx-reapi`'s
wire and merkle library stays on its index (623), and the owner's three
items. NEXT, in order: keep finding — the sweeps of this loop (exports,
env reads, statement tallies, refusal lines, README pins) are spent on
core and the plugins; the next shapes are a real-repo re-measure of
the cold and restore runs after 615 and 622 (refine under `nx()`, astro
under `turbo()`), and the `vx watch` cycle under the deferred snapshot
(a same-process reader flushes; is the second cycle's hit check still
a skip?); then the trim at 632; the executor-backed real tree stays for
a box with yarn 4 reachable. Never end with "what next?".

14az. **Handoff after item 617 (2026-09-23, mid-morning).** Five items
since 14ay, each its own PR, merged in turn (#707 613, #708 614, #709
615, #710 616, and 617 with this handoff): the export sweep became a law
for values and the unsafe suite's key sees every package its laws read;
every `VX_*` core reads has a table and `vx watch` says when it polls; a
config round's evaluations are written once per table and the slow path
keys from bytes — the cold `load configs` stage at 1,000 projects
507–607 ms → 207–272; and the next cold lead, indexing a save from its
plan, measured a 2–3 % tie and was put back, its agreement law kept.
WHAT STANDS: the cold run at 1,000 projects is ~2.7 s, of which the
tasks' own `spawn` is a quarter and the rest is spread (no single span
past 5 % once overlap is discounted); the restore run ~1.2 s, its
SQLite 58 ms total; the warm path unchanged since 589. The two leads
measured and not taken are in 616 (output-dir snapshot batching, a seam
change for 69 ms; the sync mode is already NORMAL). NO CORE RUN-PATH
CHANGE on the WARM path since 589, so the warm A/B duty has no arm; 615
changed the cold path and carries its own A/B. NEXT, in order: keep
finding — the sweeps of this loop (exports, env reads, statement
tallies) are shapes worth turning on the plugin packages and the site
build; the trim next at 632; the executor-backed real tree stays for a
box with yarn 4 reachable; then the owner's three items. Never end with
"what next?".

14ay. **Handoff after item 612 (2026-09-23, morning).** Seven items
since 14ax, each its own PR, merged in turn (#700 606, #701 607, #702
608, #703 609, #704 610, #705 611, and 612 with this handoff): the Nx
mapper's `buildTask` split into inputs, outputs and deps modules; three
rules in CLAUDE.md; the mapping's per-task `path.relative` hoisted and
the adoption skeleton's per-fill clone dropped (30 → 15 ms and −10 ms
at 1,000 projects, measured in isolation, since this box resolves
nothing under 6 % end to end); the warm dry-run profile with the tree
git-tracked (no core hot spot); and an export sweep of the plugin
packages (21 keywords, one dead function). WHAT STANDS: the plugin-cost
arc is closed — the `nx()` stage is 51–59 ms at 1,000 projects against
~24 for evaluated configs, the mapping 15 of them, and `nx-exec`'s
218 ms per executed task is Nx's own module graph (611 measured the
path around `runExecutor`: the same 112 ms). The loop above holds 612
alone; 592–611 are in
`docs/history/2026-09-improvement-loop-592-611.md`. NO CORE RUN-PATH
CHANGE since 589, so the warm A/B duty has no arm. NEXT, in order: keep
finding — the owner's direction is "never stop; find, simplify, speed
up, improve", and the dead-export sweep is a shape worth repeating on
core's tests and on the site package; the trim next at 632; the
executor-backed real tree stays for a box with yarn 4 reachable; then
the owner's three items. Never end with "what next?".

## Decisions (this arc)

- **macOS violation reporting is lossy under load, and stays so
  (2026-09-22, item 586).** The store is fed by the unified log, which
  drops records under pressure; the settle window that halved the loss
  cost 300 ms per clean sandboxed task and went 2026-09-05 (owner); no
  unprivileged channel reports a denial the child survived. Enforcement
  is unaffected and the Known limits page says so. Not an open item.
- **`--affected` includes dependents (2026-09-16).** The sugar is
  `--filter '...[<base>]'`: the changed projects and everything that
  depends on them, the superset a CI gate needs and what the guides
  promised; `--filter '[<base>]'` is the changed-only form for "test
  what I touched". Item 287.
- **Resources are the schedule plugin's (owner, 2026-09-12).** Core
  gates on the worker count and asks the `admit` stage for anything
  finer; it holds no per-task cores or megabytes, no config field for
  them, no budget flag. What a task needs is learned from what it used
  (`@vzn/vx-schedule-history`), or declared to that plugin. Item 157.
- **No first-party technology plugins (owner, 2026-09-10).** A plugin
  that gives packages tasks from a framework's config (`vite()`,
  `next()`, …) is the community's to write on the `project` stage; core
  names no tool, and this repo ships no such plugin. `turbo()` in
  `@vzn/vx-migrate` is an adoption plugin, not a technology plugin, and stays.
- **Windows is WSL (owner, 2026-09-10).** vx spawns POSIX shell and ships
  linux / darwin binaries; a Windows developer runs it under WSL, and the
  docs say so instead of listing Windows as a gap.
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
- **Merge your own PR once it is green (owner, 2026-09-10, "Merge
  whenever you own the project").** The session's PR flow stays
  (branch, PR, CI), but a green, mergeable PR no longer waits for the
  owner's word; the next PR starts from the merged main.
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
