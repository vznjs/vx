# Shipped, 2026-09 — improvement-loop items 553–572

The record `docs/STATUS.md` carried until 2026-09-22, moved here whole
when the loop reached one hundred and twenty entries (item 573). A PREFIX,
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
`2026-09-improvement-loop-533-552.md`; items 573 onward continue in
`docs/STATUS.md`.

553.  DONE (2026-09-21, `orchestrator/events.ts` — the run event bus,
      its wire projection and the label vocabulary every surface
      renders. Never swept. 30 mutations: twenty-six caught (sixteen by
      the first file list, TEN MORE by a wider one), four survivors, all
      four closed by five rows. No source change).
      THE SWEEP'S FILE LIST IS THE FIXTURE THAT DECIDES EVERY VERDICT,
      and this item nearly published eleven survivors that were not.
      The first run took the five files naming the region's functions
      and reported the whole label vocabulary unheld — `up-to-date`
      versus `restored-local`, the signal word on a 137, the timeout
      reason, the violation count, the skip's blocker. Every one of
      those strings IS asserted, in the files that render them:
      framed-output, run-report, signal-death,
      persistent-ready-timeout. Re-running the same mutations over
      those caught ten of the eleven. Grep the region's OUTPUT, not
      only its identifiers.
      A DESCRIBE NAMED FOR A CASE, WITH BOTH ROWS ON ITS NEGATIVES.
      "wireForwarder — completions without a start" holds two rows: one
      that a real start is not duplicated, one that group tasks are
      dropped. Neither witnesses the synthesis the name is about — a
      skipped task never reaches the scheduler's `onStart`, so its
      completion arrives alone, and a consumer that resolves a
      completion's node from the start it recorded drops the task while
      the forwarded footer still counts it. The new row asserts the
      synthesized start is the FULL projection, not a stand-in.
      A DISPOSER THAT REMOVES EVERYTHING passed the existing row,
      because that row subscribes exactly once — `splice(i, 1)` and
      "drop them all" are the same thing to it. A surface detaching
      mid-run (a TUI closing, a devtool disconnecting) must not take the
      terminal renderer with it.
      THE OPTIONAL HOOKS ARE PART OF THE EMBEDDER CONTRACT. `runStart`,
      `taskStart` and `runEnd` are optional on `Logger`, and calling
      them unguarded turns a legal three-method sink into a TypeError
      INSIDE the bus — where the isolation swallows it and the surface
      just goes quiet.
      AND TWO EDGES: a failure with ZERO sandbox violations must not say
      ", 0 sandbox violations" (the count reads as the reason it
      failed), and a node that never says `surfaced` is not surfaced.
      A ROW I WROTE AND WITHDREW: I asserted that a real `task:start`
      arriving after a synthesized one is not forwarded twice. It is —
      `started` suppresses the SYNTHESIS, not a real start — and no run
      produces that order anyway. The row was my invention, not the
      code's promise, and reading what it returned is what said so.

