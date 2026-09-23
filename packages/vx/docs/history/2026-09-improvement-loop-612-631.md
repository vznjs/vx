# Shipped, 2026-09 — improvement-loop items 612–631

The record `docs/STATUS.md` carried until 2026-09-23, moved here whole
when the loop reached twenty entries (item 632; 632 itself opens the next loop). A PREFIX,
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
`2026-09-improvement-loop-592-611.md`; items 632 onward continue in
`docs/STATUS.md`.

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
627.  DONE (2026-09-23, the restore path's spare round trips — the lead
      the restore profile gave, since a restore at 1,000 projects costs
      3.8× the warm run for the same graph). `strace -f -c` of that run
      against main's put three rows on the extract: a `Bun.file.exists()`
      probe before the read (one thread-pool round trip to learn what the
      read's `ENOENT` says itself), a `mkdir -p` of the project directory
      at the top of `extractArtifactStream` (an EEXIST and a stat for a
      directory that always exists; `stage` builds each entry's chain),
      and the base's `realpath` resolved before the ancestor walk that
      needs it only when a directory below the base EXISTS — after a
      clean pruned `dist`, the common restore, never. Now: the vanished
      message comes from the read's `ENOENT` on the artifact's own path
      (the roundtrip row holds it; a staged temp's `ENOENT` keeps its
      own line), the eager `mkdir` is gone, the base resolves lazily.
      Counts per run: `readlink` 1,003 → 3, `mkdir` 2,002 → 1,002,
      `newfstatat` −2,000, `openat` −1,000, `futex` −1,447. Sequential
      restore of the 1,000 artifacts (`packages/vx-bench/restore-bench.ts`,
      new, min of 5, three interleaved rounds): 525–576 µs → 470–484 per
      artifact, −10 %, arms disjoint. The four-worker restore run: min
      658 → 637 ms, median 859 → 841 (7 reps interleaved) — inside this
      box's noise, as every sub-6 % change here is. The `restore: exists`
      span left `docs/modules/timing.md` with the probe.
628.  DONE (2026-09-23, the deferred snapshot's flush sites held one by
      one). 622's row is titled "pending until a read, a prune, a stat
      or close" and drove the read alone; the other three were each
      deleted in turn: close's flush was already held by two run-level
      rows (a restore's snapshot is read by the next run), the flushes
      in `stats()` and `prune()` were survivors. Three rows now, one per
      site, each red with its site's flush gone: a snapshot pending at
      close is what a NEW `Cache` on the directory reads (the `vx watch`
      cycle 625 closed by reading, now a row); `stats()` lands before
      it counts; a prune lands the kept entry's rows and leaves none
      for the evicted one. That last claim was held two ways, and the
      comment in `prune()` said the flush-first was what kept the table
      free of orphans — the flush's own entry check (622) does that in
      either order, so the comment now says which half the order alone
      holds: the kept entry's rows landing whatever the eviction does.
629.  DONE (2026-09-23, 628's class grepped: the sibling flush). The
      deferred `accessed_at` bump (`flushAccessed`) has the same three
      sites, so each was deleted in turn against `tests/cache.test.ts`:
      `stats()` was held by two rows, close and prune were survivors.
      The one that matters: a run reaches neither `stats()` nor
      `prune()`, so its hits mark an entry used ONLY through close's
      flush — with that line gone no run ever bumps `accessed_at` and a
      TTL prune evicts what is hit daily, and nothing in the suite would
      have said so. Two rows now, each red with its site's flush
      deleted: a hit's bump survives close and is what a new `Cache` on
      the directory reads; a prune in the same process does not evict an
      entry hit since the last flush (the cutoff between the ancient
      stamp and the hit's, so the pending bump alone keeps it). The
      rule, in CLAUDE.md: a row titled for several sites drives each.
630.  DONE (2026-09-23, 627's class on the miss side). The cold run at
      1,000 projects traced with `strace -f`, vx's own threads told from
      the tasks' shells by PID (the script keeps the root process, whose
      first line is its own `execve`): 222,150 syscalls, and 1,996 of
      them `mkdir` of the cache directory — `save()` and
      `writeArtifactAndIndex()` each re-created, per save, the directory
      the constructor's `mkdirSync` had made (an EEXIST and a stat, one
      thread-pool round trip each). Both gone. Counts per cold run:
      `mkdir` 2,004 → 4, `newfstatat` −2,000, `write` −2,000 (the
      thread pool's wake per round trip), 222,150 → 216,226 in all. A
      sequential save bench (1,000 one-file saves, min of 5, three
      interleaved rounds each way) could NOT resolve it: whichever arm
      ran first in a pair was faster, in both orders, so the syscall
      count is the number and the wall time claims nothing. Two leads
      from the same trace, refuted: (a) the runner spawns `sh` by name
      and Bun walks PATH for it on every spawn — 14 `stat` per task
      here, 13 failing — but 300 sequential spawns measured 1,102 µs
      by name against 1,081 by `/bin/sh`, then 1,089 against 1,125: a
      tie, and the name is what lets a user's PATH choose the shell;
      (b) the save index is one transaction per save (the tally: 1,000
      `INSERT INTO entries` at 34 µs, 94.7 ms of SQLite in a 2.6 s cold
      run, 3.6 %) — batching the rows to run end would save ~2 % at the
      cost of every save's crash durability, declined. Checked while
      here, by the 628 method: the run's `drainUploads` is held by two
      rows of `orchestrator-remote.test.ts`; every test file a reader
      page names exists (314 names across the packages, none missing).
631.  DONE (2026-09-23, the method of 627 and 630 kept). The syscall
      counter that told vx's threads from the tasks' shells was a
      scratchpad script; it is `packages/vx-bench/strace-vx.ts` now
      (an `strace -f -o` file in, vx-only counts out, a per-syscall diff
      with a second file), checked against the two cold traces of 630:
      222,150 → 216,226, `mkdir` 2,004 → 4. `save-bench.ts` sits beside
      `restore-bench.ts`, its header saying what it resolves (a change
      to the pack or the index) and what it did not (630's two round
      trips inside the order effect). `docs/benchmarks.md` § Profiling
      names the three and reads the `write` row as the thread pool's
      wake per round trip.
