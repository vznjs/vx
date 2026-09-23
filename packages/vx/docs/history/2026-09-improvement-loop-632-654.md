# Shipped, 2026-09 — improvement-loop items 632–654

The record `docs/STATUS.md` carried until 2026-09-23, moved here whole
when the sweep arc closed (item 677; 677 itself opens the next loop). A PREFIX,
as item 373 set the rule: the formatter renumbers an ordered list
sequentially, so a cut from the middle would renumber every entry below it
and break the cross-references that cite item numbers here, in STATUS and
in the test comments.

Items 1–64 in
`2026-09-review-arc.md`, items 65–104 in
`2026-09-improvement-loop-65-104.md`, items 105–144 in
`2026-09-improvement-loop-105-144.md`, items 145–202 in
`2026-09-improvement-loop-145-202.md`, items 203–242 in
`2026-09-improvement-loop-203-242.md`, items 243–281 in
`2026-09-improvement-loop-243-281.md`, items 282–305 in
`2026-09-improvement-loop-282-305.md`, items 306–332 in
`2026-09-improvement-loop-306-332.md`, items 333–352 in
`2026-09-improvement-loop-333-352.md`, items 353–372 in
`2026-09-improvement-loop-353-372.md`, items 373–392 in
`2026-09-improvement-loop-373-392.md`, items 393–412 in
`2026-09-improvement-loop-393-412.md`, items 413–432 in
`2026-09-improvement-loop-413-432.md`, items 433–452 in
`2026-09-improvement-loop-433-452.md`, items 453–472 in
`2026-09-improvement-loop-453-472.md`, items 473–492 in
`2026-09-improvement-loop-473-492.md`, items 493–512 in
`2026-09-improvement-loop-493-512.md`, items 513–532 in
`2026-09-improvement-loop-513-532.md`, items 533–552 in
`2026-09-improvement-loop-533-552.md`, items 553–572 in
`2026-09-improvement-loop-553-572.md`, items 573–591 in
`2026-09-improvement-loop-573-591.md`, items 592–611 in
`2026-09-improvement-loop-592-611.md`, items 612–631 in
`2026-09-improvement-loop-612-631.md`; items 677 onward continue in
`docs/STATUS.md`.

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

652.  DONE (2026-09-23, the 628 method on the sandbox). The sandbox's
      gates in `exec/sandbox-*.ts` and `exec/seatbelt-profile.ts`
      deleted in turn against the whole core and unsafe suites, by an
      implementer session (PR #750). Every row reached `runSandboxed`
      through `run()`, which forwards no arguments, never times out and
      resets the runtime, so the forwarded arguments and their quoting,
      the tag's nonce, the host bridge, the spawn-failure catch, the
      process group, the live-child set, the timeout and both capture
      flags all survived; a direct block now holds each. Also held: every
      field `resolveSandboxConfig` copies and `buildCustomConfig` hands
      SRT, every `macProfileRules` capability and its refusals, the
      seatbelt classifier's arms, the strace pass's canonical paths,
      grant skip and dedup, the trace log's removal (followed by the path
      its tracer was handed, since a listing of the shared tmpdir raced
      other suites on CI), the ungranted-cwd note's three conditions,
      strace detection's memo and probe, and the socket-length and
      stderr-cap edges. One defect, fixed: `absolutize` expanded a
      leading `~` for the path a traced syscall named, which the kernel
      never does, so an undeclared read under a project directory named
      `~cache` was dropped from the report. Grants reach it already
      absolute, so the arm served nothing and is gone; the row is red
      with it back. The sandbox is swept.

653.  DONE (2026-09-23, the 628 method on the config loader). The gates
      in `workspace/config-schema.ts`, `config-cache.ts` and the project
      loader deleted in turn against the whole core suite, by an
      implementer session (PR #751). Held now, each red with its line
      gone: four workspace-schema refusals (the integer arm of
      `concurrency`, an empty package stamp, a non-object `commands`, an
      empty fingerprint claim), four task-schema refusals
      (`exec.remote`'s type, a non-object `exec.env`, an array
      `env.define`, a null `cache`), twelve of `validateSandbox`'s shape
      checks (a scalar where an object belongs read as an empty object to
      the unknown-key scan, so each stood alone), the glob-root and
      empty-filter arms, and the workspace config's lookup order. The
      eval cache: the loader's one-call-per-question round (a slower path
      answered the same config, so counting stores pin the cost, which is
      the claim), the slow-key hit and its re-index, the empty-round
      skip, the relative-only import rule (the old row's specifiers did
      not resolve, so resolution refused them first), the closure's
      visited check, its `node_modules` refusal, its size cap at the
      boundary, the unreadable-import fallback, the warm closure key
      equalling the slow one, and every part of the key seed (re-derived
      from `package.json` and the runtime, since nothing varies them
      in-process). The literal stripper's escape skip, line-break bail
      and template-expression depth are held too; the first line-break
      row left a quote open, so the EOF bail refused it as well and it
      passed with the bail deleted, and was re-spelt. No source defect.
      The config loader is swept.

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
