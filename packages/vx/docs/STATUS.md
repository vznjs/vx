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
642.  DONE (2026-09-23, the 628 method on `LayeredCache`'s write path).
      Eight gates deleted in turn against the whole core suite in the
      worktree: packing now when local writes are off (six rows), the
      upload's never-reject catch (three), the bytes read inside the
      job (sixteen), the drain's early return (thirteen, one of them a
      hang), the pool bound and the drain's wait for in-flight uploads
      (one each) are held; the `policy.remoteWrite` gate on `save` and
      the pack-failure catch survived. Two rows
      (`layered-cache.test.ts`): with remote writes off, `save` lands
      the local entry and issues no remote PUT (641's read twin); with
      local writes off, a pack that throws is reported through
      `onRemoteError`, skipped, and never thrown — the row's first
      shape set the policy on the wrapper and passed on pristine code,
      because the pack branch keys on the LOCAL cache's own write flag
      (`localWritesEnabled`), so the row opens a `Cache` with writes
      off and spies its `packArtifactBytes`. Each red on its line
      alone. The layered cache is swept end to end (641, 642).
643.  DONE (2026-09-23, the 628 method on the remote prefetch, the
      deferred outputs and the dedup barrier). Fifteen gates deleted in
      turn against the whole core suite in the worktree. Held: the
      prefetch handle's never-reject catch, one materialisation per
      producer, a fetch failure naming the producer, the fetched
      producer's local entry, and the barrier's three gates (a joiner
      waits, re-probes, and lifts only when the entry has landed; two
      rows each). Survived: the pass's `remoteRead` gate, the batch
      pre-mark, the wipe before a fetch, and the pending-set removal
      after one; the hit filter is masked by the pre-mark (a comment,
      as in 640) and the post-fetch git mark has no reader by
      construction (`deferralEligibility` keeps every reader of a
      deferred producer's outputs eager — a comment, and the wipe's
      twin mark with it). Four rows: with remote reads off the pass
      never starts (no probe, no pull, no key derived for it); the
      batch probe decides the pulls (a present hash fetched once, an
      absent one never — `b` depends on `a` so its lazy get cannot race
      the verdict); a straggler in the producer's declared tree is gone
      after a materialisation; a materialised producer is missing from
      the "left outputs remote" line (the failure half already had its
      row). And the pump's per-hash catch, whose verdict was flakes
      (`vx show` under a plugin, the key-scaling baseline, the watch
      loop): `LayeredCache.prefetch` swallows the remote's throws but
      its local-first probe runs before that catch, so a fifth row
      (`orchestrator-remote.test.ts`) rejects the first of two pulls
      under one worker and holds that the second still reaches the
      layer — red without the catch (one call). Two whole-suite verdicts
      carried parity rows that do not defer (eleven Turbo rows under the
      post-fetch mark, eight Nx rows under the local-entry gate); each
      re-run against its own suites in the checkout gave the true
      verdict (the mark survives, the gate is caught by the convergence
      row), and the mark's whole-suite re-run alone reddened nothing.
      The prefetch, deferral and dedup paths are swept.
644.  DONE (2026-09-23, the 628 method on the scheduler). Eighteen
      gates in `graph/scheduler.ts` deleted in turn against the whole
      core suite in the worktree, seventeen held: the fail-fast trip,
      both observer isolations, the restore-tier single dispatch, the
      abort skip and the aborted status, the dep-check bypass,
      `continue=always`, aborted propagation, the full-lane scan (the
      6,000-task pin ran 28 s without it, the number its comment
      records), the doomed-task park, the hold's start, the skip root,
      the running-set unlist (eight rows, three of them the 60 s
      timeout: a wedged policy hangs), the `settledOf` wait (133 rows),
      the plain user-error report and the override scale. One
      survived: `activeRestore === 0` in the resolve condition — and by
      the same argument `active === 0` beside it: a slot is released
      before its outcome lands (`leave()` precedes `finishOne` in both
      arms, and a skip takes none), so a task still holding one has no
      outcome yet. Deleting BOTH survived the whole core suite, so the
      condition is the outcome count alone, with that reason as its
      comment. No row: there is no state in which the counts disagree
      with the count of outcomes, so nothing can observe them. The
      scheduler is swept.
645.  DONE (2026-09-23, the 628 method on the task graph builder's
      `addNode`). Sixteen gates in `graph/task-graph.ts` deleted in turn
      against the whole core suite in the worktree, fifteen held: the
      requested promotion, `excludeDependencies: 'all'`, the spec error's
      task name, the three refusals (bare wildcard, negation, pattern in
      the `pkg#task` form), the exclusion list on a plain spec, the
      self-pattern's self-exclusion and its per-name exclusion, both
      missing-target errors, the deps walk's seed (five rows), its
      pass-through (six), the pattern holder's stop, and the edge dedup.
      One survived: the per-name exclusion inside the `^build.*`
      expansion — the self-pattern twin had its row, this branch did
      not. One row (`task-graph.test.ts`): one excluded match drops only
      that edge, and excluding every match leaves no edge and still no
      pass-through to a deeper holder (holder-ness is declaration, as the
      comment says). Red on its line alone. The container restarted
      mid-sweep and left mutation ten applied in the worktree — a killed
      driver's `finally` never runs — so the worktree was restored by
      hand and the seven unrun mutations re-driven on the merged main;
      the nine verdicts before the restart stand. The gate then caught
      643's batch-probe row: it counted the hit's GETs across BOTH runs,
      and under the gate's load the warm run's own lazy 404 landed before
      its batch verdict (a 150 ms delay in the stub's batch handler
      reproduces it). The row now pins the two claims on the layer's
      calls — `markRemoteAbsent` sees exactly the miss, `prefetch` exactly
      the hit — counts the cold run only, and bounds the miss's GET the
      way its sibling row does; each of the pass's two lines reddens it
      alone, so the "masked pair" comment in `remote-prefetch.ts` was
      rewritten. The builder is swept;
      its detectors and helpers (cycle, collisions, overlap, surfaced
      deps, request expansion) are 646.
646.  DONE (2026-09-23, the 628 method on the task graph's detectors
      and helpers). Fifteen gates in `graph/task-graph.ts` deleted in
      turn against the whole core suite in the worktree. Held: both
      detector calls (five and thirty-five rows), the remote-only
      exemption, the addition shape, all three overlap cases, both
      surfacing bounds, the empty-scope rule, and the GRAY check — that
      one timed the driver out at thirty minutes (a cycle the builder
      no longer refuses reaches a scheduler that never resolves), and
      the task-graph suite alone reddens five rows under it. Four
      survived, four rows (`task-graph.test.ts`): `expandRequested`
      dedupes (`vx run build app#build` is one entry) and
      `unresolvedRequests` dedupes (`vx run x x` names x once) — both
      doc comments claimed it; `splitTaskId` splits on the FIRST `#`
      (the pin its comment cites is on the dependency-spec side, not
      on the inverse); and the cycle detector's BLACK skip is walked
      by forty stacked diamonds inside a five-second bound — without
      it the walk is once per path, 2^40, and the differential was
      killed at sixty seconds. Each red on its line alone. Grepping
      the class found a second copy of the split rule: `cache.ts` had
      its own `splitTaskId` for the run history (the cache may not
      import the graph), so the function moved to `util/task-id.ts`,
      the graph re-exports it, the façade is unchanged, and the copy is
      gone. The task graph is swept end to end (645, 646).
647.  DONE (2026-09-23, the 628 method on the input and output
      resolvers). Twenty gates in `cache/inputs.ts` deleted in turn
      against the whole core suite in the worktree, nineteen held: both
      negation forms, both own-output exclusions, the project boundary,
      both memo-identity checks, both invisible-literal refusals and the
      absent-literal silence, both disk probes, `OUTPUT_NEVER`, the
      nested-project stop, real-path containment (project and
      workspace), the scan's file-or-symlink filter, and
      `settleLiterals`'s tree rule; the unremovable-output `UserError`
      is held by a row that SKIPS AS ROOT, so the root-driven sweep
      read two unrelated reds under it and the verdict came from
      driving the mutation as the `probe` user (red, and green
      pristine). One survived: the LEXICAL half of output containment
      — every escape the suite plants is caught by the real-path half
      too. One row (`inputs-resolution.test.ts`): a `..` glob reaching
      a sibling link that points back INTO the project names a path
      that is lexically outside while its directory resolves inside,
      and only the lexical check refuses it; red on its line alone.
      Method note: the `rm -rf /tmp/vx-*` that precedes a local row
      RACED the running sweep's fixture (an `rm: Directory not empty`
      mid-sweep); it now runs only on an idle box. 643's parity reds
      were recorded as load flakes and this wipe is a second candidate
      cause, unproven. The resolvers are swept.
