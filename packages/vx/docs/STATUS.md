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
(handoffs 14av–14ax to the next-log file, item 612), and items 612–631
to `docs/history/2026-09-improvement-loop-612-631.md` that afternoon
(handoffs 14ay–14ba to the next-log file, item 632), so
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

632.  DONE (2026-09-23, the trim the loop reached twenty at). Items
      612–631 moved to `docs/history/2026-09-improvement-loop-612-631.md`
      and handoffs 14ay–14ba to the next-log file in this commit. What
      that loop was: the export, env-read and README sweeps made laws
      (613, 614, 618–620); the cold path's config round and the run-end
      snapshot rows written once per table (615, 622); the CLI's
      refusals held to their words (621); the plugin indexes narrowed to
      what a README names (623); the release notes and both benchmark
      tables refreshed on this container class (624–626); the restore
      and save paths traced by syscall and shaved (627, 630, the tools
      in 631); and the two deferred flushes held site by site (628,
      629). Next trim at 652.
633.  DONE (2026-09-23, the 628 method on `close()`'s other duties).
      `Cache.close()` does four things: the two flushes (628, 629) and
      two 30-day retention prunes. Each prune line deleted in turn
      against `tests/cache.test.ts`: the history row asserted the
      `invocations` header alone, so the `DELETE FROM runs` beside it
      survived; the config-eval prune (`config_evals` and
      `config_closures`, item 615's tables) was held by nothing. Now the
      history row asserts both tables, and a new row ages one eval and
      one closure past the window and reopens: the aged rows are gone,
      the fresh ones kept — red with the prune, or either half of it,
      deleted.
634.  DONE (2026-09-23, the 628 method on the run's end sequence). Each
      await between the graph's end and `close()` deleted in turn
      against the WHOLE core suite (3,582 rows): `telemetry.flush()` is
      held by two rows and the snapshot loop by one; `await prefetchDone`
      and `await saveLane.drain()` survived. The drain was a second copy
      of the rule, as CLAUDE.md says to suspect first: the scheduler
      finishes a task only once its `settledOf` promise (the lane's
      `landed`) has, so `runGraph` resolves with every save in the cache
      and a drain after it waits for nothing. Gone, with the lane's
      `drain()` (its three unit rows await the defers now) and the
      `save lane` mark (a stage that read 0.1 ms; `timing.md` and the
      benchmarks sentence follow). The gate that IS the rule is held by
      the run-level slow-save row: with `settledOf`'s wait broken, the
      row is red. The prefetch await was a comment's promise
      ("the caller DOES await the returned handle before closing the
      cache") held by nothing: a run aborted before it dispatches
      leaves every prefetch in flight with no task to join it, so the
      new row (`orchestrator-remote.test.ts`) warms a remote, wipes the
      local cache, runs pre-aborted against a 150 ms remote and asserts
      the next run pulls nothing — red with the await deleted.
635.  DONE (2026-09-23, the 628 method on the run's finally block). Each
      of its five lines deleted in turn against the whole core suite:
      `signals.remove()` is held by two rows; `log.runEnd?.()`, the
      abort listener's removal, `disposePlugins?.()` and
      `telemetry?.dispose()` survived. The runEnd is a floor with no
      path to it: the ticker starts in `runStart`, and every call
      between it and the success path's runEnd is crash-isolated (the
      bus swallows a subscriber's throw, so even a logger whose
      `runStart` throws does not fail the run — a row that tried was
      green with the line deleted); the comment now says so instead of
      promising a crashed cycle. The other three exist for a bus or a
      signal that outlives the run — `RunOptions.bus` and `vx watch`'s
      one `stop` signal over every cycle — and nothing in the suite
      reused either. Now two rows run twice on one bus
      (`plugin-teardown.test.ts`): a plugin's setup subscription and its
      telemetry sink hear one run each, and so does the terminal
      renderer; one row (`signal-handling.test.ts`) runs twice on one
      signal and counts its abort listeners. Writing them found two
      leaks the disposers never covered: the terminal renderer's own
      subscription was never removed, so a second run on an injected
      bus reported every task twice (run() now subscribes it in a
      wrapper whose finally unsubscribes; `runOnBus` is the body), and
      a plugin's direct `ctx.bus.subscribe` bypassed the disposer list
      (the context's bus records what it hands out). Each of the five
      lines — the two fixes, the two disposers and the listener removal
      — is red on its own with its row.
636.  DONE (2026-09-23, the 628 method on the runner's exit
      bookkeeping). `runner.ts`'s eight exit-path lines — the run
      timeout's two clears, the drain race's clear, the readiness
      timer's clear at ready and at exit, the two `liveChildren`
      deletes, the stream reader's abort-listener removal — each
      deleted in turn against the 55 runner-adjacent files (in a
      worktree this time; a sweep in the checkout blocks every edit
      until it restores). Two were held (the run path's `liveChildren`
      delete by the local-executor row; the listener removal by the
      pre-ready flood row); six survived. What they guard is a pid the
      runner no longer owns: a timer that outlives its child signals
      whatever holds that pid next. Now `armTimeout` has two rows
      (`runner.test.ts`, children spawned detached like the runner's
      own, or `killTree`'s group kill reads ESRCH): a child that exits
      in time is never signalled (the deadline's clear), and one that
      dies on the SIGTERM is not SIGKILLed after (the escalation's
      clear); a server ready before its deadline outlives it, held by a
      masked PAIR — `markReady`'s clear and the timer body's `readyAt`
      re-check each survive alone and only both deleted kill the
      server, so the row pins the rule and both copies stay; a child
      that exits before ready leaves the live set. The drain race's
      clear went: a late resolve on a race the drain already won
      changes nothing, so `drainOrAbort` unrefs and forgets. Held by
      nothing observable and kept: the readiness timer's clear on
      exit-before-ready — its body's every effect is a no-op on an
      exited child and a settled promise, and the pid-reuse hazard it
      closes cannot be forced by a row.
637.  DONE (2026-09-23, the 628 method on `saveMiss`). Its eight duties
      deleted in turn against the whole core suite in the worktree:
      the project-dir git mark (four rows), the run's snapshot push,
      the tier-3 input components (seven `vx why` rows), the
      workspace-output spread (four stale-hit rows) and the
      empty-outputs warning (six) are held; the root-anchored git mark,
      the workspace-partition invalidation and the no-list snapshot
      fallback survived. The first two are a masked pair on the
      workspace partition, and deleting BOTH survives ten files too:
      a consumer that read the partition before the producer wrote
      keys from an empty set, and a later run whose real set is empty
      hits that artifact — a stale hit under a green run, the worst
      class. Now `stale-hit.test.ts` runs the shape (`early` reads
      `gen/*.ts` first, codegen writes `gen/b.ts` at the root, consume
      resolves after; then emit.sh stops emitting `.ts`): red with the
      pair deleted (`content-of-b` restored where `''` is due), green
      with either half alone, so the row pins the rule and both copies
      stay. The fallback went: `recordOutputDirs` refuses a snapshot
      whose youngest directory is inside `OUTPUT_DIRS_RACY_MS`, and a
      caller with no list recorded milliseconds after the write, so
      the fallback was always that refusal; the miss and hit paths now
      push to the run's list or record nothing (`miss-save.md` step 4).
      The hit path's third recorder site — the walk that proved the
      tree current — stays: its directories are old.
638.  DONE (2026-09-23, the 628 method on `restoreHit`). Eleven duties
      deleted in turn against the whole core suite in the worktree: the
      foreign non-zero exit's `failed` (one row), the project-side
      addition filter (six), the additive rows-present match (one), the
      walk-proved snapshot (one), the stored stdout replay (eight) and
      the `restored` flag (thirteen) are held; five survived. Each got
      a row, and three of the rows took a second shape before they held
      — the first shape passed with the line deleted, which is the
      claim tested, not the line: (1) the hit-path wipe marks, project
      and root-anchored (`stale-hit.test.ts`): a tracked-clean file the
      restore wipes and the artifact does not bring back keeps its
      index OID in a consumer's snapshot, so the consumer keys on a
      file that is gone and misses where it should hit — but only when
      the snapshot PREDATES the wipe (an `early` reader; enumerated
      after it, git status reports the deletion itself) and the artifact
      restores NOTHING the consumer's globs match (a restored match
      re-enumerates on its own — `snapshotFor` re-spawns git when any
      pending path matches), so the artifact holds a `.js` and the
      consumer reads `*.ts`; (2) the `wsOutputs.length === 0` gate on
      the directory shortcut (`workspace-files.test.ts`): a run's own
      snapshot is refused inside the racy window in a fast test, so the
      row ages `dist` with `utimes` and lets the walk-proved site record
      it; with the gate gone the snapshot says "set known", the
      workspace half reads empty and every warm hit restores again
      (`restored` true where the walk had proved the tree); (3) the
      root-anchored addition filter (`overlapping-outputs.test.ts`, the
      shape with `outputs.workspaceFiles`): without it build's walk
      finds individual's file under `gen/` and restores over it. (4)
      `covers` — rows recorded for these prefixes under this key — has
      no reachable false today (the outputs are folded into the key);
      kept and said so, because what it would let through is a skipped
      restore. Each row red on its line alone.
639.  DONE (2026-09-23, the 628 method on `executeTask`'s miss path).
      Thirteen duties deleted in turn against the whole core suite in
      the worktree — the pre-exec clean's project and workspace marks,
      the placeholder sweep on an executor throw, untouched
      placeholders becoming violations, a violation failing a green
      exit, a timeout reading as SIGTERM, the shell verdict, a
      materialize failure failing the consumer, the taint withholding
      the save, signal death classified aborted, the retry loop, the
      additive stamp before the run and the deferred save handed to
      the scheduler — and every one is held (one to 127 rows each).
      No survivor, no row, no change: the record that this path was
      swept, so nobody sweeps it again. The 628 method has now walked
      `close()`, the run's end and its finally block, the runner's
      exit, `saveMiss`, `restoreHit` and `executeTask` (633–639).
640.  DONE (2026-09-23, the 628 method on the local short-circuit's
      classify). Nine gates deleted in turn against the whole core
      suite in the worktree: the derivation-throw fallback, the batch
      probe's kept-out check, the root-reaching prefix and the
      edges-down exclusion are held; five survived. Two were dead: the
      cacheable filter was a second copy (`deriveStableKeys` pushes
      only `cacheEnabled && !unstable`) and the negated-glob skip
      guarded a shape the schema refuses (`validateWorkspaceGlobs`
      throws on `!` in output globs — a row that tried to declare one
      found out); both gone, with the reason in place. Three get rows
      (`local-shortcircuit.test.ts`): a task whose `workspaceFiles`
      INPUTS read the writer's output stays OUT of the tier, edge or no
      edge — its up-front key folded the bytes as they were before this
      run's writer ran, and restoring it early restores an artifact
      keyed on old bytes (the `workspaceInputsReach` term; the row's
      first shape passed with the term deleted because the reader's
      cold-run key depended on whether it ran before or after the
      writer, so the writer's bytes are on disk before the cold run);
      a cache without `getMany` — a `ChainedCache` of a local plugin
      layer over the floor has none — classifies through the per-task
      pool with the same exclusion; a batch probe that throws falls
      back to that pool (`classifyWith` shapes the cache the classify
      sees: `Object.create` over the real one, `getMany` overridden).
      Each row red on its line alone.
641.  DONE (2026-09-23, the 628 method on `LayeredCache`'s read and
      pull paths). Thirteen gates deleted in turn against the whole
      core suite in the worktree: the `hasMany` and `get` result-shape
      checks, `markRemoteAbsent`, the remote-sourced label, `has`'s and
      `get`'s and the ingest's degrade-to-miss catches, one pull per
      hash, the local-first skip and `remoteHasMany`'s policy gate are
      held (one to eleven rows each); the `policy.remoteRead` gate on
      `prefetch` and on `get` survived — `remoteHasMany` had the policy
      row, its two siblings had none, so a `--cache` that turns remote
      reads off left the prefetch pass and the lazy get on the wire as
      far as the suite could tell. Two rows (`layered-cache.test.ts`):
      with remote reads off, `prefetch` pulls nothing (false, no remote
      GET) and `get` is a plain local miss (null, no remote GET). Each
      red on its line alone.

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
    `docs/history/2026-09-improvement-loop-573-591.md`, 592–611 in
    `docs/history/2026-09-improvement-loop-592-611.md` and 612–631 in
    `docs/history/2026-09-improvement-loop-612-631.md` (handoffs
    14aq–14ba in the next-log file). The loop above is the record since
    632; 14bb is below, and the next handoff written here is 14bc.
15. **The plan after the sweep week: `docs/design/plan-2026-09-22.md`.**
    Fixes F1–F6, improvements I1–I7, arcs D1–D5, in the order that
    document gives (F4 → F1 → F3 → F2; F5 → I1 → I4; D3 → D1, D5
    alongside, D4 with the owner, D2 when a workspace asks). Each entry
    names its seam, the constraint that must survive, the measurement
    and what not to do; strike an entry through there when its item
    lands here.

14bb. **Handoff after item 631 (2026-09-23, afternoon).** Eight items
since 14ba, each its own PR, merged in turn (#718 624, #719 625, #720
626, #721 627, #722 628, #723 629, #724 630, #725 631, and 632 with
this handoff): the 0.1.0 release notes carry the Nx surface; the
harness rows and the 46-package head-to-head re-measured on this
container class after the cold-path work (1,000 projects warm 239 ms,
restore 906, cold 2,634; vx 78 ms warm against Turbo 2.11's 112); the
restore path lost three thread-pool round trips per artifact and the
save path two, found by counting vx's own syscalls (`strace-vx.ts`);
and the deferred snapshot's and the deferred `accessed_at` bump's
flush sites are each held by a row — a run marks an entry used only at
close, and nothing in the suite had said so. WHAT STANDS: the loop
above holds 632 alone; 612–631 are in
`docs/history/2026-09-improvement-loop-612-631.md`. The per-artifact
floors of both cache paths are traced: a restore is the `dist`
realpath, the mkdir, the write and the snapshot's lstat + readdir; a
save is the pack, the temp write, the rename and one index transaction
(94.7 ms of SQLite in a 2.6 s cold run). Leads measured and not taken,
so nobody measures them again: the restore's second `output_files`
SELECT (`hit.outputRows` is the same data; 25 µs sync per restore, a
seam widening for 25 ms per 1,000); the double output-glob scan before
a restore (13 µs each, sync); the PATH-resolved `sh` spawn (a tie at
300 spawns); batching the save index to run end (2 % for every save's
crash durability). NO WARM-PATH CHANGE since 589, so the warm A/B duty
has no arm. NEXT, in order: keep finding — the "row titled for several
sites" sweep is spent on the two deferred flushes and the run's upload
drain; the real-repo re-measure after 615, 622, 627 and 630 waits for a
box with `node_modules` (refine's were removed, astro is not cloned);
the trim next at 652; the executor-backed real tree stays for a box
with yarn 4 reachable; then the owner's three items. Never end with
"what next?".

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
