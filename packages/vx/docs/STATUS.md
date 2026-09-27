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
(handoffs 14ay–14ba to the next-log file, item 632), and items 632–654
to `docs/history/2026-09-improvement-loop-632-654.md` that night
(entries 14bb–14bv to the next-log file, item 677), and items 719–743
to `docs/history/2026-09-improvement-loop-719-743.md` on 2026-09-25
(item 764), and items 744–778 to
`docs/history/2026-09-improvement-loop-744-778.md` that afternoon
(item 785), and items 779–819 to
`docs/history/2026-09-improvement-loop-779-819.md` that night (item
826), and items 820–852 to
`docs/history/2026-09-improvement-loop-820-852.md` on 2026-09-26 (item
859), and items 853–892 to
`docs/history/2026-09-improvement-loop-853-892.md` that evening (item
893), and items 893–932 to
`docs/history/2026-09-improvement-loop-893-932.md` that night (item
934), and items 933–972 to
`docs/history/2026-09-improvement-loop-933-972.md` on 2026-09-27 (item
974), and items 973–1012 to
`docs/history/2026-09-improvement-loop-973-1012.md` that afternoon (item
1041), so
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

Parallel sessions landed their own items 1017 (PR #1087, the vx-reapi
chunk stall) and 1018 (the auto-release workflow) while this loop's
1017–1052 were in review. They keep their numbers in a list of their own,
here, so every item number the code cites stays true:

1017. DONE (2026-09-27, CI run 36316687362 on #1084, a diff that touches
      no vx-reapi code). `reapi-e2e` › "stores and restores an artifact
      larger than one chunk" failed after 30 014 ms with `CANCELLED: Call