648.  DONE (2026-09-23, the 628 method on the git enumeration). Twenty
      gates in `cache/git-inputs.ts` deleted in turn against the whole
      core suite in the worktree, nineteen held: the project mark's
      forwarding to the workspace partition and the workspace mark's
      reach into the project partitions under it, the workspace
      partition's invalidation, the OID drops on a mark, a dirty path
      (thirty-six rows), a flagged path and a filtered path, the
      pending-change re-spawn (thirteen), `set` and `delete` clearing
      their bookkeeping, the rename source counting as dirty, untracked
      paths as inputs (twenty-four), the prefix re-keying under a git
      subdirectory, the no-status trust withdrawal, the dirtiness
      derivation, the empty slice storing no partition, `setOids` after
      `set` (twenty-four), and the workspace-wide partition naming its
      root. One survived, no row: `recordChanged`'s guard against a
      partition with no snapshot — `snapshotFor` answers undefined for
      such a partition either way, so the guard bounds memory and is
      not a rule; its comment now says so. The enumeration is swept.
649.  DONE (2026-09-23, the 628 method on the `--filter` and
      `--affected` selectors). Twenty-three gates in
      `workspace/filter.ts` and `workspace/affected.ts` deleted in turn
      against the whole core suite in the worktree, twenty-two held: the
      `!`, leading `...`, trailing `...` and `^...` forms, the path glob
      and the nested-path prefix, the scope-crossing name star,
      all-by-default with no include, the no-match report, `^...`
      leaving its anchor out, negation removing; the option-like base
      refusal, the merge base, `--no-renames`, the lockfile exemption,
      both fingerprint widenings, config-import ownership, the orphan
      owners, `workspaceGlobsMatch`'s negation, the deepest owner, and a
      changed directory selecting the projects under it. One survived,
      no row: the exact-match branch for a `*`-free filter name — the
      name glob compiles such a name to an exact anchored match anyway,
      so the branch was a second spelling of the rule and is gone, with
      that reason as its comment. The selectors are swept.