554.  DONE (2026-09-21, `orchestrator/summary.ts` — the end-of-run
      footer: the meters, the aborted/skipped/flaky sections and the
      duration format. Never swept. 30 mutations: twenty-one caught,
      nine survivors, five closed by five rows, four classified. No
      source change).
      A WHOLE SECTION FORMATTER WITH NO ROWS AT ALL.
      `formatAbortedSection` is the only place an aborted task is
      NAMED — the meters leave it out deliberately ("not counted
      above") — so when this section is wrong the task vanishes from
      the run's report entirely. Nothing referenced it: its header
      printed on every ordinary run when nothing was aborted, "1
      tasks" read in the plural, and the line could lose both the exit
      code and "nothing cached", which is the part a reader acts on (a
      child killed mid-write left partial outputs and stored no entry).
      Three rows now, one per claim.
      THE METERS THEMSELVES ARE WELL HELD — largest-remainder, the
      guaranteed cell for a non-zero bucket and the debit that pays
      for it, the floor-not-round, the descending fraction order:
      every one caught, most by several rows. So is the skipped
      section's cause vocabulary and the flaky section's history
      sentence.
      WHAT THE SKIPPED SECTION MISSED was its ORDER: causes are sorted
      by how many tasks each blocked, so the biggest block reads
      first, and insertion order is the order the scheduler happened
      to finish tasks in, which is not an order at all.
      AND A ROUNDING: sub-second durations round, and a truncating
      `formatDuration` reads 1.6 ms as `1ms` — understating every
      short task in a footer whose rows are compared against each
      other.
      FOUR CLASSIFIED, TWO OF THEM MEASURED RATHER THAN ARGUED. The
      zero-total early return in `segmentBar` is a short-circuit, not
      a behaviour: without it the cell counts go `NaN`, and
      `'x'.repeat(NaN)` is `''` — the same empty bar (measured). The
      colors-disabled fallback in `gradientRule` is the same shape: the
      gradient path with `paint` disabled renders the rule BYTE FOR
      BYTE identically (measured both ways). The other two are the
      eight-dash floor (the one caller passes `vx <version>`, never a
      50-character mark) and the bold on that mark.

555.  DONE (2026-09-21, `workspace/workspace.ts` — discovery: the root
      walk, the package globs and their negations, and the project
      list every other stage reads. Never swept. 32 mutations:
      nineteen caught, thirteen survivors, nine closed by nine rows,
      four measured equivalent. No source change).
      A NEGATION SUBTRACTS FROM THE ROOT WALK, NOT ONLY THE PROJECT
      LIST, and only the second half had a row. `packages/fx` matches
      `packages/*` and is then excluded, so a command run inside it
      belongs to the nearest signal it does have — its own manifest —
      not to a root that disowned it. The fixture that separates this
      took two tries: my first gave the excluded package its own
      `workspaces` field, which claims the inner directory outright and
      never consults the outer root's globs at all.
      A NEGATION ALSO COVERS THE TREE UNDER IT, which the existing row
      exercises only at the exact path, and a BARE `!` must exclude
      nothing — the root's own relative path is the empty string, so
      matching it against `''` would delete a single-project
      workspace's only project.
      AN UNPARSEABLE ROOT MANIFEST IS STILL THE ROOT. The comment says
      so: a broken `package.json` claims no members but remains a
      signal, because walking past it reports some ancestor (or
      nothing) instead of the parse error the user has to fix.
      `memberBaseDirs` HAD NO ROWS AT ALL — `vx watch` arms exactly the
      `<dir>/*` directories so a package appearing is one directory
      entry. A glob naming a TREE (`apps/**`, `apps/**/*`, a brace)
      contributes none, and loosening the shape test to admit `**`
      would arm a directory literally named `**`. Three rows now.
      AND THE ORDER IS CODE UNIT, DELIBERATELY. Nothing asserted the
      sort at all. The two orders differ for real names — measured:
      `localeCompare` puts `apple` before `Zed`, code units put `Zed`
      first — and ICU collation cost 28 ms of a 300 ms warm run at 1000
      projects. A row with an uppercase name pins the machine-
      independent one.
      FOUR MEASURED EQUIVALENT, each checked rather than argued: `.`
      never matches a directory below the root (`Bun.Glob('.')` against
      `packages/a` is false), a literal negation run through
      `Bun.Glob` answers exactly what the exact-equality check already
      answered, an empty `below` list makes the claim loop vacuous, and
      a negated glob cannot pass the `<dir>/*` shape test because of
      its own `!`.
556.  DONE (2026-09-21, `orchestrator/telemetry.ts` — the canonical
      versioned export shape: the status vocabulary, the per-run
      summary's tallies, and the source that projects RunEvents into
      records for every sink. Never swept. 46 mutations: thirty
      caught, sixteen survivors, twelve closed by ten rows, four
      classified. No source change).
      THE ONE PLACE A LOCAL AND A DISTRIBUTED RUN AGREE HAD NO DIRECT
      TEST. `assembleRunSummary` is exported from the façade precisely
      so the distributed controller computes the same tallies core
      does — and every mutation of it was reached only through an
      end-to-end `run()`, whose fixture has no failure, no remote hit
      and no aborted task. So `failedCount` could count aborted tasks,
      `hitRemoteCount` could count local hits, `hitCount` could drop
      the remote half, `exitOk` could be re-derived from the task
      list, and `totalDurationMs` could be recomputed from the epoch
      stamps — five of six tallies, suite green. The last two matter
      most: the run's verdict counts SKIPPED tasks beyond the recorded
      list, so deriving `exitOk` from `failedCount` reports a failed
      run green; and `totalDurationMs` is a MONOTONIC hrtime measure
      while `startedAt`/`endedAt` are `Date.now()` stamps taken at a
      different point.
      A ROW NAMED FOR A COST GATE THAT A LATER FILTER ANSWERS FIRST.
      "does NOT emit task.log when no sink wants it" asserts only that
      no record arrives — which `deliver()`'s own kind filter
      guarantees whether or not the `wantsLog` gate exists. Both the
      gate and the `wants` scan behind it could go with the suite
      green. What the gate buys is that the chunk is never touched, so
      the new row hands the subscriber an event whose `chunk` is a
      GETTER and counts the reads: zero for a declining sink, one for
      an opting-in one.
      THE FLUSH ERROR PATH WAS UNREACHABLE IN EVERY FIXTURE. The only
      sink whose `flush()` threw had been disabled one line earlier by
      a throwing `onRunSummary`, so `flush` returned before ever
      calling it — leaving both the warn and the swallow untested. A
      rejection there propagates through `Promise.all` into
      `settleWithin` and out of `flush()`, which `run()` awaits before
      `closeCache()`.
      AND THREE MORE EDGES: a sink disabled mid-run still got the run
      SUMMARY (the record an ingest persists a whole run from), only
      the `stderr` label was asserted, `run.start`'s `startedAt` could
      fall back to the projection clock instead of the run's own
      start, and `attempts` — the telemetry-side flaky signal — could
      be dropped entirely.
      FOUR CLASSIFIED, EACH MEASURED. `isCacheHit`'s known-status
      guard cannot change an answer: `deriveCacheSource` on an unknown
      string falls off its switch and returns `undefined`, which is
      neither `'local'` nor `'remote'`. The `else` in the hit tally is
      a reading aid — no `cacheSource` value satisfies both branches.
      `?? DEFAULT_KINDS` vs `?? []` in the `wantsLog` scan answer
      identically because `DEFAULT_KINDS` holds no `task.log` (the
      coupling is held separately: adding it there IS caught). And
      `disable()`'s own dedup guard is unreachable — both call sites
      pre-check `disabled.has`, measured with the same sink listed
      TWICE and fed five records plus a summary: the throwing hook is
      reached once and warns once. Those two pre-checks are pinned by
      rows, which is what makes the third redundant.

557.  DONE (2026-09-21, `orchestrator/plugin.ts` — the one `VxPlugin`
      contract: `definePlugin`'s name derivation, `installPlugins`'s
      refusals, and the bus-hook dispatch every observe-only plugin
      runs through. Never swept. 37 mutations: twenty caught,
      seventeen survivors, thirteen closed by eight rows, four
      classified. No source change).
      FIVE OF THE SEVEN SENTENCES THIS FILE PRINTS HAD NO ASSERTION
      ANYWHERE IN THE REPO — a grep for each message found rows only
      for `no package.json above` and `must be the plugin module's
import.meta`.
      A ROW THAT PASSED FOR THE WRONG REASON. "rejects a plugin
      missing name or setup" ends in `.rejects.toThrow(/setup/)`, and
      deleting the authoring check does not fail it: the call then goes
      ahead, the TypeError comes back wrapped as "failed to load:
      plugin.setup is not a function", and that satisfies `/setup/`
      just as well. The two paths differ only in the sentence, so the
      row now pins it exactly.
      "DISABLED FOR THE REMAINDER OF THE RUN" WAS PROVEN BY A FIXTURE
      THAT EMITS ONE EVENT. It cannot tell a plugin that was disabled
      from one that throws afresh every time, so both the `disabled`
      set and the guard that reads it could go: a broken hook would run
      on every event of the run and reprint its warning each time. A
      third event and an exact warn count close it.
      THE DISPOSER HAD NO CALLER AT ALL. Every row discarded
      `installPlugins`'s return value, so it could return a no-op or
      unsubscribe only the FIRST of a plugin's hooks. Under `vx watch`
      a plugin instance outlives a run, so a surviving subscription
      means the next run's events reach the last run's closures and
      keep them alive for as long as the watcher runs. The row
      registers two hooks, disposes, and re-emits both.
      AND FOUR HOOK PAYLOADS WERE UNHELD: `onTaskStdout` and
      `onTaskStderr` differ only by the event kind they test, so they
      were cross-wireable (a plugin tagging output by stream labels
      every line backwards); the chunk and the status line each had no
      witness, because the existing handlers take no arguments. Also
      unheld: an empty `"name": ""` in a package.json (a string, so a
      presence check accepts it), the default `console.error` warn, and
      whether each `setup` is AWAITED in order — unawaited, an async
      plugin subscribes after the next plugin's setup and its rejection
      is swallowed.
      FOUR CLASSIFIED, EACH MEASURED. The `packageNameByDir` memo is
      pure speed either way: dropped or keyed on the directory the
      manifest was found in, a repeat and a deeper absent path both
      still answer `@vzn/vx`. The spread order in `definePlugin` is
      unreachable because `'name' in hooks` is true for an own, an
      inherited AND a getter property, so nothing carrying a name
      reaches it. And `origin.dir` vs `origin.url` cannot be told apart
      through the one documented caller: for a real module
      `import.meta.dir` equals `path.dirname(fileURLToPath(import.meta.url))`,
      and walking from the FILE path rather than its directory reaches
      the same package one iteration later.

558.  DONE (2026-09-21, `config.ts` — the user-facing schema: the
      plugin vocabulary every stage gate reads, and the two define*
      identity functions. Never swept, and it needed a SECOND
      INSTRUMENT. 25 mutations: twelve caught, thirteen survivors, ten
      closed by six rows and one strengthened, three classified. No
      source change).
      `bun test` IS THE WRONG INSTRUMENT FOR A FILE THAT IS MOSTLY
      DECLARATIONS. About 95% of this file is interfaces, and `bun
test` is transpile-only — it cannot see a type error at all, so
      a sweep run under it alone reports every schema claim as a
      survivor. The repo already owns the right instrument: the gate's
      `lint.oxlint` is `oxlint --type-aware --type-check`, it covers
      `tests/` as well as `src/`, and this repo already writes
      compile-time rows as `@ts-expect-error` (an unused one is
      TS2578). So the sweep ran BOTH per mutation, and a mutation the
      gate refuses at either one is caught.
      AND THE TYPE-CHECK'S FILE LIST IS A FIXTURE TOO. My first pass
      named `src/` only and scored the whole `dependsOn` compile
      validation a hole — when `tests/config.test.ts` has pinned it
      with an `@ts-expect-error` all along. Re-running with the gate's
      own discovery flipped it to refused. The same lesson as item
      553, one instrument later.
      WHAT WAS ACTUALLY UNHELD. `PLUGIN_PACKAGE` is a REGISTRY symbol
      so that a plugin package's own copy of `@vzn/vx` and a compiled
      binary's stamp and check the same key — and neither half had a
      witness: a plain `Symbol()` is unique per copy, and changing the
      key string silently stops recognising every plugin built against
      the old one. `PLUGIN_HOOKS` is documented as being IN PIPELINE
      ORDER, but the doc-drift suites ask only that each name appears
      somewhere, so the order was free. `PLUGIN_FUNCTION_HOOKS`
      decides what the loader demands a function of, and its
      membership was free in both directions — admitting `commands`
      or `fingerprint` would reject a legal plugin.
      A ROW NAMED FOR A TYPE CLAIM WHOSE ASSERTION WAS A RUNTIME ONE:
      "preserves nested literal types via the generic" ends in
      `toEqual(['dist/**'])`, which holds whether or not the generic
      narrows. It now carries a typed binding as well.
      AND THE SCHEMA'S OWN REQUIREMENTS WERE UNPINNED: architecture
      principle #2 says `cache.inputs.files` is REQUIRED — there is no
      inferred-input path — and that requirement lives only in this
      type, which could go optional with the whole suite green.
      `Plugin.name`, and `defineWorkspace`'s constraint and
      non-widening return, were the same.
      THREE CLASSIFIED, MEASURED. The `_pluginHooksMatch` line is a
      compile-time TRIPWIRE, and removing a tripwire is not caught by
      the tripwire: with no drift on the tree, a half pin and a whole
      one behave identically. Measured live instead — a hook added to
      `Plugin` alone and a hook added to `PLUGIN_HOOKS` alone each
      make line 98 refuse to compile, so both arms fire.

559.  DONE (2026-09-21, `orchestrator/metrics.ts` — the run-history
      query layer behind `vx last`, `vx why`, `vx show` and `vx mcp`.
      Never swept. 38 mutations: twenty-one caught, seventeen
      survivors, all seventeen closed by nine rows and one extended.
      One source de-claim).
      `whyDidThisRerun` IS ALREADY WELL HELD — every one of its nine
      mutations was caught, including the three endings an unchanged
      key can have and the guard that the previous run must have
      RECORDED a key. The holes were all next door.
      TWO COPIES OF ONE RULE, ONE OF THEM FREE — twice.
      `cacheKeyDiff` carries the same "previous run must have recorded
      a key" restriction as `whyDidThisRerun`, with its own comment
      explaining why (a `hash = ''` row would resolve the
      `prev.hash === this_.hash` branch and answer "same inputs" for
      two runs that never had a key) — and nothing held that copy. The
      clause builder is the same story: `listRuns`'s `AND` join is
      pinned by a row that passes two filters at once, while
      `listInvocations`'s identical line was free, because every one of
      its assertions passes exactly ONE filter and a single clause
      reads the same under AND or OR.
      A SORT THE STORAGE LAYER WAS ANSWERING FOR. Deleting
      `entries.sort(...)` outright changed nothing: `entry_inputs` is
      PRIMARY KEY (entry_hash, kind, name), so the scan already returns
      kind-then-name. But in SQLite's BINARY collation, and the sort is
      `localeCompare` — measured, the scan gives [Banana, Zed, apple]
      and localeCompare gives [apple, Banana, Zed]. An all-lowercase
      fixture makes the two agree; mixed-case kinds tell them apart.
      AND A `bigint` THAT NEVER WAS. The raw row typed the wallclock ns
      columns `bigint | null`, but `bun:sqlite` hands them back as JS
      NUMBERS — the handle sets no `safeIntegers`, and the value I
      wrote to probe it came back rounded at 2^53. Harmless: these are
      ns RELATIVE to run t=0 and 2^53 ns is 104 days of run time. But
      the annotation claimed a precision the read never had, so it is
      corrected to `number | null` — the one source change, no
      behaviour (`.toString()` reads the same on either).
      THE REST WERE THE MAPPING AND THE NOTES: a pre-column NULL
      `cacheHit`/`cached` could read as `false` (which states "declares
      a cache block and missed" — a claim the row does not make), the
      limit clamp could go (SQLite reads LIMIT 0 as none and LIMIT -1
      as unbounded, so an unclamped caller number is two different
      wrong answers), the tag filter could fire on half a pair or skip
      the JSON escaping its LIKE depends on, and three of
      `cacheKeyDiff`'s notes — the uncached-fingerprints sentence, the
      one-side-pruned case, and "changed but no component differs" —
      had no witness.

560.  DONE (2026-09-21, `graph/scheduler.ts` — the two-tier scheduler
      itself: the bitset priority closure, the ready heap, the tick
      loop's admission and skip propagation. NEVER mutation-swept: 464
      took `admission.ts`, the seam beside it, and 434 took
      `taintTracker`. 50 mutations: thirty-one caught, nineteen
      survivors, ten closed by nine rows, nine classified. One
      comment corrected).
      WHAT IS ALREADY WELL HELD, and it is most of the file: the
      bitset transitive closure at every mutation (the fold, the
      reverse-topo direction, the popcount, the edge direction), the
      heap's (priority DESC, seq ASC) contract with both sift arms,
      skip propagation, fail-fast, and both observer-isolation arms.
      The holes were all at DEFAULTS and SECOND COPIES.
      A FIXTURE THAT DISARMS THE BYPASS IT IS NAMED FOR. "restore-tier
      task reports cache-hit even when a dep FAILED" loops five times,
      but a restore is enqueued at startup and dep-INDEPENDENT, so it
      is dispatched in the first tick — before anything can fail. The
      dep check in `willSkip` is never reached, so the bypass has no
      witness at all. Holding the restore lane (`concurrency 1` ⇒ one
      restore at a time) lets the failure land first, and the second
      restore is then dispatched with a failed dep already recorded.
      A RESTORE COULD BE DISPATCHED TWICE: restore-tier tasks are
      enqueued at startup on their own lane, so the `pending`
      decrement in `finishOne` must not ALSO push them onto the exec
      queue — and nothing held that.
      `blockedBy` HAD NO WITNESS FOR AN ABORTED DEP, and none for its
      PRECEDENCE: a failed upstream names itself, a skipped one hands
      down its own root, and every fixture gives a task exactly one
      bad dep, where either order answers the same. And the abort
      SIGNAL arm of `willSkip` was never driven at all — the status it
      produces is the difference between "your run was cancelled" and
      "something upstream of this failed".
      `mergePriorities` WAS HELD ONLY WHERE THE BASELINE IS ZERO.
      Every fixture scores nodes with baseline 0 and distinct weights,
      so both the baseline COPY (what unscored nodes rank by) and the
      `+ b` tie-break (parity within the override set) could go with
      the suite green.
      AND TWO ADMISSION EDGES: pool capacity was never tested with a
      SECOND pooled task, so `hasRoom` could return a flat `true` and
      oversell the pool; and `Math.max(1, …)` is a FLOOR, not a
      rounding — a task refused and admitted inside one millisecond
      would otherwise drop `admissionHeldMs` and report that the
      policy never held it. Pinned with `Date.now` frozen, so the
      elapsed time is exactly 0 and only the floor can produce it.
      ONE OF MY OWN MUTATIONS WAS A NO-OP. `dr-then-catch` inserted a
      pass-through `.catch` ahead of `.then(f, g)`, which leaves both
      arms intact — it measured nothing. Rewritten as the shape the
      comment forbids (`.then(f).catch(g)`), it SURVIVES, and chasing
      that down corrected the comment instead: `onFinish`, which it
      cited as the throw to guard against, is isolated inside
      `finishOne` and never reaches the fulfillment arm — which is
      exactly why "a throwing onFinish does not unlist twice into a
      wedged policy" passes under both shapes. The only unisolated
      thing left there is the caller's `settledOf`, and under the
      CORRECT shape a throw in it strands the outcome and hangs the
      run rather than double-releasing. The two-arm form is still
      right; no reachable throw makes the difference observable, so
      there is no row to write.
      AND ONE VERDICT WAS THE DRIVER'S FAULT, NOT THE CODE'S.
      `tl-restore-drained-first` read INCONCLUSIVE because a hung
      mutation costs bun's default 5s per row — 49 rows in one file —
      which blew a per-file timeout sized from the pristine 1.3s and
      truncated the run before its summary line. Re-run alone it is 46
      of 49 rows red: a catch, not a hole.
      EIGHT CLASSIFIED. Four are defensive against inputs their one
      caller cannot produce: `computeReverseDepCount` has exactly one
      production call site (`runGraph`), which would itself hang on a
      dep missing from the map, and whose `priority` map covers every
      node — so the missing-dep `continue`, the cycle-stranded default,
      the heap's `?? 0` and `peekSeq`'s `-1` are all unreachable from
      there. The parked-task seq repush is the one item 493 already
      measured over 800 randomized scenarios with zero order
      differences, kept because it holds without that argument. The
      two resolve-condition arms are implied: `leave()` runs before
      `finishOne`, so `active` is already 0 when the last outcome
      lands. And the `heldSince` first-write guard is a claim about
      elapsed time that only a clock seam could pin deterministically.

561.  DONE (2026-09-21, `orchestrator/execute-task.ts`, region:
      `executeCachedTask`'s probe → clean → attempt → save path — the
      file CLAUDE.md calls stale-hit-critical. Item 423 covered it as a
      READ-AND-CHECK pass, not a mutation sweep. 43 mutations:
      thirty-one caught, twelve survivors, eleven closed by ten rows,
      one classified. No source change).
      A READ-THROUGH AND A SWEEP ARE NOT SUBSTITUTES, and this is the
      clearest case yet. 423 read this file end to end against the live
      invariants and found two gaps; the sweep found ten more in the
      same region — including the one sitting directly beside what 423
      did pin.
      `--force` AGAINST A WARM CACHE HAD NO WITNESS. `willRead` keys on
      the READ axes exactly as `willWrite` keys on the write ones, and
      423 pinned only the write half — it even noted that the wipe row
      next door proves nothing about the asymmetry. But its own
      `--force` fixture builds a FRESH project with no prior entry, so
      whether a probe happens is invisible to it. Move `willRead` onto
      the write axes and `--force` probes, hits and RESTORES: cached
      bytes served at the one moment the user asked for a rebuild. The
      new row counts executions on disk, with a read-only control
      proving the entry is really warm.
      THE `exec.remote: 'only'` LOCAL NO-OP BRANCH WAS UNDRIVEN.
      `placement.test.ts` is the only other file that names
      `remoteOnlyNoop`, and it uses it as an EMPTY Set in a helper — so
      the branch could return `failed`, or drop the hash, with the
      suite green. The hash is the point: it is computed precisely so
      dependents fold it.
      AND THE WORKSPACE TWIN OF A HELD RULE WAS FREE AGAIN (the same
      shape as 559). The clean marks every wiped path in the git
      snapshot so a deleted-and-not-recreated output cannot keep a
      consumer's key unchanged; the project-dir call is caught by the
      suite, its workspace-root twin — which can delete into OTHER
      projects' dirs — was not.
      THE REST: the capture config (stdout only when it will be SAVED,
      never stderr — a heap cost with no outcome to read, so the
      EXECUTOR records what it was asked for), the empty-input warning
      firing for a task that declared no inputs at all, SIGKILL folded
      in with SIGINT/SIGTERM as an abort (it is an OOM — a real
      failure, and folding it hides every OOM from the failure count),
      deferred producers fetched for a REMOTE-placed task (the whole
      cost deferral avoids), and the violation count + lines the
      footer renders.
      WHAT IS ALREADY WELL HELD is substantial: the `preProbed` stable
      key a restore-tier task must not recompute (52 rows red on one
      mutation), the clean's write-gating and its deferral skip, a
      sandbox violation failing a zero exit, the trapped-SIGTERM
      timeout rewrite, the whole retry-precedence cluster, the save's
      exit and deferral gates, and the `refresh` flag both ways.
      ONE CLASSIFIED: `timedOut` is stamped only when the exit is
      non-zero, and after the trap rewrite a timed-out task can no
      longer exit 0 — the guard is defensive against a state the code
      one branch up now prevents.
      TWO FIXTURE CORRECTIONS OF MY OWN, both the standing shapes.
      My first `gitFilesCache` stub entered by a different door than the
      product does — the hash path also calls `snapshotFor` — so the row
      died on the stub rather than the claim; replaced with a REAL
      `GitFilesCache` and one spied method. And my empty-input row was
      short-circuited a guard EARLIER: I gave the task no `cache` block
      at all, so nothing resolved inputs and `inputs !== undefined`
      answered before the guard under test. It needs a CACHEABLE task
      whose declaration is empty (`inputs: { files: [] }`), with a
      declared-but-matching-nothing control beside it.

562.  DONE (2026-09-21, `cache/cache.ts`, region: `restoreOutputs` —
      the replay path's refusals. Item 427 called this file a
      ZERO-YIELD read-through. 19 mutations: fifteen caught, four
      survivors, three closed by two rows, one classified (plus two
      arms INCONCLUSIVE on this machine). No source change).
      AND HERE THE READ-THROUGH MOSTLY HELD — which is the useful
      contrast with 561, and the reason is visible in the FIXTURES,
      not in the method that produced either verdict. The
      vanished-artifact row carries a control proving its phrase is
      specific to that case and not one every restore failure happens
      to carry; the hollow-artifact row was rebuilt in-process after
      the old `tar --format=gnu` version silently wrote an EMPTY
      archive on darwin and passed for the wrong reason. Rows that
      discriminate make "pinned" true.
      WHERE IT DID NOT: `blocked by what is on disk` HAS NO ASSERTION
      ANYWHERE, though 427 lists the EISDIR/ENOTDIR stray among the
      claims it found covered. The whole arm could go and every stray
      would be reported as an unreadable archive — pointing the reader
      at deleting their cache instead of at the file in their way.
      Measured while writing the row: a FILE standing where the entry
      needs a directory reports EEXIST from `mkdir`, not ENOTDIR, so
      the two sub-cases also separate a narrowed arm from the whole
      one.
      AND THE `cause` ON THE TERMINAL CorruptArtifactError was free.
      run.ts prints it precisely because "a CorruptArtifactError over
      an ENOENT is a race, not a bad archive", and the stack is not
      printed there — so the cause is the only fact the reader gets
      about why the decode failed.
      THE ERROR-CLASSIFICATION TAIL IS DUPLICATED in `restoreOutputs`
      and `ingest`, and my first table matched BOTH at once, which
      would have let a held copy mask a free one (rule 6). Mutated
      apart, both copies are held — including the
      `ArchiveSecurityError` rethrow, without which a path traversal
      is laundered into "bad archive".
      ONE OF MY OWN MUTATIONS WAS A NO-OP AGAIN (rule 39, second time
      in three items): while disambiguating that duplicated tail,
      `rt-corrupt-only` ended up inserting `void 0` and nothing else,
      so its survival said nothing. Rewritten to actually drop the
      security arm, it is CAUGHT — the rethrow is held, and the
      "survivor" was an artefact of my own table.
      ONE CLASSIFIED. The `.vx-tmp-` narrowing on the ENOENT arm: the
      existing row asserts the full message INCLUDING the marker, so
      both spellings agree for it, and no reachable path produces an
      ENOENT outside a staging file — the artifact's own absence is
      caught one block up, and every file the extract touches it
      created itself. And the two permission arms of this region (the
      `isFsRefusal` branch, `assertWritable`) are INCONCLUSIVE ON THIS
      MACHINE, not survivors: their rows are `skipIf(root)` and this
      container is root, so `disk-full.unsafe` runs ZERO rows here. It
      is deliberately absent from the driver — a file printing
      `0 pass` with no failing row is what the classifier reads as a
      compile error, which would have made every verdict
      INCONCLUSIVE. CI runs non-root with `VX_REQUIRE_NONROOT=1`.

563.  DONE (2026-09-21, `cache/cache.ts`, region:
      `writeArtifactAndIndex` — the UNTRUSTED ingest boundary and the
      indexing that follows, where network bytes become a cache entry.
      28 runs over 27 mutations plus one joint: eighteen caught, ten
      survivors, one closed by one row, nine classified. No source
      change).
      THE HEADLINE IS A PAIR THAT MASKS ITSELF. Writing the artifact to
      the FINAL path instead of a temp survives, and so does renaming
      before the scan — because the failure path unlinks `tmpPath`,
      which under either mutation IS the final path, so the four
      existing rejection rows still see no file. Remove BOTH and seven
      rows go red. The pair is held JOINTLY (the 536/544 shape), and
      what is left unheld is not a hole a sequential row can reach: it
      is the window in which a CONCURRENT reader sees unvalidated bytes
      at the final path. Recorded rather than papered over.
      WHAT A ROW DID CLOSE: `flushAccessed` must CLEAR `touched`.
      Left in place, every later flush rewrites the same rows with the
      current time, so an entry touched once reads as freshly used for
      as long as the process lives — and retention pruning, which is
      exactly an `accessed_at` cutoff, never reclaims it. Pinned with
      `Date.now` frozen across two `stats()` calls.
      FOUR MEASURED EQUIVALENT, and two of them killed a row I had
      already written. Archive entry modes are ALREADY permission-only
      (measured: `0o644`, zero type bits), so `& 0o777` is a no-op for
      anything the reader produces. And `Bun.Archive` normalizes
      `'outputs/'` to an entry named `outputs` — no trailing slash — so
      `startsWith('outputs/')` is false and the empty-rel guard is
      never reached: the case needs a hand-built tar header, which the
      packer cannot emit. My row asserted both and discriminated
      neither, so it was REMOVED rather than shipped (rule 15). Also
      equivalent: the empty-`touched` short-circuit (the loop body
      never runs anyway), and `totalBytes` from the file rather than
      the buffer — the file at the final path was written from exactly
      those bytes.
      THREE CLASSIFIED AS OUT OF A SEQUENTIAL SUITE'S REACH: the two
      bomb-gate SOURCE choices (in-memory vs streamed decode) are a
      memory cost with no outcome to read; the `Math.floor` on the ms
      mtime differs from `Math.round` only at a half-millisecond
      boundary; and the 900-row chunk needs 901+ touched hashes in one
      flush to exercise SQLite's bound-parameter ceiling.
      AND THE REST OF THE REGION IS WELL HELD: the v17 stdout
      invariant, the `outputs/` strip with the workspace prefix KEPT as
      the namespace discriminator, the stdout row excluded, mtime at ms
      rather than seconds, the pinned `exitCode` 0 that stops a foreign
      row laundering a broken build into a green run, the usage read
      from the artifact on both paths, the entry_inputs rows, and the
      single indexing transaction — several of them at 40-78 rows red.
      AN OPERATIONAL MISTAKE WORTH RECORDING: I applied and restored a
      mutation BY HAND while the sweep was still running, and both
      write the same file. Two verdicts were taken under that
      interference. Re-run cleanly afterwards they were identical, so
      nothing was misreported — but a stray `--restore` mid-sweep
      manufactures a SURVIVED out of a mutation that was never tested,
      which is the exact failure this method exists to prevent.
564.  DONE (2026-09-21, `cache/cache.ts`, region: `prune` — the TTL
      sweep, the LRU byte budget, and the orphan reaper behind it. 30
      mutations: twenty-one caught, nine survivors, seven closed by six
      new rows and one repaired, two measured equivalent. No source
      change).
      THE HEADLINE IS AN ASSERTION AGAINST A PATH THAT NEVER EXISTED.
      The TTL row checked `existsSync(<cacheDir>/h-old)` — a DIRECTORY
      from the layout before an artifact became a single
      `<hash>.tar.zst`. So it was false before the prune and false
      after, and deleting prune's entire artifact unlink left the suite
      green: every evicted entry's bytes stayed on disk until some
      LATER prune's orphan sweep found them, a grace window away. The
      row now asserts the artifact is there BEFORE (the control that
      makes the "gone" assertion mean anything) and gone after.
      THE SWEEP'S THREE NARROWING GUARDS WERE ALL UNHELD, for one
      reason: every control in the orphan row is FRESH, so the grace
      window alone was keeping them and no guard had a witness. Aged
      past the window, each one bites — drop `endsWith('.tar.zst')` and
      `cache.db` itself is unlinked (the INDEX, reaped by its own
      prune); drop `st.isFile()` and a directory is counted and its
      bytes reported; relax the temp test to `indexOf(...) >= 0` and a
      name that is nothing but the suffix, belonging to no hash, is
      reaped. One row with four aged controls and one real orphan
      holds all three, and `scanOrphans`'s `readdir` swallow — never
      exercised, because readdir does not fail in a fixture — is held
      by a row that deletes the cache directory and asks
      `orphanStats()` for nothing.
      THAT LAST ROW COST A DARWIN CI CYCLE, and the answer was already
      in the file. It first asked the bigger question — that a prune
      still EVICTS with the directory gone — which is a LINUX-ONLY
      claim: macOS answers `SQLITE_IOERR_VNODE` for a read through an
      unlinked vnode. `close()`'s own catch has documented the WRITE
      half of exactly that since it was written. The row now asks only
      what holds everywhere: the scan reads the directory BEFORE it
      queries the index, so a readdir that fails never reaches SQLite
      at all.
      THE STORAGE LAYER WAS ANSWERING FOR THE SORT AGAIN (the 559
      shape, from the other side). `ORDER BY accessed_at ASC` reversed
      to `DESC` is caught; DELETED it is not — the maxBytes fixture
      saves h1, h2, h3 in exactly the order it then touches them, so
      SQLite's rowid scan returns the LRU order for free. The new row
      writes the rows LAST-used-first, the one order a rowid scan gets
      wrong.
      AND THE TWO POLICIES COMPOSE THROUGH ONE `remaining`, unheld in
      both directions: the TTL-freed bytes must be subtracted before
      the budget decides (drop it and the cap evicts entries the user's
      own number says fit — measured 3 evicted where 1 is right), and a
      TTL victim must not be re-counted as an LRU candidate (drop the
      JS filter and `bytesFreed` inflates while a live entry the cap
      has no room for survives — 1 evicted and 300 freed where 2 and
      200 are right). Both need exact byte sizes and exact
      `accessed_at`s, so the new rows INSERT into `entries` directly,
      as the 900-victim row already did; `get()` cannot be the oracle
      for a survivor there (no artifact on disk), so the index is.
      TWO MEASURED EQUIVALENT. `remaining > maxBytes` → `>=` enters the
      block when they are equal, and the loop's first statement is
      `if (remaining <= maxBytes) break` — one wasted SELECT, no
      outcome. `victims.size > 0` → `>= 0` runs the delete block with
      an empty hash list: zero chunks, an empty transaction, and
      `Promise.all([])`. Neither is a hole; both are recorded so the
      next sweep does not re-litigate them.
      WELL HELD: the argument guard (both arms), the TTL comparison's
      direction and its byte tally, the budget's break condition in
      both directions and the decrement behind it, all three `dryRun`
      behaviours, the row DELETE, `unlink` over `rm({ force })` for the
      concurrent-prune count, the reap-vs-stats distinction, the grace
      window's existence and direction, and the temp sweep itself —
      several at 4-10 rows red.
565.  DONE (2026-09-21, `cache/inputs.ts`, region: `resolveFiles` —
      the positive/negative split, the exclude set, the project
      boundary patterns, the invisible-literal refusal, the per-run
      memo and the existence probe. 31 mutations: twenty-three caught,
      eight survivors, four closed by five rows, four classified. No
      source change).
      THE REGION IS THE BEST-HELD ONE SWEPT SO FAR — every arm of the
      exclude set (ALWAYS_IGNORE, the boundary globs, the task's own
      outputs, the negations), the tree expansion on each of them, the
      `!` split and its slice, the default-globs branch, the boundary
      pattern's shape and direction, the refusal's exists gate and its
      resolve base, and the untrusted mid-run re-enumeration all go red,
      several at 5-21 rows.
      THE REFUSAL IS MASKED FOR DIRECTORIES, AND THAT HAS A COST.
      Deleting the prefix arm of `settleLiterals` (`rel.startsWith(lit
      - '/')`, the arm that lets `src/gen/a.ts`settle a literal naming`src/gen`) changes nothing — because `Bun.file(<a directory>)
        .exists()`is FALSE (measured, Bun 1.3.11), so the refusal`continue`s past every literal that names a directory and never
judges it. Two guards masking each other, the 563 shape. The cost
is a live hole, now pinned as a FINDING: `cache.inputs.files:
        ['gen']`on a gitignored`gen/`folds ZERO files and says
NOTHING — exactly the stale hit the refusal exists to stop, one
directory above where it looks. Not fixed here: the fix is a stat
rather than`Bun.file`, and it would newly refuse a literal
naming a tracked-but-empty directory, which is a separate call.
AND THE `/`IN THAT ARM IS THE WHOLE GUARD, which WAS a hole:
without it`gen-notes.txt`settles the literal`gen`, so a
gitignored `gen`sails through the refusal and folds nothing.
Reachable by naming one file next to another. Closed.
THE PER-RUN MEMO WAS KEYED ON LESS THAN IT LOOKED. The key drops
to the same string without the negations or without the boundary
patterns, and the suite never noticed: the two rows that catch it
now share ONE`GitFilesCache` between calls, which is what gives
the second call the same snapshot ARRAY — the identity the memo
demands before it answers from cache. The negation case is the
everyday one (`build`folds the package,`lint`declares`!**/*.test.ts`): without it the second task is handed the
first's answer and its key stops moving with what it excluded.
FOUR CLASSIFIED, none a hole. `.split(path.sep).join('/')` on the
boundary pattern is a NO-OP on this platform (`path.sep`is`/`)
and the gate is Linux-only. `return [...resolved]` guards against
a caller mutating the memoized array, and both consumers copy
before they sort (`task-hash.ts:123`, `cache.ts:776`), so nothing
reachable observes it. And the OID arm of the existence filter is
a COST gate, not a correctness one: a path with a trusted index
OID is clean per `git status`and therefore on disk, so`isInputOnDisk` would answer the same — the deleted-file case the
comment names loses its OID before it gets here
(`git-oid.test.ts`, "deleted → untrusted"). Its only observable
        is a syscall count, with no public seam to read it from.
566.  DONE (2026-09-21, `cache/inputs.ts`, region: `resolveOutputs`,
      `containedIn`, `isInside`, `removeAll`, `pruneEmptiedDirs`,
      `scanUnion` and the two workspace twins — everything that decides
      what a clean DELETES. 32 mutations run three times (1.3.11, then
      1.4.2, then 1.4.2 against the fixed tree): twenty-two caught, ten
      open, five closed by five rows, TWO SOURCE FIXES).
      THE HEADLINE IS NOT IN THIS FILE AT ALL: THE GATE WAS RUNNING A
      BUN BELOW THE REPO'S OWN FLOOR. This container ships 1.3.11;
      `engines.bun` says `>=1.4` and `ci.yml` pins 1.4.2.
      `Bun.Glob.scanSync` does not descend symlinked directories on
      1.3.11 and DOES on 1.4.0 — so every symlink-escape tripwire here
      is INERT locally, printing no `skip`: the rows pass, they just
      cannot fail. The first sweep scored five containment guards as
      survivors; re-run on 1.4.2, three were CAUGHT. The guard that
      decides what gets DELETED was the one the local gate could not
      see. And the correction above retires the yardstick: the GitHub
      release asset downloads fine through the proxy, and the gate at
      1.4.2 is 44/44 green on three reps, so the three "flappers" were
      1.3.11 failures all along.
      FIX ONE — AN EMPTIED PARENT WAS LEFT STANDING.
      `pruneEmptiedDirs` sorts deepest-first and walks up, and its
      comment claimed "a parent is attempted after every child had its
      turn" — but a `tried` set stopped the second child's walk at a
      parent the FIRST child had already failed to remove. Measured:
      with `dist/a/b/x.js` and `dist/a/c/y.js` both cleaned, `dist/a/`
      was left EMPTY. That is the exact thing the prune exists to
      prevent — an empty directory where the cached entry holds a FILE
      of the same name blocks the restore's rename. The set is gone;
      the walk terminates by construction and a failed rmdir is one
      syscall. A comment claiming a guarantee the code lacks is a
      defect, and this one had been making it since the function was
      written.
      FIX TWO — `scanUnion` HAD AN UNREACHABLE HALF. Its `mode`
      parameter defaulted to `'files'` and BOTH call sites pass
      `'outputs'`, so the whole `files` branch, its `dot: true`
      included, could be deleted with the suite green for the plainest
      reason there is: nothing called it. Removed, along with the
      parameter.
      THE WORST ROW THE SWEEP ASKED FOR IS A SIBLING THAT SHARES A
      PREFIX. `isInside` appends the separator before comparing, and
      that is the whole guard: `<root>/pkg-extra/x` starts with
      `<root>/pkg`. Drop it and BOTH containment passes are fooled at
      once — they call the same function — so `cleanOutputs` deletes a
      sibling project's files. The existing `..` and absolute-glob rows
      never saw it because of their fixture's NAMES: the victim there
      is `<root>/victim`, which fails a bare `startsWith` anyway. The
      two readings only separate when the sibling shares the prefix —
      the 559 mixed-case sort and the 564 insertion order, a third
      time.
      AND A ROW FOR THE MACOS SHAPE, SIMULATED RATHER THAN GUESSED:
      `containedIn` compares REAL paths, so its root must be real too,
      and with a canonical root `realpath(root)` is invisible. A
      project reached through a symlink reproduces darwin's
      `/var/folders` on Linux in three lines — without the realpath
      every output resolves OUTSIDE the project, the clean deletes
      nothing, and a restore lands on stale files. Plus a dotfile
      output (the outputs scan's `dot: true`, unasked-for until now)
      and a bare directory in `outputs.workspaceFiles` (the twin of a
      row the project side already had).
      TEN OPEN, none a hole anyone can reach from a sequential fixture.
      Three of `removeAll`'s four are CAUGHT under a non-root user and
      only skip here — this container runs as root, and a `probe` user
      plus `/opt/probe-bin/bun142` now resolves that axis instead of
      reporting it INCONCLUSIVE. The fourth, `force: true`, tolerates
      an ENOENT no sequential fixture can produce: the match set is a
      Set, so overlapping globs dedup, and the race it guards is with
      the producing task. `ci-no-lexical` is masked by the realpath
      pass (the 563 shape). `ci-unresolvable-kept` needs a directory
      that will not resolve, which as root it always does. And
      `pe-shallowest-first` is now a COST choice rather than a
      correctness one — the fix's retries make the order irrelevant,
      which is worth knowing before someone "optimises" it back.
      ONE ENTRY IN THE TABLE WAS MY OWN BROKEN MUTATION:
      `pe-tried-memo-back` re-adds only the `const tried = new Set()`
      declaration, not its two uses, so it is an unused variable and a
      no-op. Reported as such, not as a survivor; the hand-run
      differential that DOES restore both halves reddens the new row.
567.  DONE (2026-09-21, `cache/inputs.ts`, region: `resolveWorkspaceFiles`
      and `resolveWorkspaceFilesOver` — the SECOND copy of the
      filter-over-git-set design, swept on its own because a fix to the
      project half would pass that half's tests while leaving this one
      live. 29 mutations under Bun 1.4.2: fifteen caught, fourteen
      survivors, seven closed by four rows, seven classified. No source
      change).
      RULE 6 PAID AGAIN, AND THE SHARPEST MISS IS A FIXTURE STANDING IN
      FOR THE CALLER. `snapshotFor(dir, globs)` drops a partition when a
      pending changed path matches one of the caller's globs, and that
      behaviour is WELL pinned — by rows in `workspace-files.test.ts`
      that call `snapshotFor` DIRECTLY. Which is the one door
      `resolveWorkspaceFiles` does not use: hand it `[]` instead of the
      positive globs and nothing ever matches, so a partition
      invalidated mid-run is handed back anyway and a task reads its
      workspace inputs as they were BEFORE its upstream wrote them.
      A stale hit whose whole mechanism was tested from the wrong side
      (the 544 shape). The new row drives it through `resolveInputs`.
      THE SAME ROW'S SIBLING: `set()` after the fallback enumeration.
      Without it the pending-changed bookkeeping is never retired, so
      every later task in the run re-spawns `git ls-files` at the root
      forever. Pinned on what only `set()` decides — the partition
      answering again afterwards — NOT on the OIDs, because
      `markWorkspaceOutputsChanged` drops the changed path's OID by
      itself and a row watching that would pass either way (rule 15; I
      wrote it that way first and it could not fail).
      THE MEMO KEY HAD ONE ARM OF THREE HELD. `[positive, negative,
ownWorkspaceOutputs]`, and only the negation had a witness —
      though all three are reachable the everyday way, two tasks of one
      project declaring different root-level inputs. And `asTrees` is
      applied to all THREE lists here, none of them witnessed, because
      every fixture in the twin spells `shared/**` where a user may
      write `shared`.
      A THIRD SIGHTING OF "SOMETHING ELSE ANSWERS FIRST": the twin's
      `.sort()` cannot be caught, because `git ls-files` ALREADY emits
      sorted paths and the candidates keep that order through
      `path.resolve`. Measured, not assumed. I had written a row for it;
      it could not fail, so it was REMOVED rather than shipped — the
      same call as 563's mode-mask row. Worth recording that the project
      half's sort IS caught, so the two halves differ here.
      SEVEN CLASSIFIED. The empty-positive early return is a
      short-circuit the file already documents as one. The OID arm of
      the existence filter is the same COST gate as the project half's
      (565), and `oidsFor` under a wrong root degrades to the same
      answer for any file that exists. The three literal-set steps
      (`normalizeGlob`, `isLiteralPattern`, `stripTrailingSlash`) need a
      declaration shape this twin's fixtures do not carry; they are the
      project half's own guards, already held there, reached here
      through the shared `settleLiterals` and `assertNoInvisibleLiteral
Inputs` — both of which ARE caught in this twin (the field-name
      argument included).
568.  DONE (2026-09-21, `cache/git-inputs.ts` — the git enumeration
      everything above it trusts: `runGitLsFiles` and its stage parser,
      the OID-trust rules, `GitFilesCache`'s partitions and their
      invalidation, and the small parsers. 34 mutations under Bun
      1.4.2: twenty-two caught, twelve survivors, three closed by three
      rows, nine classified. No source change. THE LAST NEVER-SWEPT
      FILE IN THE CACHE MODULE).
      A FOURTH SIGHTING OF THE WRONG DOOR, AND THE COSTLIEST ONE.
      `vx requires git` has a row — through `populateGitFilesCache`.
      `runGitLsFiles` is the OTHER spawn, taken whenever no partition
      exists (a mid-run re-enumeration, or a project the workspace-wide
      populate left without one), and its exit check had no witness at
      all. Ignore the exit code there and the parse gets empty stdout,
      so the task folds ZERO inputs and caches on an empty set — and
      every later run is a hit, forever, on any tree. The refusal is
      what makes that impossible; nothing had ever entered by that
      door.
      THE SHARED-PREFIX READING, A THIRD TIME AND IN A SECOND FILE.
      `markWorkspaceOutputsChanged` fans a root-relative path to every
      partition that can see it, and `abs.startsWith(key + path.sep)`
      is the whole test — the same guard 566 fixed in `isInside`.
      Without the separator a workspace output under
      `packages/a-extra/` is recorded against `packages/a`, which
      re-spawns git for a directory nothing touched on every later
      task. My first row missed it: MEASURED, the mangled
      `../a-extra/src/gen.ts` is not matched by `src/**` but IS matched
      by `**/*.ts` — so the narrow glob let the mutation through and the
      common one, the glob real configs write, is what sees it.
      AND `some` READ AS `every` BECAUSE EVERY FIXTURE PASSED ONE GLOB.
      `snapshotFor`'s inner `inputGlobs.some(...)` is indistinguishable
      from `every` on a single-element list, and every row in the suite
      handed it exactly one. A task declaring two — `['shared/**',
'schema/**']`, the ordinary shape — would keep a snapshot a change
      to either contradicts. Closed with a two-glob row carrying a
      neither-matches control.
      WELL HELD, and this file is the best-held of the arc's four: the
      OID-trust modes one by one, stage 0, the skip-worktree and
      assume-unchanged flag letters (25 and 49 rows red), the
      `--others` bare-path branch, the record slice, `recordChanged`'s
      append and its OID drop, all three of `set`/`delete`/
      `invalidateWorkspacePartition`, the forwarding to the workspace
      partition and its path rewrite, `core.autocrlf: input`, and the
      rename/copy source token in `git status`.
      NINE CLASSIFIED, and three of them are EQUIVALENT BY
      CONSTRUCTION rather than untested — worth recording so the next
      sweep does not chase them. Dropping the `key === workspaceRoot`
      fast path changes nothing: the general branch computes
      `path.relative(root, abs)`, which for a root-relative path IS the
      path. Forwarding to `wsRoot` when it equals `projectDir` appends
      the same strings twice, and `some()` over duplicates is the same
      answer. An empty `under` list records an empty array, which no
      `some()` can match. The rest need shapes this container cannot
      make or the file already documents: a gitlink OID is kept out by
      a second mechanism downstream (`git-oid.test.ts` says so in
      words), `--show-prefix` never emits a `.` segment, and `git
config --list` lowercases its keys.
      AND THE FIX FROM 566 OWED A NUMBER, WHICH IT DID NOT SURVIVE.
      Principle 1 says a change to the warm path without a number is not
      done, and `pruneEmptiedDirs` is on the clean path every miss and
      every restore. Measured (200 dirs x 20 files, min of 7, three
      interleaved passes, Bun 1.4.2): the ORIGINAL walk-up with its
      `tried` memo is 47 ms and leaves an emptied parent standing;
      566's memo-less walk-up is correct and 60 ms, because every child
      re-attempts the parent it shares. So the correctness fix cost 28%
      on a path nobody would have watched.
      REPLACED WITH A LEVEL-ORDER SWEEP, which is correct for the reason
      the comment always claimed — a parent is attempted only once every
      one of its children has had its turn — and costs ONE rmdir per
      directory instead of one per directory per child. 36-41 ms across
      the same three passes: faster than the buggy original, not just
      than the fix it replaces. The level's removals also go out
      concurrently, which the per-directory walk could not do.
      AND THE WORKSPACE-LEVEL A/B IS A TIE, which is the honest
      reading and worth stating so nobody quotes the per-call number as
      a product win. `vx-bench` at 100 projects x 5 reps, three
      interleaved passes, arm A an immutable worktree at 4a90cc52 (the
      only source delta between the arms is this function and the dead
      `scanUnion` branch): no-cache 388/398/415 vs A's 401/388/413,
      warm-no-restore 94/113/106 vs 116/100/108, warm-restore
      155-161 vs 150-167. Every column overlaps.
      The reason is the FIXTURE, not the change: `generate.ts` gives
      each project one shallow `dist/`, so `pruneEmptiedDirs` has
      almost nothing to walk. The 200-dir x 20-file microbenchmark is
      the shape where the difference lives, and a workspace whose tasks
      emit deep output trees (a bundler with per-route chunks, a
      codegen fanning into hundreds of directories) is where a user
      would see it. Recorded rather than chased: the change is
      justified by CORRECTNESS, and the numbers say it costs nothing to
      take.
      THE CACHE MODULE IS NOW SWEPT END TO END — `cache.ts` (four
      regions, 559-564), `inputs.ts` (three, 565-567) and this. The
      yield should be assumed to fall from here: the next valuable
      thing is Next 6, the warm-run A/B, not another sweep.
569.  DONE (2026-09-21, `workspace/affected.ts` — what `--affected`
      selects, and the security boundary on the base ref. 35 mutations
      under Bun 1.4.2: THIRTY-ONE caught, four survivors, two closed by
      two rows, two classified. No source change).
      PICKED FOR THE FAILURE MODE, not because the arc had momentum:
      `--affected` answering too NARROW is the same silent wrongness as
      a stale hit — a task that should have run does not, and the run
      exits 0. The cache module was done; this is the other surface
      where being quietly wrong looks like success.
      AND IT IS THE BEST-HELD FILE SWEPT ALL SESSION, 31 of 35. The
      whole security boundary (empty ref, leading dash, the missing
      guard, the ref verification), the merge-base choice, all three
      diff flags — `--no-renames`, `--relative`, `-z` — the untracked
      union and its `--exclude-standard`, the `vx-lock.json` exclusion
      in both directions, every arm of the fingerprint widening
      including "cannot tell", the config-import channel, the
      workspaceFiles channel, all four arms of `workspaceGlobsMatch`,
      and both halves of the NUL split. Several at 40+ rows red. The
      file has had a lot of attention and it shows.
      THE THIRD "IGNORES GIT'S EXIT CODE" HOLE OF THE ARC, and the one
      with the worst blast radius. `gitPaths` throws on a non-zero
      exit; without it the parse gets empty stdout, so `changed` is
      EMPTY, every project maps to nothing, and `vx run test
--affected` exits 0 having run nothing — green CI over a broken
      repository, the exact failure `docs/cli.md` states as a
      principle. Reaching it needs a repo where the ref VERIFIES and
      the diff does not, or the guard above answers first (the 561
      shape): deleting the commit's TREE object is that, measured —
      `rev-parse --verify HEAD` and `merge-base` both succeed, `git
diff HEAD` exits 128 with `bad tree object`.
      AND THE `./` IN `gitBytesAt` IS A REAL ANCHOR. `${ref}:./${file}`
      resolves against the cwd — the workspace — rather than the
      repository root, and every fixture in the file had the two in the
      same place, so it had no witness. A workspace under `code/` would
      hand the plugin a `before` that was never its input. The new row
      puts a DECOY lockfile at the repo root, so the reading it
      excludes is "resolved from the wrong anchor", not merely "found
      nothing".
      TWO CLASSIFIED. `--end-of-options` on the diff is defence in
      depth behind a guard that is itself fully held (the leading-dash
      refusal, 5 rows red), so it cannot be isolated — the 563 masking
      shape, but with the outer guard proven rather than absent.
      And `gitBytesAt` swallowing EVERY git failure as "absent at
      ref" needs an error that is neither of the two absence
      messages nor a working `git show`; its sibling arm IS caught, so
      the classification is about reach, not about the guard.
570.  DONE (2026-09-21, an AUDIT rather than a sweep: every `git` spawn
      in `packages/*/src`, checked for an exit test and for a row that
      enters by that call site's own door. Nine call sites; one hole,
      closed by one row).
      WHY AN AUDIT AND NOT A SWEEP: "ignores git's exit code" was a
      hole THREE times in two items — `runGitLsFiles` (568),
      `gitPaths` (569), and `populateGitFilesCache` only had a row
      because someone once wrote one. Three instances of one shape is
      a pattern, and the cheap move is to grep the class rather than
      sweep another file (the rule this repo already states as "when a
      fix covers a class, grep the class in the same commit" —
      belatedly applied).
      EIGHT OF NINE ARE RIGHT, and several are right in a way worth
      recording so nobody "fixes" them: `run-context`'s three spawns
      (HEAD, `origin/HEAD`, `remote.origin.url`) and `doctor`'s config
      read are PROBES whose failure means "unknown", and they say so;
      `detectObjectFormat` tests `exitCode === 0` and defaults to sha1,
      which is a deterministic blob domain either way; `gitIgnored` in
      watch spells out 0 / 1 / anything-else and fails OPEN, which
      costs a spare watch cycle and never a wrong answer.
      THE ONE HOLE IS THE FAIL-SAFE BEHIND THE ENTIRE OID FAST PATH.
      `startGitEnumeration` runs `ls-files` and `status` concurrently:
      the first supplies index OIDs, the second says which paths are
      DIRTY, and a dirty path's OID is dropped because the index no
      longer describes the worktree. `ls`'s exit is checked and throws.
      `status`'s failure degrades to `dirty === null` — and the code
      then correctly empties the trusted map, because with no dirty set
      NO OID can be believed. That line could be deleted with the whole
      suite green: every modified file would fold its OLD COMMITTED
      content into the key. A stale hit on any repo where `git status`
      cannot run.
      THE FIXTURE IS A GITCONFIG TYPO. Reaching the branch needs
      `status` to fail while `ls-files` succeeds, which rules out the
      obvious levers — measured, `.git/index.lock` and a bogus
      `core.fsmonitor` leave BOTH at exit 0, and a pathspec outside the
      repo fails both. `status.showUntrackedFiles=bogus` exits 128 from
      `status` and 0 from `ls-files`: the one shape that reaches it,
      and an ordinary typo in someone's global config.
      AND MY OWN CONTROL CAUGHT MY OWN FIXTURE. The row first had a
      single file, modified — so the healthy arm had no trusted OID
      either and the control read zero both ways. A clean sibling fixes
      it. A control that cannot distinguish the arms is not a control,
      which is the same lesson as 564's missing `existsSync` positive,
      arriving from the other direction.
571.  DONE (2026-09-21, `workspace/package-graph.ts` — the order/reach
      adjacencies, the peer-cycle rule, the bitset closure and its DFS
      twin. 35 mutations under Bun 1.4.2: twenty-five caught, one
      caught BY HANG, nine survivors; one closed by one row, one
      comment corrected, seven classified).
      PICKED AGAINST A NAMED FAILURE MODE, per the bar set in 570: a
      missing REACH edge silently under-selects for `--affected` and
      `--filter pkg...` — a task that should re-run does not — which is
      the same class as a stale hit, approached from the other end from 569. That bar was worth keeping: `exec/env.ts` was the other
      candidate and was REJECTED, 91 lines and four layers with 13 rows
      already on them, with no failure mode nameable beyond "precedence
      could be wrong".
      THE ONE HANG IS A CATCH, NOT A SURVIVOR, and worth the words
      because the classifier cannot tell. Removing the `seen` guard
      from the cyclic DFS fallback loops forever: measured, `bun test
tests/package-graph.test.ts` exits 124 under `timeout 25` and 0
      on pristine. So a cyclic fixture DOES reach the fallback and the
      guard is held — by a hang rather than an assertion.
      MY OWN UPFRONT PREDICTION WAS WRONG, WHICH IS THE USEFUL PART.
      I named the per-package peer sort as a determinism guard before
      writing the table — the comment says so in words: "Peers are
      tried in (package, peer) name order, so which edge of a two-peer
      cycle stays is stable across runs." MEASURED, both manifest
      orders give identical graphs in every arrangement tried (all
      peers cycling, one cycling and one not, and the mutual p<->q
      case), because `reaches(peer, p)` walks edges INTO `p` and adding
      an edge OUT of `p` cannot change it. The stability is real and
      the PACKAGE sort provides it — that arm IS caught. The comment
      claimed a guarantee the peer sort does not give, so it is
      de-claimed rather than left to mislead the next reader.
      THE ROW THAT DID LAND: a package naming ITSELF. Both doors carry
      the same `name !== p.name` guard — the manifest fields and the
      task edges — and neither had a witness. A self-loop is a `^build`
      that waits on itself: a task cycle reported far from the manifest
      that caused it. One row takes both doors.
      A THIRD SIGHTING OF "SOMETHING ELSE ANSWERS FIRST": the
      `directDependents` sort is redundant, because the arrays are
      filled by iterating `reachDeps`, which was built in sorted
      project order — so insertion is already sorted. Same shape as
      567's `.sort()` over git's already-sorted output and 559's
      collation. Left in place (it costs nothing and does not depend on
      a distant invariant), recorded so the next sweep does not chase
      it.
      SIX MORE CLASSIFIED: the unknown-edge index lookup cannot fire
      (edges are filtered by `byName` at insert), the accessor's memo
      and its lazy closure build are COST gates the file already
      measures (12 ms of a 240 ms warm run at 1000 projects), an
      unknown name never reaches the bit scan, and the `reaches` seen
      guard needs an order-graph cycle that the peer rule exists to
      prevent — reachable only through plugin task edges, and no
      fixture builds one.
572.  DONE (2026-09-21, NOT a sweep: the two remaining sweep candidates
      were evaluated against 570's bar and BOTH REJECTED, and an open
      In-flight item was settled by measurement instead).
      SAYING NO IS THE RESULT WORTH RECORDING. `graph/task-graph.ts`
      has 42 rows on 620 lines and its failure mode is LOUD — a wrong
      edge is a build that fails because its dependency had not run.
      `cli/select.ts` is the assembly layer over `affected.ts`, which
      568-569 just swept at 31 of 35; its silent-narrowing mode is the
      one already covered. Neither clears "name the failure mode before
      writing the table", so neither was swept. The cache module,
      `affected.ts`, `package-graph.ts` and every git spawn are done;
      STATUS's Next list holds nothing actionable (1 and 2 are "do it
      when X happens", 6 was done today, 8(c)/(g) are "revisit when",
      the rest are OWNER-gated). The list is exhausted, and that is an
      answer rather than a reason to grind a low-yield file.
      WHAT WAS WORTH DOING INSTEAD: `shard-9`'s SIGILL, open in In
      flight since 2026-09-20 as "about 1 run in 8, on any tree" and
      attributed to this runtime under twelve-way load. Today's Bun
      finding made it testable — the attribution was half right, and
      the missing half is that the runtime is a VERSION.
      MEASURED, interleaved A/B over the shard's own 17 files in one
      process, arms alternating every rep: bun 1.3.11 failed 3 of 24,
      bun 1.4.2 failed 0 of 24. Three in 24 IS the documented 1-in-8;
      zero in 24 against that rate is p = 0.04. Both signatures
      appeared on 1.3.11 and neither on 1.4.2 — two
      `panic(main thread): Segmentation fault` with exit 132, and one
      bare SIGILL the shell reported as `Illegal instruction` with exit
      1, which the old entry's "match the signature (exit 132 + a Bun
      panic + no failing row)" would have MISSED.
      SO THE RE-RUN RITUAL RETIRES WITH THE YARDSTICKS. Five things
      this session turned out to be one thing: the three recorded
      "flappers", the shard-9 SIGILL, and the inert symlink tripwires
      that made 566 score three containment guards as survivors. All
      of them are Bun 1.3.11, a version below this repo's own declared
      floor, running a gate whose CI counterpart pins 1.4.2. The entry
      under Releases already noted the mismatch; nobody had connected
      it to the failures, because the note said upgrading was
      impossible and it was not.
