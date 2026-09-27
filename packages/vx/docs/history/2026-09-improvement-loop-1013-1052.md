# Shipped, 2026-09 — improvement-loop items 1013–1052

The record `docs/STATUS.md` carried until 2026-09-27, moved here whole
when the loop passed forty items again (item 1064). A PREFIX,
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
`2026-09-improvement-loop-612-631.md`, items 632–654 in
`2026-09-improvement-loop-632-654.md` (655–713 are handoff entries in
`2026-09-status-next-log.md`; the audit's 714–718 were dropped, as that
file records), items 719–743 in
`2026-09-improvement-loop-719-743.md`, items 744–778 in
`2026-09-improvement-loop-744-778.md`, items 779–819 in
`2026-09-improvement-loop-779-819.md`, items 820–852 in
`2026-09-improvement-loop-820-852.md`, items 853–892 in
`2026-09-improvement-loop-853-892.md`, items 893–932 in
`2026-09-improvement-loop-893-932.md`, items 933–972 in
`2026-09-improvement-loop-933-972.md`, items 973–1012 in
`2026-09-improvement-loop-973-1012.md`; items 1053 onward continue in
`docs/STATUS.md`. The two lists below are as STATUS held them: the
parallel sessions' own 1017 and 1018 first, then the loop's.

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