650.  DONE (2026-09-23, the 628 method on placement, the taint tracker
      and executor selection). Nineteen gates in
      `orchestrator/placement.ts`, `orchestrator/admission.ts` and
      `exec/executor.ts` deleted in turn against the whole core suite in
      the worktree, sixteen held: the four pins (persistent, sandbox,
      `remote: false`, through deps), the remote-only noop, the
      `locallyPlaced` predicate, the plan surviving a resolution error,
      labels needing a choice, the pool naming, the tracker being off
      outside `--continue=always`, skipped and aborted upstreams
      tainting, the transitive taint, the restore-tier barrier skip, the
      pinned task skipping remote executors, and a declining executor
      being passed over (fifteen rows). Three survived. `pinAllLocal`
      was a parameter no caller passed true — item 528 had already
      measured it dead and named it for the owner — so it is gone from
      `placeTasks`, its one call site and the module page. The
      persistent skip and the `cacheable` hint are plugin-facing facts
      nothing in core read (`@vzn/vx-reapi`'s `accepts` is the one
      reader of `cacheable`), so each gets a row (`placement.test.ts`):
      a persistent task gets no executor entry and is never offered; an
      executor is told `true` for a cached task and `false` for a plain
      one. Each red on its line alone. Placement is swept.

651.  DONE (2026-09-23, the 628 method on the plugin host). Twenty-six
      gates in `orchestrator/plugin-host.ts` deleted in turn against the
      whole core suite, twenty-four held. Twenty-one went red in a row:
      the cache-layer shape check, the naming of a throwing hook, the
      project stage's check of each plugin's output, the key material and
      value refusals, key sorting and namespacing, the affected answer
      refusals, the schedule Map and finite-weight checks, the admit
      predicate being off without an answering plugin, the broken-plugin
      skip and the throwing-admit report, the local cache and executor
      tails, a wrapping layer subsuming local, the executor name, and the
      hung and throwing teardowns. The graph stage's two refusals (an
      edge outside the graph, a cycle) are held by a HANG, not a red:
      without either the plugin-pipeline suite never finishes, even under
      a 20 s test timeout, while the unmutated rows run in 218 ms. A hang
      fails CI, so both count as held. The sweep's first blame mutation
      awaited an uncalled function and so deleted both checks; the
      corrected one (an invoked wrapper that names no plugin) is red in
      both refusal rows. Two survived. A schedule weight for a task
      outside the run is dropped before it is checked: reachable (a
      history-backed plugin weighs tasks a filtered run does not hold),
      so it gets a row in `plugin-pipeline.test.ts`, red with the skip
      deleted. The admit predicate's unknown-id arm was unreachable: the
      scheduler asks only about ids in the same map the predicate was
      built from, so the arm is gone and the lookup is asserted. The
      plugin host is swept.