cancelled`; bazel-remote logged the 1 MiB write `context canceled`
      exactly 30 s after it began. The chunk-stall downgrade keyed on
      `DEADLINE_EXCEEDED` alone. grpc-go (v1.82.1,
      `internal/transport/http2_server.go`) arms a timer at the call's
      `grpc-timeout` and sends RST_STREAM(CANCEL), which grpc-js maps to
      `CANCELLED: Call cancelled` when it lands before the client's own
      timer. Probe, Bun 1.4.2 client, a grpc-go server that reads the first
      message and stops (window never re-granted): 5 of 6 stalled 1 MiB
      writes ended CANCELLED with an idle loop, 6 of 6 with the loop busy
      at the deadline, and the downgrade ran on none of those it should
      have. The hypothesis held.
      - Fix (`wire.ts`): a `CANCELLED` at or past the attempt's own
        deadline is the deadline and takes the downgrade. No slack: the
        header carries `ceil(deadline - now)`, so the server's timer cannot
        fire before the client's. An earlier `CANCELLED` is not retried.
        README and design §14 say so.
      - Rows: `wedged.test.ts` › the chunk stall's deadline spelled by the
        server, against `tests/helpers/stalling-h2.ts` (raw HTTP/2, no
        WINDOW_UPDATE, RST at a set delay, a separate process so the row
        can block its loop until the RST is sent). The at-deadline row is
        red without the fix; the early-CANCELLED control is red if any
        CANCELLED downgrades; the single-message control stays.

1018. DONE (2026-09-27, the owner's "each time we merge we should have
      an auto release"). `.github/workflows/auto-release.yml` runs when CI
      completes green on a push to `main`: it tags the commit with the next
      patch version, creates the GitHub release (notes from the merged PR
      titles) and dispatches `release.yml` and `npm.yml`, because a release
      the workflow token creates fires no `release` event. `release.yml`
      takes the tag as a dispatch input. Only main's current tip is
      released (a slower CI run for an older commit skips), and a commit
      already tagged is skipped. `tests/auto-release.unsafe.test.ts` reads
      the three workflow files: the trigger names the workflow `ci.yml`
      calls itself, the green-push guard, the two skips, the job's two
      grants, and every `-f` input a dispatch passes is one its target
      declares (red with `release.yml`'s `tag` input renamed). Written in a
      container whose Bun had been replaced (item 779's hazard), so CI was
      this change's gate; the rows were checked against the files with a
      YAML 1.1 reader first. `docs/cli.md` § Releasing.

The loop itself:

1013. DONE (2026-09-27, a lockfile review agent's lead 1). `reachDigests`
      folded a dependency cycle from its members' material and its child
      components, never its edges, and every member shares the cycle's
      digest. With `x`, `y@1.0.0`, `y@1.1.0` and `z` in one cycle, an
      importer moved from `y@1.0.0` to `y@1.1.0` (the lockfile side of
      `pnpm update y`) kept `a#build`'s key and `--affected` said
      "nothing affected"; two members swapping targets did the same.
      - Fix (`lockfile-claim.ts`): a member folds as its material and the
        sorted materials its edges land on (a self-loop reaches nothing new
        and is left out). `@vzn/vx-lockfile`'s `DIGEST_VERSION` 4 → 5 retires
        the memos. `modules/lockfile-claim.md` says so.
      - Row: `lockfile-claim.test.ts` › moves when an edge is retargeted
        inside a cycle (the importer's edge and a swap), with a reordering
        as the control. Red without the fix.

1014. DONE (2026-09-27, the lockfile review's lead 2). bun.lock records a
      patch by path (`patchedDependencies`), never a hash of its content:
      after `bun patch --commit` with a new edit, only
      `patches/is-number@7.0.0.patch` changed, `bun.lock` stayed
      byte-identical, and every key and `--affected` stayed put while the
      install applied the new patch. Core's fingerprint has no patch files
      either.
      - Fix (`lockfile-claim.ts`, `@vzn/vx-lockfile`'s `bun.ts`): a claim
        may name `extraFiles` from the lockfile's text; their content hashes
        reach `digest`, the memo's identity and the workspace-scope key. The
        memo records the files and hashes, so a warm run re-hashes and never
        parses unless one moved. bun's parser names its patch files and
        folds their hashes into every workspace (the path already went
        there); no patch keys as before. `DIGEST_VERSION` 5 → 6.
        `modules/lockfile-claim.md` and the package README say so.
        `--affected` does not yet see a patch edit (a path no project owns).
      - Rows: `lockfile-claim.test.ts` › an edited extra file moves the key
        (a new process, the same one), a warm run with an unchanged file
        does not parse (control); `@vzn/vx-lockfile`'s bun rows › a patch
        file's content moves every workspace. Red without the fix.

1015. DONE (2026-09-27, the watch review's lead 5, a core stale hit). The
      re-check before a save hashed an input whose ctime moved and compared
      content, so an input edited and edited BACK while the command ran
      matched the key again: with `src/a.ts` five → six → five during the
      command, the entry filed six's output under five's key, and after
      `rm -rf dist` the next run restored `six` over `five` with no warning.
      Under `vx watch`, undo during a cycle did the same.
      - Fix (`task-hash.ts`, `execute-task.ts`): an input written at or
        after the describe (just before the command) has moved whatever it
        holds, and is not read; a write before it (an upstream's) is judged
        by content as before. The cost, taken on purpose: a task that
        rewrites its own input to the same bytes is no longer saved (item
        743's control is flipped). `caching.md` says so.
      - Rows: `inputs-moved.test.ts` › edited and reverted while the
        command runs (withheld, and the next run rebuilds), a same-bytes
        rewrite is not saved, and a `movedInput` unit row with a
        before-the-command write as the control. Red without the fix.

1016. DONE (2026-09-27, the watch review's lead 2). A recursive watcher
      dropped only its own probe (`filename === WATCH_PROBE`); a nested
      project's arm or a member base inside a project writes its probe
      under this watcher, which saw `examples/ex/.vx-watch-probe` and ran a
      cycle right after "watching", with no edit made. Under
      `vx watch dev --filter a` the dev server restarted. The poller
      already skipped the name at any depth.
      - Fix (`watch.ts` `armWatcher`): an event whose basename is the probe
        is dropped; only the watcher's own marks it ready. `cli.md` says so.
      - Row: `watch-rules.test.ts` › armWatcher drops another arm's probe,
        with an edit beside it delivered. Red without the fix.

1017. DONE (2026-09-27, the watch review's lead 3). A `vx.config.mjs`
      that did not parse ended `vx watch` at start (a config error, exit 1), while the same break mid-watch printed "cycle failed"
      and the fix re-ran: the initial run had no catch.
      - Fix (`watch.ts`): the initial run's failure is a failed cycle like
        any other; the sweep and the arm go on. `cli.md` says so.
      - Row: `watch-signals.test.ts` › a config broken at start is a failed
        cycle, and the fix re-runs (e2e). Red without the fix.

1018. DONE (2026-09-27, the watch review). The package glob list
      was fixed at start. A root `package.json` was no event unless the
      root was a project, `pnpm-workspace.yaml` was a cycle that ran the
      new packages without re-reading the set, and the member bases were
      the ones at start. A glob added under `vx watch` ran its packages
      once, then their edits were silence.
      - Fix (`watch.ts`): the root arms hear the root `package.json`, a
        root fingerprint file re-reads the set, and a re-read arms the
        member bases it finds and drops the gone ones. `cli.md` says so,
        and that `--affected`, like `--filter`, is resolved at start.
      - Rows: `watch-loop-members.test.ts` › a glob added in
        `pnpm-workspace.yaml`, and in the root `workspaces`, is watched
        (e2e), each piece red when removed; `watch-rules.test.ts` › the
        root filter keeps `package.json`.
      - Refuted (the same review): a second Ctrl-C during the
        shutdown grace leaks no task. vx exits 130 at once, as `vx run`
        does, and the group guard SIGKILLs the task's group; a probe that
        read the task as alive had counted its zombie.

1019. DONE (2026-09-27, the graph review's lead 1). `--exclude-dependencies`
      kept an edge only to a task still scheduled (item 980), and took
      nothing back through a dropped one: in `test → gen → build` with
      `gen` dropped and `build` requested, `test` and `build` ran at once,
      and `test` read `build`'s output mid-rewrite or the run before's.
      - Fix (`task-graph.ts` `excludeDependencies`): a scheduled task
        reached through dropped ones gets an edge, listed in
        `TaskNode.orderOnly`. The key sites leave it out (`keyUpstream`,
        and `keyedDeps` where `excluded-keys.ts` derives a dropped task's
        key), since the dropped key already folds it; folded twice, the
        key was one no full run derives. `cli.md` and the module pages
        say so.
      - Rows: `task-graph.test.ts` › orders a task after what it reached
        through a dropped one (`'all'` and a name list);
        `stale-hit.test.ts` › the reached task runs first and keys once,
        and a chain with two dropped links keys as the full run. Each
        red with its piece removed.

1020. DONE (2026-09-27, the plugin-seam review's lead 1). A plugin's raw
      cache layer that threw ended the chain's walk above the local
      floor. A throwing `get` failed the task as an internal error naming
      no plugin; a throwing `save` kept the entry out of the local store,
      so nothing ever cached. "A remote cache error degrades to a miss"
      held only inside `LayeredCache`.
      - Fix (`chained-cache.ts`): each layer's lookup and save is
        isolated; a lookup throw is a miss there, a save throw skips that
        layer, a save failing everywhere still throws. `resolveCache`
        warns once per layer and method, naming the plugin.
        `modules/chained-cache.md` says so.
      - Rows: `chained-cache.test.ts` › a lookup that throws is a miss
        there; a save that throws in one layer saves in the others, in
        every layer it throws; a throwing plugin layer is named once per
        method. Each red with its piece removed.

1021. DONE (2026-09-27, the plugin-seam review's lead 2). `teardown()`
      ran on the normal end of a run alone, though every plugin's
      `cache` and `executor` factories run in `prepareRun`. A refused
      setup, a throwing executor factory or `accepts()`, an unresolved
      name, a nested-run refusal and every `--dry` plan left what those
      opened (`@vzn/vx-reapi`'s gRPC clients) held, once per cycle
      under `vx watch`.
      - Fix (`run.ts`): one idempotent `teardown` for the run, called on
        every exit after `prepareRun`, with the steps before the run's
        own try routed through it; `planRun` tears down in its finally.
        A plugin whose `setup` threw is left out (`PluginSetupError`
        names it). `modules/plugin.md` and `plugin-host.md` say so.
      - Rows: `plugin-teardown.test.ts` › the lifecycle is reached on a
        run that never started (six exits). Each red with its call
        removed. No row drives the empty-graph return (defensive, per its comment) or the finally's call (a throw inside the schedule).

1022. DONE (2026-09-27, the plugin-seam review's lead 2, its second
      half). An executor's `accepts()` or `demand()` that threw reached
      the user as a bare stack (`vx: Error: accepts boom at
selectExecutor …`) naming no plugin, and a `demand()` throw from
      the completion path would do so mid-run. Every other hook failure
      is a `UserError` naming the plugin.
      - Fix: `selectExecutor` refuses a throwing `accepts` as a
        `UserError` its `label` names; the run passes `executorLabel`
        (`plugin-host.ts`), which names the plugin and executor.
        `demand` is a hint, as `admit` is: a throw is warned once by
        name and that executor is asked no more. The module pages say so.
      - Rows: `executor.test.ts` › an accepts() that throws is refused as
        the label names it; `plugin-teardown.test.ts` › the e2e message,
        and a throwing demand() named once while the run succeeds. Each
        red with its piece removed.

1023. DONE (2026-09-27, the plugin-seam review's lead 3). An `admit`
      policy that refused while nothing local was running stalled the
      run: only a completion asks the predicate again, so the scheduler
      parked every ready task and the run ended "something it awaited
      can never settle", exit 1, no task run, though the stage's own doc
      said the predicate is never the reason a task hangs.
      - Fix (`plugin-host.ts` `buildAdmission`): such a refusal is
        overridden, with one warning per plugin naming it. The module
        pages say so.
      - Row: `plugin-pipeline.test.ts` › a policy that refuses with
        nothing running is overridden once, by name. Red with the
        override removed, and with the once-per-plugin gate removed.

1024. DONE (2026-09-27, the graph review's lead 2). The typo guard judged
      a bare task name against the scope, and under `--affected` or a
      `[ref]` filter the scope is what changed: after a docs-only commit
      `vx run test --affected` exited 1 "No projects declare task(s):
      test", and `vx run lint test --affected` refused before running the
      `lint` the changed project declared. `select.ts` says a docs-only
      commit must not turn `--affected` red.
      - Fix: `RunOptions.selectedByDiff` (the CLI sets it when an include
        filter is a diff); `prepareRun` then judges bare names against
        the whole workspace, loading the rest only when one is left
        unresolved, and a run left with nothing is `none-affected`: exit
        0 with a line, `--dry` too. `cli.md` and `modules/options.md` say
        so.
      - Rows: `affected-sparse-tasks.test.ts` (e2e), with a typo and a
        user-named scope as controls. Each piece red when removed.

1025. DONE (2026-09-27, the graph review's lead 3). Inside a member
      reached through a link (`packages/b -> ../ext/b`), a run with no
      scope flag said "not inside a project": the kernel's cwd is
      `ext/b`, and discovery keeps `packages/b` (item 987).
      - Fix (`select.ts` `findCwdProject`): when no member holds the cwd
        as discovered, the members are realpathed and asked again. Only
        a run no plain match placed pays those syscalls. The limit: a
        root project (`'.'`) holds every cwd plainly, so there the
        fallback is never reached. `cli.md` says so.
      - Row: `cli.test.ts` › cwd inside a member reached through a link
        resolves to that member. Red with the fallback removed.

1026. DONE (2026-09-27, the graph review's lead 4). An
      `--exclude-dependencies=<name>` no project declares dropped
      nothing, silently: `=biuld` planned and ran the whole chain, exit
      0, though every other name the user types must resolve.
      - Fix (`prepare.ts`): each listed name must be declared by some
        project, judged against the whole workspace (the rest loaded
        only when a name is missing from the scope's configs); otherwise
        a `UserError` with the nearest name, after the graph, so a config
        error (a `^name` nobody declares) is named first. `cli.md` says
        so.
      - Row: `cli.test.ts` › an --exclude-dependencies name no project
        declares is refused, with a known name and one only an
        out-of-scope project declares as controls. Red with the refusal
        removed, and with the workspace fallback removed.

1027. DONE (2026-09-27, the plugin-seam review's lead 4). A telemetry
      sink's `name` is optional, and a nameless sink that threw or
      failed to flush was reported as `telemetry sink 'undefined'`.
      - Fix (`telemetry.ts`, `telemetry-host.ts`): the host maps each
        nameless sink to its plugin's name (with its place when the
        plugin returns several); a sink no plugin owns goes by its place
        in the list. `modules/telemetry.md` says so.
      - Row: `telemetry-lifecycle.test.ts` › a sink with no name is named
        by its plugin, and by its place in a list (both warning sites).
        Each piece red when removed.

1028. DONE (2026-09-27, the plugin-seam review's lead 4, its second
      half). A plugin's name is its package's, so two plugins of one
      package returning the same key part folded two parts named alike:
      no stale hit, but when only one moved `vx why` said "cache key
      changed but no component-level difference was recorded".
      - Fix (`plugin-host.ts` `applyKeyHooks`): parts sort by name, then
        value, and a repeated name takes `#2`, `#3`. A workspace whose
        plugins repeat no name keys as before, and swapping two twins
        still keys nothing. `caching.md` says so. No `CACHE_VERSION`
        bump: only a repeated name's key moves, and that is a miss once.
      - Row: `plugin-pipeline.test.ts` › parts named alike are told
        apart, in value order, and still fold both. Red without the
        suffix, and without the value order.

1029. DONE (2026-09-27, found while landing 1026). Item 1021 tore the
      plugins down on every exit of `run()`, but a throw inside
      `prepareRun` after the cache and executor factories ran (a stage
      hook, a `^name` nobody declares, a cycle, an unknown exclude name)
      reached neither `run()` nor `planRun`: the cache stayed open and
      no plugin was torn down, once per failed cycle under `vx watch`.
      - Fix (`prepare.ts`): everything after the cache resolution sits in
        one try; a throw tears the plugins down, closes the cache and
        rethrows. 1026's own close went with it (a second close could
        throw). `modules/plugin-host.md` says so.
      - Row: `plugin-teardown.test.ts` › a stage that throws inside
        prepareRun tears every plugin down (a run and a plan, the
        layer's close logged). Red without the teardown, and without the
        close.

1030. DONE (2026-09-27, the graph review's lead 5). Three filter shapes
      misled. `...^c` for a `c` nothing depends on (and `a^...` for an
      `a` that depends on nothing) said "no projects matched filter(s)",
      a typo's message for a pattern that matched. `...` was hinted "Did
      you mean one?". A bare `!` (`--filter "!$UNSET"`) excluded nothing
      and every project ran behind one warning line.
      - Fix: `parseFilter` refuses a filter that names no project;
        `applyFilters` reports a matched pattern with an empty walk
        (`onEmptyWalk`), and `select.ts` names what it matched. `cli.md`
        says so.
      - Row: `cli.test.ts` › a filter that matched but walked to nothing,
        or names no project, says so (four shapes, exact messages). Red
        without either piece.

1031. DONE (2026-09-27, the vx-migrate review's leads 2 and 3). `turbo()`
      passed Turbo's globs through as they were. A bracket is a literal
      in vx and a class in Turbo, so `inputs: ['src/**/*.[jt]s']` keyed
      on nothing and an edit replayed the old build, and
      `outputs: ['dist/**/*.[cm]js']` matched nothing, so a hit restored
      nothing. An output whose first segment is a wildcard
      (`**/*.d.ts`) reached the sources: vx cleans outputs before a run
      and a restore, Turbo never does, and a hand-written
      `src/env.d.ts` was deleted, an uncommitted edit to it lost.
      - Fix: `nxGlob` moved to `glob-grammar.ts` (`minimatchToVx`), and
        `turbo()` runs inputs and outputs (past the first segment,
        item 667) through it; an input with no safe form widens to `**/*`
        with a todo. A wildcard first segment runs the task uncached with
        a todo, with or without a negation. The README says so.
      - Rows: `turbo-map-sweep.test.ts` › Turbo's glob grammar (inputs,
        outputs, two wildcard roots). Each piece red when removed.

1032. DONE (2026-09-27, the vx-migrate review's lead 1, a stale hit).
      Turbo hashes the `.env` files turbo.json names although git ignores
      them; `turbo()` mapped them as file globs, which read only what git
      reports. An edit to `packages/a/.env.local` under
      `inputs: ['$TURBO_DEFAULT$', '.env*']`, or to a root `.env.local`
      under create-turbo's `globalDependencies: ['**/.env.*local']`, was
      served from cache with the old value. Turbo 1's `dotEnv` with no
      `inputs` was the same, and a literal `.env.local` input failed the
      task on core's gitignored-literal refusal.
      - Fix (`turbo-map.ts`): a `.env`-shaped input leaves the file list
        and the task gets a probe that hashes every `.env` file under the
        package (`cache.inputs.runtime`), or the workspace for a root
        entry (`workspaceRuntime`); a superset, so a change misses. The
        README says so.
      - Rows: `turbo.test.ts` › a gitignored .env file a task or the root
        names re-keys the task (e2e); `turbo-map-sweep.test.ts` › `.env`
        inputs (five shapes). Each piece red when removed.

1033. DONE (2026-09-27, the CLI-verb review's leads 1 to 3). `vx init`
      wrote workspaces the next command read differently from its
      report. A hand-written `vx.workspace.mts` was not seen, and the
      `vx.workspace.ts` written beside it won by load order, dropping the
      user's plugins. `--force` over a `vx.config.mjs` wrote a
      `vx.config.ts` beside it, and the loader ran the old one or the
      new one by its order. Scripts named `lint#fix` or `^up` became
      tasks item 1000's schema refuses, so every later command failed,
      and a `__proto__` script set the tasks object's prototype.
      - Fix (`migration.ts`, `migrate-scripts.ts`): the workspace check
        reads `WORKSPACE_CONFIG_FILENAMES`; `--force` removes a config
        of another extension it replaces and says `replaced:`; a
        refused name is a skipped task with a TODO, by the schema's own
        `taskNameProblem` (exported for this); `__proto__` is a computed
        key. `@vzn/vx-migrate` shares all of it. `cli.md` says so.
      - Rows: `init.test.ts` › vx init writes what the next run reads
        (three rows, e2e). Each of the four pieces red when removed.

1034. DONE (2026-09-27, the CLI-verb review's low leads). A duration
      chose its unit before rounding to it: `vx last` printed 119,600 ms
      as `1m 60s` and 59,996 ms as `60.00s`, and every run's output
      printed 999.6 ms as `1000ms`.
      - Fix: one `formatElapsed` (`util/num.ts`) behind both formatters
        rounds to the unit shown first. `modules/util-num.md` says so.
      - Row: `util-num.test.ts` › formatElapsed (eight values). Four red
        under the old algorithm.

1035. DONE (2026-09-27, the CLI-verb review's low leads). `vx help run`
      dropped its argument and printed the whole reference.
      - Fix: `vx help <verb>` prints the same cut as `vx <verb> --help`
        for a core verb; anything else gets the whole reference, which
        lists the plugin verbs. `cli.md` and the Usage line say so.
      - Row: `cli.test.ts` › vx help <verb> prints that verb's help. Red
        without the dispatch change.

1036. DONE (2026-09-27, the config-cache review). Three stale configs and
      one open gate in the config evaluation cache.
      - A member directory linked in from elsewhere was indexed by the
        paths its evaluation found; retargeted to a config of the same
        bytes with another preset, the warm path replayed the old
        target's evaluation on every run. Such a closure is now never
        indexed; a link above the workspace root still is.
      - `IMPORT_RE`'s lazy body ran from `export type Mode = …` into the
        next line's impure `@vzn/vx` import and passed it as a type
        import (a regression of item 888 in semicolon-free files), and
        an `export … from` after a `}` on its line was never scanned. A
        statement's body now stops at the next `import` or `export`, and
        no line start is required.
      - `const { random } = Math` passed the deny-list: `random` is
        denied as a word.
      - Rows: `config-cache.test.ts` › a member directory reached through
        a link is never indexed; an `export … from` that does not start
        its line; the item 888 list; the deny-list's `random`. Each red
        with its fix reverted, and the symlinked-root control red under
        a strict link check.
      - Left: `vx mcp` re-imports `vx.workspace.ts` in-process and serves
        a local plugin's old imports (the review's fifth lead).

1037. DONE (2026-09-27, the vx-reapi review's first and third leads).
      Remote execution recorded a result under a key its inputs no longer
      matched, and ran without the one file the key always folds.
      - The input tree is read after the key was taken, and the record
        was written under the key regardless. A file edited in between
        ran, core withheld its own save, and the record did not: with
        the file restored, the next run on any machine replayed the
        edited outputs. `buildInputTree` now holds each file to the git
        blob id the key folded (sha1 or sha256 by its length; a
        symlink's target), and a file moved or gone withholds the record
        with a warning.
      - The project's `package.json` is in every key but was never in the
        input root: a worker ran `"type": "module"` code as CommonJS. It
        now ships, held to `packageJsonDigest` like any input.
      - Rows: `executor-sweep.test.ts` › an input whose bytes moved since
        the key was taken runs, but is not recorded under it (edited,
        removed, and restored as the control); the project's
        package.json is in the input root. Each red with its fix removed.
        The sweep fixtures now carry the real digest of their input.
      - Left from the review: materialising a coarse output directory
        writes non-output entries over sources; an evicted blob replays
        green; a failed Tree read while recording fails a success; a
        whole-tree capture records `pkg/`.

1038. DONE (2026-09-27, the vx-reapi review's second lead). Remote
      execution wrote a coarse output capture back whole, sources
      included.
      - `src/*.gen.js` has no REAPI spelling past its wildcard, so it is
        captured as `src`, and the worker returns the whole directory.
        `materialiseTree` wrote every entry: the worker's copy of
        `src/app.js` replaced an edit made during the action, and core,
        finding its input rewritten, never saved the task (every run
        missed). Only an entry a declared glob names, or one under a
        directory it names, is written now; a directory a literal glob
        names is still written whole. A record replay applies the same
        filter, with the project's own path carried in.
      - Row: `executor.test.ts` › a directory captured for a wildcard
        glob writes only what the glob names (with the literal control).
        Red when every capture is written whole.

1039. DONE (2026-09-27, the vx-reapi review's fourth lead). A record
      replay missing a blob inside its Tree went green with a declared
      output absent, on every run.
      - `FindMissingBlobs` checks a Tree by its own digest, not what it
        holds, and under a whole-tree capture (`*.txt`) `materialiseTree`
        only warned about a blob it could not fetch. A replay is a cache
        read: it now fails on a missing blob under any capture, so the
        existing fallback executes. A fresh result under a whole-tree
        capture still warns.
      - Row: `executor-sweep.test.ts` › a replay missing a blob inside
        its Tree executes, whatever the capture. Red with the replay's
        strictness removed.

1040. DONE (2026-09-27, the vx-reapi review's last two leads). The
      execution record a success writes could fail the task, or name its
      capture wrongly.
      - Splitting a capture into its glob's matches reads the capture's
        Tree, and a Read that failed there threw out of the record, which
        is best-effort: a task whose action had succeeded failed with
        `internal error … 13 INTERNAL`. The entry is now recorded whole
        with a warning, as an unreadable Tree already was.
      - A whole-tree capture's path is `''`, which the rebase spelled
        `pkg/`: no decomposition matched it, and a graft of it built a
        directory with an empty name. It is recorded at `pkg`.
      - Rows: `executor-helpers-sweep.test.ts` › a whole-tree capture is
        recorded at the project; a Tree read that fails while recording
        records it whole, and the task stands. Each red with its fix
        removed. The vx-reapi review's six leads are all closed.

1041. DONE (2026-09-27, the trim the loop passed forty at). Items
      973–1012 moved to `docs/history/2026-09-improvement-loop-973-1012.md`
      in this commit, a prefix as the rule says. What that stretch was:
      review agents' reproduced leads, area by area — the cache key's
      git-state stale hits (976–978), the graph's filters and
      `--exclude-dependencies` (979–981), workspace discovery (984–990),
      run flags (991–993), config validation and env isolation
      (994–1002), sandbox grants (1003, 1006, 1007, 1010, 1011) and run
      history (1004, 1005, 1008, 1009, 1012). The loop here is the
      record from 1013.

1042. DONE (2026-09-27, the CLI-verb review's low leads). The refusal a
      reading verb prints for an earlier index schema said "a reading verb
      leaves it untouched", and `vx show`, which opens the index to store
      config evaluations, resets it. The message now speaks for the verb
      that printed it: this verb leaves it untouched, the next `vx run`
      resets it.
      - Row: `schema-reset-notice.test.ts` › each reading verb's refusal
        now pins the sentence; four red under the old wording.

1043. DONE (2026-09-27, the CLI-verb review's low leads). `turbo()` in a
      workspace with no `turbo.json` or `turbo.jsonc` at its root failed
      the run with a bare ENOENT and a stack. It is now a `UserError`
      that names the lookup and the remedy (add the config, or remove
      `turbo()`); the vx-migrate README says so.
      - Row: `turbo-map-sweep.test.ts` › a workspace with no Turbo config
        is refused as a user error that names the remedy. Red without
        the check.

1044. DONE (2026-09-27, the config-cache review's minor leads). `vx lock
--check` reported a config whose bytes were unchanged but whose
      evaluation differed as "env-dependent config? … remove env reads
      from config", and an edited preset the config imports is the same
      drift: its author went looking for env reads the config did not
      have. The message names both causes now.
      - Row: `lock.test.ts` › freezes env-dependent configs pins the
        whole sentence; red under the old wording.

1045. DONE (2026-09-27, the CLI-verb review's low leads). `vx init` put
      the cache TODO only on a `build` with a command. A `build` that
      delegates (`build: pnpm run compile`) is a group, so no task got
      one, while the header said `build` carries it. The TODO now rides
      with `^build` on the task the group reaches that runs a command,
      and the header says "`build`, or the script it delegates to".
      `cli.md` says so.
      - Row: `init.test.ts` › a `build` that only delegates puts the
        cache TODO on the task that works (direct, a chain, and a
        commanded `build` as the control). Red without the move.

1046. DONE (2026-09-27, the config-cache review's fifth lead). `vx mcp`
      reloads `vx.workspace.ts` on every call, and a repeat load busts
      only the config's own URL: Bun answered its imports from the
      module registry, so an edited local plugin kept its first version
      and `listTasks` served the old tasks with no word. Bun cannot
      evaluate an imported module again in one process, so a repeat load
      now walks the config's relative imports and refuses, naming the
      file, once one changed since the first successful load; `vx watch`
      already says to restart when it sees such an edit. A process that
      loads once pays nothing. `modules/project-loader.md` says so, and
      no longer claims nothing there feeds a key (a plugin's hooks do).
      - Row: `project-loader.test.ts` › a repeat load refuses once a file
        the config imports changed, naming it (with an unchanged reload
        and a config-only edit as controls). Red without the check.

1047. DONE (2026-09-27, the gate at 1045 went red on it). The run-lock
      e2e row "the second waits for the first and says so" held the first
      run's task for a fixed 1.5 s after its marker, and the notice prints
      after one second of waiting: a second run that took over half a
      second to start (the gate's twelve shards on four workers) took the
      lock inside the second and printed nothing. The first task now waits
      for a `release` file the row writes once the second has printed the
      notice (or after ten seconds), so the row makes no claim about time.
      - Differential: with the notice's delay at 60 s the row fails at the
        ten-second release; with the fix it passes, and the file's other
        three rows are unchanged.

1048. SUPERSEDED (2026-09-27) by A-3 (`docs/history/ws-a.md`), which
      landed first: a saved artifact is renamed into place inside its index transaction.

1049. SUPERSEDED (2026-09-27) by A-4 (`docs/history/ws-a.md`), which
      landed first: an output's mode 000 and an mtime at or before 1970 round-trip.

1050. DONE (2026-09-27, the nx() review's lead 2). `nx()` read the raw
      `nx.json` and ignored its `extends`: named inputs a base declared
      (`default`, `sharedGlobals`) fell back to `{projectRoot}/**` with no
      word, so a `global.cfg` edit Nx re-ran on was a hit here (a stale
      hit, reproduced with Nx 22.7.12). `readNxJson` resolves the chain as
      Nx does (a path or package from the file's directory, merged
      shallowly, the base first), and the snapshot's freshness stats every
      file in it. The README and the design doc say so.
      - Rows: `nx-map-sweep.test.ts` › a base's named inputs apply, and
        nx.json's own field replaces the base's whole; `nx.test.ts` › a
        base nx.json extends, newer than the snapshot, re-exports. Each red
        without its half.
      - Lead 1 (a source import's edge the snapshot misses) is Next 26: a
        fix puts a graph export into every edit, which needs numbers.

1051. DONE (2026-09-27, the nx() review's leads 5 and 6). Two graph
      shapes stopped whole runs.
      - A negated output (`!{projectRoot}/dist/cache`, which Nx takes)
        was mapped to a `!` workspace glob, and core refused the
        project's config: none of its tasks ran. It is dropped with a
        todo; the positive outputs stay and save a little more.
      - A `^target` only the root project declared kept its edge: the
        root has no package to attach to under the plugin, yet its tasks
        counted as declared, and core refused the run ("no project in the
        workspace declares prep"). The mapper now counts only the
        projects the plugin will attach (`attached`); the CLI, which
        writes the root's config too, passes none.
      - Rows: `nx-helpers-sweep.test.ts` › a negated output is dropped
        with a todo; `nx-map-sweep.test.ts` › a `^target` only an
        unattached project declares (with the CLI control); `nx.test.ts`
        › the same through the plugin, the run planning. Each red without
        its change.

1052. DONE (2026-09-27, the nx() review's lead 3). A cached Nx target
      with no `outputs` was mapped with none, and Nx caches one anyway
      (`getOutputsForTargetAndConfiguration`): its `options.outputPath`,
      else for `build` and `prepare` `dist/{root}`, `{root}/dist`,
      `{root}/build` and `{root}/public`. A hit restored nothing (a
      `build` writing `dist/out.txt`, reproduced by the review).
      `nxDefaultOutputs` applies the rule for an absent `outputs` (an
      explicit `[]` stays none). `build/` and `public/` are left to a todo:
      vx cleans an output before the run, and a project's `public/` is
      usually committed assets Nx, never cleaning, leaves alone.
      - Row: `nx-map-sweep.test.ts` › a cached target that declares no
        outputs (outputPath, the dist pair with the todo, none for a
        `test`, and the explicit-empty control). Red without the rule.
      - The extensionless-output lead is Next 27: its fix costs nx()
        directory outputs a warm-hit short-circuit, which needs numbers.

1053. DONE (2026-09-27, the nx() review's leads 7 and 8a). `dependsOn`
      edges Nx takes were dropped: `{ target, projects: "b" }` (Nx reads a
      lone string as `["b"]`) was "not representable", and a list's
      entries were looked up as package names, so `tag:lib` and `lib-*`
      dropped their edges. `projects` is now read as Nx's
      `findMatchingProjects` reads it (`matchNxProjects`: names, `*`
      patterns, `tag:` patterns, `!` exclusions, a list opening with one
      starting from every node) over the graph's nodes and their tags; an
      exact name that is no package still draws its todo. And `params:
"ignore"`, Nx's default, drew a todo about forwarding; only
      `forward` does now.
      - Rows: `nx-helpers-sweep.test.ts` › a lone projects string is a
        one-entry list, only params forward is a todo, and
        `matchNxProjects`; `nx-map-sweep.test.ts` › a dependsOn projects
        pattern reaches the nodes whose tags or names it matches. Each red
        with its change reverted.
      - Left from the review: `nxCache`'s kept body can be cancelled by a
        concurrent probe (a refetch, not a wrong answer; unmeasured).

1054. DONE (2026-09-27, Next 27's measurement; STATUS only). A warm hit
      over 5,000 output files costs 47 ms more (min of 15, interleaved)
      with the bare literal `dist` than with `dist/**`: only the glob form
      gets `outputDirsCurrent`'s directory-mtime short-circuit. Next 27
      carries the numbers and the candidate that keeps it.

1055. DONE (2026-09-27, the telemetry review's lead 1). A telemetry sink
      hung past its flush deadline could hold `vx` open: core stops
      waiting at the deadline (3 s) but a request still in flight keeps
      the event loop alive, and `bin.ts` exits when the loop drains. A
      hanging GitHub API kept `vx run` alive until the CI job's own
      timeout (vx-github's POST had no timeout), and a hanging collector
      held it for vx-otel's `timeoutMs`, 15 s by default.
      - Seam: `TelemetrySink.flush(signal)` — core passes an
        `AbortSignal` it aborts at the deadline. vx-github passes it to the
        check-run POST, vx-otel to each export beside its own timer.
        `modules/telemetry-host.md` and the sink blog post say so.
      - Rows: `telemetry-lifecycle.test.ts` › the signal a flush receives
        aborts at the deadline; `github.test.ts` › the check-run POST ends
        when core's flush deadline aborts; `collector.test.ts` › the POST
        ends when core's flush deadline aborts, not at timeoutMs (a real
        hanging server). Each red without its change.

1056. DONE (2026-09-27, the telemetry review's leads 2–4). vx-otel's
      headers and the SDK opt-outs.
      - A header NAME fetch refuses killed every export and printed it:
        a curl-style `Authorization: Basic …=` split at its first `=` is a
        name holding the credential, and fetch's error quoted it. Names
        are held to RFC 7230's token and a bad one is dropped with a
        warning that prints neither name nor value.
      - Names merged case-sensitively: `Authorization` and
        `authorization` (the shared env and a signal's, or the env and the
        option) were both sent, fetch joined them, and the collector got
        `Bearer shared, Bearer traces-only`. Names are lower-cased, so the
        later one replaces the earlier as the spec orders.
      - Only `OTEL_LOGS_EXPORTER=none` was read. `OTEL_SDK_DISABLED=true`
        now declines, and `OTEL_TRACES_EXPORTER=none` /
        `OTEL_METRICS_EXPORTER=none` turn their signal off (the options
        still win). The README says so.
      - Rows: `otel.test.ts` › a header name no request can carry is
        dropped; header names merge case-insensitively; the SDK opt-outs
        are honoured; a sink with traces off POSTs no traces. Each red
        without its change.

1057. DONE (2026-09-27, the telemetry review's lead 6). The run's
      command line went to every telemetry sink verbatim, so a task
      argument after `--` (`vx run build -- --token=SECRET`) reached an
      OTLP span's `vx.command`, the GitHub job summary and a check-run
      posted over the API. What follows `--` is counted, not quoted, in
      the line sinks receive (`vx run build -- <1 argument>`); local
      history (`vx last`) keeps the whole line, on this machine.
      - Row: `telemetry.test.ts` › a sink never receives what follows `--`
        on the command line (a real run with a spoofed argv, every record
        and the summary). Red with the sinks' line restored.

## In flight

**The parallel plan (2026-09-27, `docs/design/plan-2026-09-27.md`).**
Ten workstreams (A cache and keys, B sandbox and exec, C scheduler and
run lifecycle, D workspace and config, E CLI, F remote and telemetry
plugins, G adoption, H the 1.0 contract, I performance, J docs accuracy),
one session each, one coordinator. While it runs, a stream's merged items
are recorded in `docs/history/ws-<id>.md` as `<ID>-<n>`, not in the
numbered list below, so parallel PRs never collide on a number; the
coordinator folds them into this file.

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

**Releases.** Every green merge to main releases itself (item 1018,
`auto-release.yml`). The first two ran on 2026-09-27: v0.0.22 (74814d28)
and v0.0.23 (f7096cea) were tagged, released with generated notes, their
four binaries attached by the dispatched `release.yml`, and `@vzn/vx`
with its four platform packages published by the dispatched `npm.yml`.
That `npm.yml` run is still red at its first plugin: `@vzn/vx-github`
answers the OIDC publish with `E404 Not Found - PUT`, because none of
the seven plugin names has ever been published and a trusted publisher
cannot be bound to a name that does not exist. OWNER ACTION, once:
publish each plugin by hand from an owner's npm account and add its
trusted publisher (`docs/cli.md` § Releasing names the steps); every
auto-release after that publishes all twelve. v0.0.21 is on npm, the
four platform packages with it
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
   item 960 (2026-09-27, the day's items 927–959, a tie at 1,000 projects; 885 was the one before), and the
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
   the cache removed before each, no A/A needed at that size. 2026-09-24 (items
   690–702, the day's run-path changes being the key fold's move to
   `key-fold.ts`, one config worker per repeat round and the JSON-data
   walk): base 39294a8d against head, compiled binaries, 1,000 projects
   warm, interleaved, n=25 — medians 266.5 ms before and 266.4 after,
   mins 245.1 and 230.8; A/A 270.4 against 264.8 (mins 238.5, 238.1).
   A tie; a first n=15 pass read the mins the other way round (225.9
   before, 251.8 after) with the same tied medians, which is the box's
   min-of-N noise, not a cost.

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
    `docs/history/2026-09-improvement-loop-592-611.md`, 612–631 in
    `docs/history/2026-09-improvement-loop-612-631.md`, 632–654 in
    `docs/history/2026-09-improvement-loop-632-654.md`, 719–743 in
    `docs/history/2026-09-improvement-loop-719-743.md` (entries
    14aq–14di and loop item 677 in the next-log file), 744–778 in
    `docs/history/2026-09-improvement-loop-744-778.md`, 779–819 in
    `docs/history/2026-09-improvement-loop-779-819.md`, 820–852 in
    `docs/history/2026-09-improvement-loop-820-852.md`, 853–892 in
    `docs/history/2026-09-improvement-loop-853-892.md`, 893–932 in
    `docs/history/2026-09-improvement-loop-893-932.md`, 933–972 in
    `docs/history/2026-09-improvement-loop-933-972.md` and 973–1012 in
    `docs/history/2026-09-improvement-loop-973-1012.md`. The loop above
    is the record since 1013 (14dj in the next-log file); 14dk is below,
    and the next entry written here is 14dl.
15. **The plan after the sweep week: `docs/design/plan-2026-09-22.md`.**
    Fixes F1–F6, improvements I1–I7, arcs D1–D5, in the order that
    document gives (F4 → F1 → F3 → F2; F5 → I1 → I4; D3 → D1, D5
    alongside, D4 with the owner, D2 when a workspace asks). Each entry
    names its seam, the constraint that must survive, the measurement
    and what not to do; strike an entry through there when its item
    lands here.

14dk. **Handoff after item 727 (2026-09-24, midday).** Since 14dj the
site was redone as one story and read on a phone: the Guide of ten
chapters on one toy monorepo, Docs and Reference around it, internals
out of the sidebar, one look, build-time pictures (721); the old Learn
pages retired with redirects (722); the widgets restyled and cut (723);
every picture, the cover, the graph explorer (724) and the scheduler's
charts (725) given a phone form, held by the diagram kit's laws, and
code blocks wrapped. Core alongside: a sandboxed task no longer reads
its own package through its self-link (720, `CACHE_VERSION` v30), nor a
linked sibling its key does not cover (726, v31, the Decisions entry on
narrowing core's grant), and a task downstream of a persistent task has
one key on both paths (727). WHAT STANDS: 14dj is in the next-log file
(§ Handoff 14dj); the loop holds 719–729. OWNER, unchanged: the site's read
(Next 16), cut 0.1.0 (the tag, then delete `NPM_TOKEN`), the scope list (roadmap 2.4), the soak length. NEXT: the owner's read of the short site (Next 16); the trim when the loop reaches twenty items; the warm-path A/B on the next run-path change (Next 6). Never end with "what
next?".

16. **The site, short (owner, 2026-09-24, after 728).** Shipped as item
    729 (`design/site-short-2026-09.md`). Left: the owner's read.
17. DONE as item 744 — **Turbo 2.11 won warm at 476 packages on the Linux box (item 735).**
    Two one-rep runs read Turbo at 255 and 303 ms against vx's 334 and
    376 (restore: 436 and 446 against 524 and 478). Measure it min-of-N
    with interleaved arms, find where vx's warm path spends it at that
    size, and fix it or say so on the site. The 3,270-task run on the
    same box reads the same way: Turbo 496 ms warm against vx's 678.
18. **Re-run the site's benchmark with the fixed harness (item 735).**
    The landing's Nx numbers (34m 44s cold, 3,270 tasks, macOS) come
    from the harness that gave Nx npm; npm was two thirds of Nx's cold
    run at that size on the Linux box. OWNER: re-run `compare.ts 100 11
1` on the macOS machine and `update-site.ts`, or take the Linux run
    in `benchmarks.md` for the site. The Linux run of this exact shape
    (`compare.ts 100 11 1`, 2026-09-25, item 758) has vx leading every
    column; its generated `RESULTS.md` / `results.json` were not
    committed over the macOS run the site reads.
19. DONE as item 751 — **A sandboxed task's `kill 0` killed the
    sandbox (Linux, found in 736).** The command runs in a session of
    its own inside the sandbox.
20. DONE as item 752 — **A cancelled sandboxed task got no TERM grace
    (Linux, found in 751).** SIGINT and SIGTERM reach the command's
    group through fd 3; SIGKILL stays the group's.
21. **The rest of the 476-package warm profile (item 753).** In order
    of measured saving, each on a patched copy (interleaved, stage
    mins): scheduler priorities over the exec tier only (DONE as item
    754); one multi-row insert for the run's history rows (REFUTED
    2026-09-25: 40-row INSERTs made 85 rows three statements, and a warm
    476-package run's `record history` stayed 8.2 → 8.6 ms at min, wall
    174.3 → 176.6, N=21; the 5 ms the profile saw was skipping the
    rows, and binding 21 columns a row is the cost, not the statement
    count); `node:readline/promises` imported only by
    the picker (REFUTED 2026-09-25: two compiled binaries, one importing
    it beside the other node: modules vx loads, differ by 0.27 ms at min
    and 0.1 at median, 41 interleaved; the 2.5 ms was the source run's
    transpile under the profiler); `git rev-parse` in the enumeration
    as an async spawn beside the others (REFUTED 2026-09-25: as a fourth
    spawn in the `Promise.all`, two interleaved passes of 21 read min
    168.7 → 171.8 and 165.5 → 183.8 ms; the sync spawn's block overlaps
    git's own run, which is the enumeration's wall anyway);
    the group hash computed once instead of in the stable-key pass and
    again at execute; and `resolveFiles`' memo checked before it builds
    its key (both declined in item 756). The large lever, persisting
    last run's stable keys, is designed and DEFERRED (item 756).
    (`vx-bench/strace-vx.ts` counting git's worker threads as vx: fixed
    in item 755.) DONE through items 753–756.
22. DONE as item 771 — **`baseAllowWrite` had one value (item 770).** Core sends `[]` on
    every sandboxed request, so the field on `ExecuteSandbox` and
    `SandboxedRunArgs` is a knob no producer turns; an executor plugin
    reading it learns nothing. Remove it from the seam and let the
    runtime's own write set be `allow.write` alone. Three runtime rows
    pass it as a direct write grant (two of them macOS `sandbox-exec`
    rows, which this box cannot run) and move to `allow.write` in the
    same change, proven on the darwin CI job.
23. **Two signal rows went red once each, root cause unproven
    (2026-09-25).** (a) `watch-signals.test.ts` › "SIGINT during the
    initial run reaches its task as SIGINT", on the macOS job of #878.
    The recap cut the assertion, it passed on the same code in #879, and
    it passed 49 of 49 Linux repetitions. Its twin in `signal-handling.test.ts` failed
    the same way on the macOS job of #929 with the assertion in the log:
    `got.txt` missing, the shell SIGKILLed at the 200 ms grace before
    its trap ran. Both rows now pass a 5 s grace (items 852, 853). That
    (a) was the same cause is likely, not proven. (b) `signal-handling.test.ts`
    › "at the moment vx exits on a signal every task process is gone and
    its pipes are closed", in a full local gate. On SIGINT one task pid
    was alive at vx's exit; the shard passed 4 of 4 alone and a gate
    re-run passed. Under the sandbox `procfsIsOwn()` is false, so the
    test's `isAlive` counts a zombie, and `slow`'s `sleep 30 &` starts
    with SIGINT ignored and dies only to the SIGKILL. An orphan zombie
    that init has not reaped yet is the leading suspect, not a proven
    one. One fact since: until item 849 every vx that file
    spawned ran on the 2 s default grace, not the 200 ms it set
    (`Bun.spawn` without `env` passes the startup environment), so the
    failure was seen at 2 s. Both rows now print what they saw on a mismatch (item 804); the
    next failure names the process and what vx said, and this entry
    closes on that evidence. Item 864: 60 sandboxed runs of (b) (30 idle,
    30 beside six CPU burners) were clean, and (b) now also says, for
    each process alive at the exit, whether it was gone within 3 s (a
    zombie awaiting its reaper) or still alive (a leak). vx releases every
    group before it exits, so its guard kills nothing there to blur the
    two.
24. DONE 2026-09-27 (fifth hit, CI on #1083, the same docs build after it
    had finished): an attempt whose last stderr line is strace's own and
    whose exit is non-zero is run once more, with a line saying why
    (`runSandboxed`, `sandbox-tracer-retry.unsafe.test.ts`: a fake strace
    first on PATH fails its first call; red without the retry, and a task
    failing on its own is run once). The history below stands. —
    **strace's own ptrace error ended a sandboxed task (2026-09-26,
    CI on #972).** `@vzn/vx#test.bun.shard-9` exited 1 on the Linux job
    with no failed row. Its output stopped before bun test's summary,
    and its last line was strace's own error:
    `ptrace(PTRACE_LISTEN,pid:…,sig:0): Input/output error`.
    A traced task's exit code is strace's, and strace is bwrap's
    parent, so an internal strace failure is the task's failure.
    `PTRACE_LISTEN` is issued for a tracee in group-stop; no row of that
    shard sends a stop signal, so what stopped a tracee is unproven. The
    same head passed the shard in the local gate and on macOS. Candidate
    fix, to measure first: `strace -D` makes the traced command vx's own
    child (its exit code, and bwrap's `--die-with-parent` on vx), with
    strace a detached grandchild. Probed (item 903's commit): with
    `-D` the log was whole when read at the command's exit (200 of
    200). But no row tells the two apart: a SIGKILL of strace ends the
    task either way (strace starts its tracee to die with it), and a
    SIGTERM leaves the task running either way. What strace does on its
    own `PTRACE_LISTEN` error is the one path that differs, and nothing
    here reaches it, so `-D` is not shipped without a failing row.
    Second hit (CI on #978): shard 9 again, in the same place — right
    after `output-memory.test.ts` › "an opted-down stream does not grow
    with the volume the child writes", where the next rows start four
    `awk` floods at once and SIGKILL each. That file alone under the
    same strace flags, bare, was clean 6 of 6, and the shard itself
    through vx's sandbox (bwrap under strace, as CI runs it) was clean
    5 of 5 on this box: the trigger is the CI runner's, not reproduced.
    Third hit (CI on #997), the same place; item 925 moved the file to
    the unsandboxed suite. Fourth hit (CI on #1075, 2026-09-27):
    `@vzn/vx-docs#build`, no shard and no flood, so the trigger was not
    that file. The build had finished (its last lines were Pagefind's
    index and astro's closing warning) when strace printed the error and
    the task exited 1: the work was done and the verdict was strace's.
    Still unreproduced here; the fix wants a row that reaches strace's
    own failure before it ships.
25. **A key-only task for `nx()`'s `nx-input:<name>` twins (item 910).**
    A twin runs `true` so that its key, the project's `^` input, folds
    into its dependants. At 300 projects the 598 twins cost 97 ms of a
    159 ms warm run. A task kind that is a key and nothing else (no
    spawn on a miss, no history row, not printed) would take most of it
    back. Measure the twins' share first: is it the key, the lookup or
    the row? Measured (item 931, stage mins over 9 interleaved CLI runs,
    the same workspace without `^` inputs as the control): the twins add
    about 120 ms. `load configs` +46, `classify + probe` +45,
    `run graph` +15, `build graph` +9, `record history` +4. A key-only
    kind saves the run and the row, about 19 ms. The rest is what every
    task costs to load and key, so the lever is per-task cost in those
    two stages, not a new kind. Item 932 took 23 ms of the load share
    back: a guard that stopped holding after the first round.

26. **`nx()`'s graph snapshot misses edges an import adds** (the nx
    review's lead 1, reproduced with Nx 22.7.12). Freshness stats
    `nx.json`'s chain and the manifests, but Nx derives dependency edges
    from source imports (`@nx/js`), and those edges choose the `^` twins a
    task folds: `import { b } from '@w/b'` added in `a` left the snapshot
    at `{a:[],b:[]}`, and a later edit to `b` hit `a#test` as up-to-date
    (a stale hit; control: the snapshot deleted, the same edit re-ran it).
    The fix is a re-export whenever a tracked or untracked file under a
    project root is newer than the snapshot, and that puts an export into
    every edit-then-run: 1.7 s daemon off at 1,000 projects, 1.3 s under
    `vx watch` (README). Measure the daemon-on export and the walk's cost
    (git's list, or the stats) before choosing; keying the snapshot on the
    tree's git state is the other candidate. The README says a new
    cross-package import needs an Nx command before the next run.

27. **`nx()` saves an extensionless output file as a directory** (the nx
    review's lead 4). `dirGlob` maps `{workspaceRoot}/dist/bin/tool` to
    `dist/bin/tool/**`, which matches nothing under a file: a hit
    restored no binary. Core's `asTrees` already reads a bare literal as
    the path or the tree under it, so the bare path is correct for both,
    but it takes `outputDirsCurrent`'s directory-mtime short-circuit away
    from every nx() directory output (`{projectRoot}/dist`), which only
    `<dir>/**` globs get. Measured (2026-09-27, one task, 5,000 output
    files in 50 directories, warm up-to-date run, 15 interleaved runs):
    `dist/**` min 181 ms, median 210; the bare `dist` min 228, median 241.
    So the bare literal is not free. The candidate is teaching
    `wholeSubtreePrefixes` a literal that was a directory at save time,
    then taking the bare path in the mapper.

## Decisions (this arc)

- **Persisted stable keys: deferred (item 756).** Designed and
  prototyped (`docs/design/persisted-stable-keys-2026-09.md`): 13–21 ms
  of a 476-package warm run, exact-repeat runs only, and any input the
  digest misses is a stale hit on every run. Not built while vx leads the
  warm column; revisit on a measured warm-no-op loss or an agent-loop
  workload, and land only through that doc's gate.
- **Once per run (owner, 2026-09-24, item 732).** Within a run nothing
  outside vx changes the files it reads; what vx learns once (a read, a
  stat, a PATH lookup, a spawn's answer) it reuses, and only vx's own
  writes or its tasks' runs invalidate a fact. A repeat that stays has a
  measured reason in a comment and in the strace laws that pin it.
- **Tools resolve on vx's own PATH (item 732).** The task's PATH decides
  what its command runs, never which shell parses it.
- **What a cached task may write undeclared (item 750).** Its own
  inputs, in place (a formatter), and nothing else: its key names those,
  so a reader folding it is covered. A root-project task may rewrite the
  lockfile; the run watches for it. An `inputs.runtime` answer is the
  environment, asked once per run and never re-checked: a task that
  changes it is out of contract, and a file another task writes is
  declared as an input instead.
- **Every project's lockfile key folds the root importer (item 733).**
  What the root declares is reachable from every task.

- **Declaring `cache` may narrow core's own grant, never widen one
  (owner-delegated, 2026-09-24, item 726).** The user's `sandbox.allow`
  still derives nothing from `cache` (2026-09-05). Core's implicit
  `node_modules` link grant is bounded by the key for a task that
  declares `cache`: a linked workspace package is granted only when the
  key folds a task of it, because an unkeyed read is exactly the stale
  hit the sandbox exists to rule out. A task with no `cache` keeps the
  whole grant, having no key to be stale. The coverage is per package,
  not per file (an edge to `ui#source` also admits `ui/README.md`), the
  same limit a grant wider than a task's own inputs already has.

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