<!-- items 652 and 653 land above this line; drop this comment when they do -->

654.  DONE (2026-09-23, the 628 method on the telemetry host, the
      telemetry record and the event bus). Ninety-eight gates and field
      copies in `orchestrator/telemetry-host.ts`, `telemetry.ts` and
      `events.ts` deleted in turn against the whole core suite, seventy-six
      held. Three warn deletions first ran as `void (…,)`, a syntax error
      that reddened 164 unrelated rows; re-driven as a no-op call, and one
      of those needed a leading `;` or it CALLED the line above
      (`disabled.add(sink)(…)`). A replacement line that opens with `(` is
      itself a mutation. Nineteen survivors got rows, each red on its line
      alone: the sink shape refusals' words (a string `wants` was accepted,
      since `String.includes` is a substring match), a plugin with no
      telemetry hook and a declining one warning nothing, a sink with no
      flush hook not flushed, the default kinds beside a `task.log`
      opt-in, the remote up-to-date word, the stderr wire kind, the bus
      disposer called twice, and two whole-record rows (`projectOutcome`
      carried nine unread fields, `task.end` one). The handle's `disposed`
      flag and the bus disposer's found-guard mask each other; one row
      goes red only with both deleted. Two survived with no row and wait
      on the coordinator: `isCacheHit`'s known-status guard and
      `disable`'s once-guard are implied by what follows or precedes them
      (deleted in item 663, with the `disposed` flag).
      One BUG, left as an `it.todo` row: the streaming `task.end` drops
      `blockedBy`, `timedOut`, `sandboxViolations` and `notReady`, which
      the summary's copy of the same `TaskTelemetry` carries.

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
   violation reporting is lossy under load (In-flight 5);
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
2. DONE 2026-09-23 as item 662 (entry 14bj) — the remote seam streams: `get` resolves `Blob | Response`, `put` takes a file-backed `Blob`, every first-party layer moved in the same commit.
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

14bc. **Roadmap to 1.0 (item 655, 2026-09-23).** Owner asked when vx is
feature complete; the answer is `docs/design/roadmap-1.0.md`. Four
milestones: 0 closes the sweep arc (651–654, then sweeps stop being the
default loop); 1 makes 0.1.0 installable (publish the seven plugins,
which npm 404s today, and make the docs match); 2 is FEATURE COMPLETE
(run-time cache eviction, the streaming remote seam before any freeze,
the stale parity ledgers closed, the scope list confirmed by the owner,
the real-repo re-measure); 3 is the 1.0 contract (schema and plugin API
frozen, cache-version and semver policy, a soak). After milestone 0 the
loop takes its next item from the roadmap, in its order; strike an item
there when it lands.

14bd. **Item 656 (roadmap 1.1, 2026-09-23): the plugins publish with the
release.** Only `@vzn/vx` and its four platform packages reached npm,
while the docs told users to `bunx @vzn/vx-migrate`. `build-npm.ts`
gained `emitPluginPackages` (`--only=plugins`): every public workspace
package other than `@vzn/vx`, discovered rather than listed, copied from
its own `files` with the root LICENSE, stamped with the release version,
`@vzn/vx` peer-pinned to `^<version>` (one release train), and a
`repository.directory` so provenance names the package's path.
`npm.yml` builds them and publishes them after `@vzn/vx`, in the same
idempotent loop. `build-npm.unsafe.test.ts` holds the set against a walk
of the manifests (with a floor of the seven names), the manifest shape,
every declared file and the executable bins, and the workflow order;
the set row and the shape row each went red with their line mutated.
`npm pack --dry-run` on the emitted `vx-migrate` and `vx-reapi` warned
nothing. OWNER: add the seven trusted publishers before the next
release (`cli.md` § Releasing names them and the one-time hand publish
if npm requires the name to exist first). The item is 656, not 652:
652–654 are the implementer sweeps' numbers in the loop above.

14be. **Item 657 (roadmap 1.3, 2026-09-23): the 0.1.0 notes run through
item 656.** The plugins reaching npm heads "Plugins and packages"; the
restore and save syscall trims join "Caching"; "Internals" names the
633–651 sweep and the three deletions it made. The PR count reads 408
(counted at 656, `git log v0.0.21..origin/main`); recount at the cut.
The 652–654 sweeps are named as in flight, not as shipped.

14bf. **Item 658 (roadmap 2.1, 2026-09-23): the cache evicts itself.**
`defineWorkspace({ cacheRetention: { olderThan: '30d', maxSize: '10G' } })`
applies the `vx cache prune` policy at the end of every run that writes
the local cache, after the saves and uploads settle and before plugin
teardown. `Cache.evictIfDue` flushes the deferred `accessed_at` bumps,
reads `MIN(accessed_at)` and `SUM(size_bytes)` in one scan, and calls
`prune()` only when something is due; the run prints one line for what it
evicted, and a failure is a warning, never a failed run. The parsers moved
to `util/size.ts` (`parseDuration` beside `parseSize`, and `formatBytes`)
so the schema and the run share the flags' spellings. Rows
(`cache-retention.test.ts`): age and LRU eviction, nothing due means no
`prune` call, a read-only handle evicts nothing, the schema's refusals,
and a run that evicts what is due and one that declares nothing. Three
mutations went red in their rows: the run's call, the nothing-due guard
and the flush — the flush only after its row asked whether a prune ran,
since `prune()` flushes too and the evicted set is the same either way
(a masked pair, as 563). Warm no-op at 1,000 projects, min of 9
interleaved: main 240 ms, unconfigured 238, configured with nothing due 237. No new index: a scan of the entries table is below the noise. The
comparison page's row 11 is shipped; roadmap 2.1 struck.

14bg. **Item 659 (roadmap 2.3, 2026-09-23): the parity ledgers have a
status.** The two ledgers (`turbo-nx-parity-2026-07.md`, 44 entries;
`turbo-nx-test-gaps.md`, 70 non-HAVE rows) were audited against source
and tests, not their own text: 65 FIXED, 28 DECLINED, 4 OBSOLETE, 17
OPEN. `docs/design/parity-audit-2026-09.md` holds the totals, the open
table and the reasoning for Nx H7 (obsolete: the agents it targeted are
gone; `--frozen` and `vx lock --check` cover live-evaluation drift) and
Nx L2 (open: a bare name never selects a scoped package, deliberate but
untested and undocumented). Both ledgers carry a banner pointing there.
The open rows are the next work of 2.3: fifteen S rows, one S–M (a
literal output path holding glob characters) and one M (the
unknown-first scheduling benchmark); `compileNameGlob` memoization is
closed as not worth doing.

14bh. **Item 660 (2026-09-23): `task.end` carries what the summary
carries.** Item 654's sweep found two copies of the outcome → `TaskTelemetry`
projection: the summary's (`run-records.ts`) and `task.end`'s (inline in
`createTelemetrySource`), and the second dropped `blockedBy`, `timedOut`,
`sandboxViolations` and `notReady`. A streaming sink (otel) saw a timed-out
or sandbox-violating failure as a plain `failed`, and a blocked skip with no
blocker. Now one function, `taskTelemetryOf` in `telemetry.ts`, feeds both.
654's `it.todo` row is live: red on the old source, green on the new. The
record's declared type always included the four (`task.end` is `…&
TaskTelemetry`), so the shape did not change and
`TELEMETRY_SCHEMA_VERSION` stays 2. PR #749 (item 654) merged with the
coordinator's decisions on it: the two guards it left unheld
(`isCacheHit`'s known-status check, `disable`'s once-guard) are implied by
the neighbouring line and need no row.

14bi. **Item 661 (roadmap 2.3, 2026-09-23): twelve open parity rows
closed.** A developer agent wrote them in a worktree; each went red with
the line it holds mutated. Two needed source: `--affected` refuses a range
base (`HEAD~1..HEAD`) by name before git sees it (`..` is illegal in a ref
name, so no ref is refused), and an archive entry name past PATH_MAX is an
`ArchiveSecurityError`, not a raw `ENAMETOOLONG` reported as an internal
error. The linked-worktree row caught a real hazard under mutation:
reading git's status prefix from the common dir made an edited run a
stale hit. Open still, in `parity-audit-2026-09.md`: N-M7 (the
unknown-first benchmark), L48 (a literal output path with glob
characters), L232 (credentials in a remote-cache URL), and two new
findings: `--filter ./packages/[abc]` reads the brackets as a class
(decision: literal first when the directory exists) and names past
NAME_MAX still reach the file system.

14bj. **Item 662 (roadmap 2.2, 2026-09-23): the remote cache seam
streams.** Built by a developer agent in a worktree to the contract in
`design/streaming-remote-2026-09.md`, reviewed and gated here.
`RemoteCacheLayer.get` resolves `{ body: Blob | Response }`, which
`Cache.ingest` writes to its temp with `Bun.write` and validates from
there; `put` receives `Bun.file(<local artifact>)` (a byte `Blob` only
under `--cache=local:,remote:rw`). The old byte shapes are refused at the
boundary, naming the new one. `turboCache()` and `nxCache()` return the
`fetch` Response and send the Blob; a signed Turbo download goes to a
temp, is verified before core sees a byte, and is served as a stream
that removes the temp. `@vzn/vx-reapi` digests in one streamed pass,
uploads past the batch limit in `CHUNK_BYTES` messages as the write
drains, and reads back as a stream whose digest is checked as the bytes
pass (kept on purpose: core's archive check alone would accept a valid
but different artifact from a lying CAS). One 150 MiB artifact saved,
uploaded, wiped and pulled through a disk-backed stub
(`vx-bench/stream-remote-bench.ts`): peak RSS +495 MiB before, +45 after
(min of 3). Every new row went red with its line mutated; a pre-existing
crash in REAPI's `durationOf` on an absent `stdout_digest` was fixed on
the way. The introduction's "whole artifacts in memory" known limit is
gone. Plugin API: this is the breaking change the 1.0 freeze was waiting
on.

14bk. **Item 663 (2026-09-23): the three telemetry guards 654 left are
gone.** `isCacheHit`'s known-status set (an unknown string falls through
`deriveCacheSource`'s switch to `undefined`, which is neither hit source),
`disable`'s once-guard (every hook site skips a disabled sink before it
calls) and the telemetry handle's `disposed` flag (the bus's unsubscribe
is idempotent, so the handle returns it as is). Each deletion was already
green against the whole core suite in 654; each site now says why in one
line. The masked pair's row (disposer called twice) still holds the bus
side. CLAUDE.md gains 654's lesson: a mutation's replacement text is code.

14bl. **Item 664 (roadmap 2.3, 2026-09-23): a bracketed project directory
is selectable by its path.** `--filter ./packages/[abc]` compiled as a
glob and selected the sibling `packages/a` (the FINDING row of item
661). A path form now matches literally first, as git reads a pathspec,
and is read as a glob only when it selects no project literally. The
FINDING row became the fix's row, red without it, with a control that a
bracket path naming no directory (`./packages/[ab]`) still globs. The
check is on the project list, not the file system, so `parseFilter`
stays pure. Parity audit §9 L255 struck; `cli.md` and the filter module
page say so.

14bm. **Item 665 (roadmap 2.3, 2026-09-23): a remote-cache URL with
credentials in it is refused.** `turboCache()`'s `apiUrl` (or
`TURBO_API`) and `nxCache()`'s `server` (or
`NX_SELF_HOSTED_REMOTE_CACHE_SERVER`) accepted `https://user:pass@host`,
and both print the URL in every refusal line, so the password reached
the log. Both resolvers now refuse a URL with a user or a password,
naming the token option to use instead; each row is red without its
line, beside a control that the bare host resolves. Parity audit §8
L232 struck; the vx-migrate README's option tables say so.

14bn. **Item 666 (2026-09-23): a 255-byte file name restores.** Adding
the NAME_MAX refusal the audit left open, its control row (a component
of exactly 255 bytes restores) went red: the restore staged every file
as `<target>.vx-tmp-<pid>-<seq>`, and that suffix pushed any legal name
of 242–255 bytes past NAME_MAX, so a valid artifact holding one failed
with ENAMETOOLONG. The temp is now a short sibling, `.vx-tmp-<pid>-<seq>`
in the target's directory (the rename stays within one directory, so
nothing about its atomicity changes). A component past NAME_MAX is now
an `ArchiveSecurityError` by name rather than a raw ENAMETOOLONG. Both
rows are red without their line. The leftover-temp row in
`archive-security.test.ts` read `**/*.vx-tmp-*` through `Bun.Glob`,
whose `*` skips a dotfile, so it would have passed on a leak under the
new name; it reads the tree with `readdir` now. No `CACHE_VERSION`
bump: the stored bytes did not change.

14bo. **Item 667 (parity gaps §1 L48, 2026-09-23): a bracket is literal
in a task glob.** `Bun.Glob` reads `[id]` as a character class, and so did
every task glob: `inputs.files: ['app/[id]/**']` matched `app/i/…` and
never the Next.js route directory, so an edit to `app/[id]/page.js` was a
green `cache-hit` replaying the old output; `outputs.files:
['app/[id]/page.js']` saved an empty artifact and its pre-run clean
deleted an unrelated tracked `app/i/page.js`. Both probed through `run()`
before the fix. Now `[` and `]` are literal in `cache.inputs.files`,
`cache.outputs.files` and `workspaceFiles` and in everything read from
them (`--affected`, watch, the overlapping-output refusal, the additive
hit's set-aside, the subtree short-circuit, stable-key reach, REAPI
`output_paths`); there are no character classes. `GLOB_WILDCARDS` lost
the brackets, every task glob compiles through one door (`taskGlob`, which
escapes them), and `normalizeGlob` turns Turbo's `\[id\]` into `[id]`, so
both spellings are one literal. Member globs, `--filter` path globs, env
names and sandbox grants keep `Bun.Glob`'s alphabet
(`BUN_GLOB_WILDCARDS`, `normalizeBunGlob`, `grantPrefix`), each pinned by a
row. The façade gains `isLiteralPattern` and `normalizeGlob` for
`@vzn/vx-reapi`, whose copy of the class collapsed `app/[id]/page.js` to
the output path `app`, and `@vzn/vx-migrate`'s wild-first-segment check
reads the same predicate. Differential: every new core row red on the
unfixed tree except the controls (the escaped spelling already matched
through `Bun.Glob`, and the member-glob and env rows hold the old
alphabet both ways); each `taskGlob` call site, the unescape, the
alphabet, the member and filter alphabets and the subtree regex were
mutated back one at a time and each reddened a row. **`CACHE_VERSION`
v27 → v28**, not self-healing: the input half moves the key (the file set
changes), but an output glob folds as its TEXT, which the fix leaves
unchanged, so the empty v27 artifact sits under the key the fixed code
derives — proven: a v27 entry read by the fixed code was a `cache-hit`
that cleaned the route and restored nothing; under v28 it misses and the
next hit restores. Warm `run build --all` at 1,000 projects, interleaved,
min of 7: 240 ms before, 242 ms after (noise; the new work is per
pattern with an `includes('[')` fast path).

14bp. **Item 668 (roadmap 1.2, 2026-09-23): the docs name only what the
release publishes.** A row in `build-npm.unsafe.test.ts` walks the root
and package READMEs, `packages/vx/docs` and the site's pages (design
notes and the shipped history aside: they quote packages that never
shipped, like `@vzn/cache`), collects every `@vzn/…` in an install or run
command (`bunx`, `bun add`, `npm i`, `pnpm add`, `yarn add`, their `dlx`
and `x` forms) or an `import … from`, and requires each to be in the
emitter's own publish set plus `@vzn/vx`. It passes today; an install line naming a made-up
package, appended to a README, turns it red, and a floor
requires the walk to see `@vzn/vx-migrate` and `@vzn/vx-lockfile`.
Milestone 1's agent work is done; 1.4 and 1.5 are the owner's.

14bq. **Item 669 (roadmap 2.3, 2026-09-23): a task with no history keeps
the workspace median.** Parity row N-M7 asked whether vx should run a
task the history has never seen FIRST, as Nx does, instead of giving it
the median p50. The benchmark behind the question was deleted on
2026-09-09; `packages/vx-bench/schedule-policy.ts` is its replacement: a
discrete-event sim of `runGraph`'s exec tier ranked by the plugin's real
`criticalPathPriorities` over core's `mergePriorities`, pinned on
hand-computed schedules (Nx's fixture among them) and against the real
`runGraph` on a virtual clock, every mirrored rule red when reversed.
Nine shapes, 30 seeds, 0–100 % unknown: at 5–25 % unknown, unknown-first
is −0.69 % mean makespan against the median (full history is −0.82 %,
no plugin +3.51 %), but single graphs regress by up to +6.15 % there
and +13.03 % at 75 %: an unknown that turns out short starts ahead of
the known long chain. The adoption bar was a worst regression ≤ 1 % on
any cell, so the plugin is unchanged; the table and the verdict are in
`packages/vx-bench/schedule-policy.md`, and the parity audit's N-M7 row
is struck.
Coordinator's reading of the bar: "worst" is the worst single graph,
not the worst cell mean (+0.23 %), because a user lives one run at a
time and a +6 % run on a new task is the regression they would see.

14br. **Item 670 (roadmap 2.3, 2026-09-23): the parity audit has no open
row.** Its last one: a legal output name under a destination deep enough
that the two pass PATH_MAX reached the user as a raw `ENAMETOOLONG`,
which the scheduler printed as an internal error. The restore's catch
now names it like `EACCES` and `ENOSPC` beside it: a `UserError` that the
output path under this directory is longer than the file system allows,
with the remedy (a shorter workspace path); the artifact is fine. The row
in `cache.test.ts` restores a 200-byte name into a destination 150 bytes
short of PATH_MAX, red without the branch, with a control that the same
artifact restores into the shallow directory.

14bs. **Item 671 (roadmap 3.3, 2026-09-23): a cache-format bump is
announced.** A `SCHEMA_VERSION` change already said `cache index reset`
on the open that dropped the tables; a `CACHE_VERSION` bump (v27 → v28
in item 667) keeps the index but moves every key, and its all-miss run
said nothing. The cache now records the version it was written under in
`schema_meta.cache_version`, and the first open that finds another one
(or a store with entries and no record) sets `Cache.formatChange`;
`noteSchemaReset` prints `[vx] cache format changed: vA → vB (vx
upgraded); …` on the run's status line or a verb's stderr, once. A
reset and a bump together say the reset alone. The notice first claimed
`vx cache prune` reclaims the old artifacts, which is true of a reset's
orphans and not of a bump's entries (they keep their rows): it names
`--older-than` and `cacheRetention` instead. Rows in
`schema-reset-notice.test.ts`: the bump named once then quiet, the
unrecorded store, the reset winning; a fresh cache says nothing. On the
way, `bun:sqlite`'s `.get()` returns `null`, not `undefined`, for no
row: two comparisons against `undefined` made a fresh cache announce a
change.

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
