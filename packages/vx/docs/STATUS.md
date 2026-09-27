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
974), so
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

973.  DONE (2026-09-27, the `vx lock` review's lead 3; docs and comments
      only). The `lockfile.ts` header, the `lock.test.ts` header and the
      body of `design/config-lock-2026-06.md` still said every run with a
      lock loads it after a per-file hash check that fails a stale
      config. The owner's 2026-06-13 revisions at the page's end dropped
      both: a plain run evaluates live, and `--frozen` checks nothing.
      The page's Runs section, its asymmetry, Known limits (watch now
      names item 971) and Tests §2 say what the code does; the
      revisions stay as the record.
974.  DONE (2026-09-27, the trim the loop reached forty at). Items
      933–972 moved to `docs/history/2026-09-improvement-loop-933-972.md`
      in this commit. What that stretch was: review agents' reproduced
      leads, area by area — the lockfile plugin's install-wide fields
      (933), `turbo()`'s task lookup, inputs and outputs (935–940), the
      local and remote cache seams (941–944), `vx watch` (945–949), the
      config-eval cache's keys and purity gate (950, 952, 956, 957),
      `--affected` (951, 953–955, 958, 959, 961), a warm A/B after them
      (960), execution, the scheduler and the sandbox (962–966), then
      `vx lock` and the cache prune (967–972).
975.  DONE (2026-09-27, the cache-prune review's last lead). An index row
      whose artifact was deleted by hand is never a hit, but `--max-size`
      counted its bytes: a prune evicted the real entry to make room for
      a phantom, and an age prune reported the phantom as freed.
      - Fix (`cache.ts`): prune lists the directory first; a row with no
        artifact, last used over an hour ago (a younger one may be a save
        landing), is dropped in the eviction's transaction and counts as
        neither evicted nor freed, in a dry run too. `cli.md` says so.
      - Row: `cache.test.ts` › prune() drops a row whose artifact is gone.
        Red without the fix; each of its four guards (the grace, the age
        skip, the size discount, the drop) is red with its line removed.
        Five fixtures that seeded rows with no artifact now write one.
      - `vx info` still sums such a row until a prune drops it
        (`vx cache prune`, or `cacheRetention` when something is due; the
        hourly orphan-only sweep does not list rows).
976.  DONE (2026-09-27, a cache-key review agent's lead 1). A stale hit.
      A file copied, the copy `git add -N`, the original removed: porcelain
      v1 prints ` R new.txt\0old.txt\0`, the rename in the second column.
      The status parser took the source token only for an R or C in the
      first, so `old.txt` parsed as a record of its own, stayed trusted,
      and a deleted input was keyed from the index: the run replayed an
      output that listed it.
      - Fix (`git-inputs.ts`): an R or C in either column names the next
        token as the source. `modules/git-inputs.md` says so.
      - Row: new `git-trust.test.ts` › a deleted rename source is not an
        input. Red without the fix (`cache-hit`).
      - Next from the same review: 2 (an untracked or modified
        `.gitattributes` is not gated), 3 (a `filter=` driver is not
        gated), 4 (config key order moves the key: a false miss). And
        from a graph review: `!` before an include in `--filter`,
        `--exclude-dependencies` dropping an edge to a task in the same
        run, the `graph` stage skipping the builder's output-collision
        and key checks, and cli.md's "`--all` overrides scope".
977.  DONE (2026-09-27, the cache-key review's lead 2). A stale hit. With
      `*.txt text` in an untracked (or modified) `.gitattributes`, a CRLF
      file's index blob is its LF form and `git status` calls it clean,
      so the first run keyed the CRLF bytes by the LF blob's OID; rewritten
      to LF, the file is dirty and hashed from disk to that same OID, and
      the run replayed the CRLF output. The gate that stops trusting a
      converted OID looked for `.gitattributes` among the trusted paths
      only.
      - Fix (`git-inputs.ts`): the gate scans every listed path, tracked,
        dirty and untracked. `modules/git-inputs.md` says so.
      - Rows: `git-trust.test.ts` › an untracked one, and a modified one,
        through the CLI; both red without the fix. Two `run()` calls in
        one process derived the same key and still re-executed the second
        time, so an in-process row could not see the hit (explained in
        item 982).
978.  DONE (2026-09-27, the cache-key review's lead 3). A stale hit. The
      gate asked `git check-attr` for `text`, `eol` and `ident` only. A
      `filter=` driver whose clean command drops comment lines stores one
      blob for `#A` and `#B` versions of a file; `git status` calls the
      edit clean, and the run replayed `#A`. `working-tree-encoding` does
      the same for UTF-16 little- and big-endian forms of one text.
      - Fix (`git-inputs.ts`): the probe asks for `filter` and
        `working-tree-encoding` too. Git LFS files are a `filter`, so they
        are now hashed from disk. `caching.md`, `modules/git-inputs.md`,
        `modules/cache.md` and the three source comments that named the
        set say so.
      - Rows: `git-trust.test.ts` › a filter= driver, and a
        working-tree-encoding, through the CLI; each red with its
        attribute removed from the probe.
979.  DONE (2026-09-27, a graph review agent's lead 1). A run given
      `--filter '!b' --filter 'a...'` ran `b`: filters applied in argv
      order, so the include after the exclude added it back. Item 955 fixed only
      `--affected`'s place in the line.
      - Fix (`filter.ts`): every include first, every exclude after them;
        expansions still taken in argv order, so an unmatched filter is
        named as typed.
      - `cli.md` says so, and no longer says `--all` overrides a filter's
        scope: filters refine `--all` (`run.ts` resolves them first; the
        review's doc lead).
      - Row: `filter.test.ts` › an exclude removes what any include adds,
        whatever the order. Red without the fix.
      - Next: `--exclude-dependencies` dropping an edge to a task in the
        same run, the `graph` stage skipping the builder's checks, and the
        config key order (a false miss).
980.  DONE (2026-09-27, the graph review's lead 2). Under
      `--exclude-dependencies`, `vx run build --all` dropped `a#build`'s
      `^build` edge though `b#build` ran in the same run: the two ran
      unordered, and `a` read `b`'s output mid-rewrite (a failure) or the
      run before's (green, on stale bytes).
      - Fix (`task-graph.ts`): an edge to a task that stays scheduled is
        kept; only edges to tasks that leave the schedule are dropped and
        keyed as before. `cli.md` says so.
      - Row: `task-graph.test.ts` › excludeDependencies keeps an edge to a
        task the run schedules anyway, under `'all'` and a name list. Red
        without the fix.
981.  DONE (2026-09-27, the graph review's lead 3). The `graph` stage
      re-checked only dangling deps and cycles. A plugin that dropped the
      edge making two tasks' overlapping `dist/**` an addition left them
      unordered, and `gen`'s clean deleted `extra`'s file under a green run
      (the builder refuses that shape); one that moved a node to another
      key crashed the scheduler with a raw TypeError and a stack.
      - Fix (`task-graph.ts`, `plugin-host.ts`): one `checkGraph` (id keys,
        deps, cycle, output collisions, the addition marks cleared and
        derived again) run by the builder and again after the stage's
        plugins, blamed on the last. `detectCycle` is no longer exported.
        `modules/plugin-host.md`, `plugin.md`, `task-graph.md` say so.
      - Rows: `plugin-pipeline.test.ts` › an edge a plugin drops between
        overlapping outputs is refused, and a node moved to another key is
        refused by name; `task-graph.test.ts` › checkGraph re-derives the
        addition marks. Each red without its part of the fix.
982.  DONE (2026-09-27, item 977's open note; a comment and STATUS). Why
      two in-process runs re-executed on the key item 977's stale hit
      shares: the first run starts within `FILE_HASH_RACY_MS` (50 ms) of
      the fixture's write, so `movedInput` re-hashes the file after the
      task, finds the CRLF bytes unlike the LF blob the key used, says the
      input changed after its key was taken, and saves nothing (probed:
      that line on the first run, the same hash on both). A CLI spawn
      starts past the window, so the entry was saved and replayed. The
      guard narrowed the bug to edits older than 50 ms at the run's
      start; it is not the fix. 977's note and the row's comment say so.
983.  DECLINED (2026-09-27, the cache-key review's lead 4, measured). The
      task config is hashed as `JSON.stringify`, so writing `cache` before
      `exec` with the same values moves the key: one false miss, then the
      new order hits. Sorting keys in that stringify (a replacer that
      rebuilds only out-of-order objects) cost 15.6 ms against 2.4 ms per
      3,000 configs, min of 30, on every run. Sorting once where a config
      is stored (the eval cache, the live load, the lock) would move the
      cost off the warm path but spreads the rule over three writers, for
      a miss that happens once per reordering. Not taken; reopen with a
      design that keeps the warm path at one stringify.
984.  DONE (2026-09-27, a workspace-discovery review agent's lead 2). A
      `pnpm-workspace.yaml` with no `packages:` (pnpm 10 keeps
      `onlyBuiltDependencies` and catalogs there for a single-package repo
      too) read as an empty package list: `vx show` printed nothing and
      exited 0, and `vx run build` said "not inside a project". A list or
      a scalar document read the same, silently.
      - Fix (`workspace.ts`): with no `packages:` the root's
        `package.json` decides, as it would without the file; a document
        that is not a mapping is refused by name. `schema.md` lists the
        refusal (pinned by `schema-doc-drift.test.ts`).
      - Rows: `workspace.test.ts` › a pnpm-workspace.yaml with no packages
        list defers to package.json, and one that is not a mapping is
        refused. Both red without the fix.
      - Next from the same review: manifests of the wrong shape (a `null`
        `package.json`, a numeric `name`) crash with a stack or plan
        `123#build`; a trailing slash makes a member glob recursive; `!**/test/**`
        misses `packages/test`; the root search stops at a workspace
        that does not list the cwd's package; nested pnpm workspaces
        resolve by where you start; a symlinked member is found only
        by `packages/*`. And from a flags review: `--dry` calls a
        `--force` run no-cache, `--dry` drops `--report`, a bad
        `--graph=<path>` prints a stack, `--report-file` does not make
        its directory.
985.  DONE (2026-09-27, the discovery review's lead 3). A member glob
      spelled `packages/*/` (in `workspaces` or `pnpm-workspace.yaml`)
      found every example and fixture package at any depth: the task-glob
      normalizer read the trailing slash as `/**`. npm and pnpm read the
      two spellings alike.
      - Fix (`workspace.ts`): a member glob's trailing slashes are dropped
        before it is normalized. `modules/workspace.md` says so.
      - Row: `workspace.test.ts` › a trailing slash on a member glob does
        not make it recursive, in both manifests. Red without the fix.
986.  DONE (2026-09-27, the discovery review's lead 4). pnpm's documented
      `!**/test/**` left `packages/test` a member: the exclusion was
      matched against the directory, where `**/test/**` needs something
      below `test`. pnpm matches `<pattern>/package.json`.
      - Fix (`workspace.ts`): a wildcard exclusion also matches the
        member's manifest path, so nothing it excluded before is kept.
        `modules/workspace.md` says so.
      - Row: `workspace.test.ts` › pnpm's `!**/test/**` excludes
        packages/test itself. Red without the fix.
987.  DONE (2026-09-27, the discovery review's lead 7). A symlinked member
      (`packages/b -> ../ext/b`) was found by `packages/*`, whose readdir
      path follows links, and missed by `packages/{a,b}`, `pack*/*` and
      `packages/*/`, which take the glob scan: `Bun.Glob.scan` follows no
      link by default.
      - Fix (`workspace.ts`): the scan follows links for a glob without
        `**`; under `**` it still does not, so a `packages/**` glob never
        walks a pnpm `node_modules` link farm (and cannot loop).
        `modules/workspace.md` and the function's comment say so.
      - Row: `workspace.test.ts` › a symlinked member is found whatever the
        glob spelling. Red without the fix.
988.  DONE (2026-09-27, the discovery review's lead 1). A `package.json`
      of the wrong shape was cast and trusted: `null` (root or member)
      crashed with a TypeError and a stack; `{"name":123}` planned
      `123#build` and crashed `vx show`; `" a"` beside `"a"` made two
      projects.
      - Fix (`workspace.ts`): one `parsePackageJson` for the root's and
        every member's manifest refuses, by file, one that is not an
        object and a `name` that is not a string or has surrounding
        whitespace (npm refuses that too). `schema.md` lists both (pinned
        by `schema-doc-drift.test.ts`).
      - Row: `workspace.test.ts` › refuses a package.json of the wrong
        shape by name: five bodies, root and member, the exact messages.
        Red without the fix.
989.  DONE (2026-09-27, the discovery review's lead 5). From
      `packages/tools/standalone` (a package under a directory with no
      manifest), the root search stopped at the workspace whose
      `packages/*` matched `packages/tools`, though that workspace does
      not list the standalone package: `vx show` listed the others and
      `vx run build` said "not inside a project".
      - Fix (`workspace.ts`): only a directory the walk found a manifest in
        can be the claimed member, as only such a directory is listed. The
        standalone package is its own root, as npm has it.
        `modules/workspace.md` says the two roots now cannot diverge.
      - Row: `workspace.test.ts` › a package under a matched directory with
        no manifest is not claimed, with a member's manifest-less
        subdirectory as the control. Red without the fix.
990.  DONE (2026-09-27, the discovery review's lead 6, its last). With an
      outer `pnpm-workspace.yaml` listing `apps/*` and one in `apps/inner`
      listing `pkgs/*`, `vx` from `apps/inner` took the outer root (it
      claims `apps/inner`) and from `apps/inner/pkgs/x` the inner one: two
      roots and two cache directories for one tree. pnpm takes the nearest
      workspace file.
      - Fix (`workspace.ts`): the root walk stops at the first directory
        holding a `pnpm-workspace.yaml`, read through the load's memo (the
        walk makes its own when the caller passes none), so no extra read.
        `modules/workspace.md` says so.
      - Row: `workspace.test.ts` › the nearest pnpm-workspace.yaml is the
        root, from any depth, with an outer member as the control. Red
        without the fix.
991.  DONE (2026-09-27, a run-flags review agent's lead 1). A plan under
      `--force` (or `--cache=local:w`) labelled every cacheable task
      `no-cache`, the label a task with no `cache` block gets, while the
      run it described was a miss that saved: the plan-predict row even
      recorded two entries written under that label.
      - Fix (`plan.ts`): no read axis and no write axis is `no-cache`; no
        read axis with a write one is `miss`, still without a probe. The
        dry-run legend in `cli.md` says so.
      - Rows (`plan-predict.test.ts`): the zero-probe row now asks for
        `no-cache` under `--no-cache` and `miss` under `--force` (red
        without the fix); the two `planRun` rows that pinned `no-cache`
        for `--force` now pin `miss`, and the invariant is "no axis at
        all", not "no read axis".
992.  DONE (2026-09-27, the run-flags review's lead 2). `--dry` and
      `--graph` refused `--summarize` and `--profile` but took `--report`
      and `--report-file` and wrote nothing: the planning branch returns
      before the report. `--report-file="$GITHUB_STEP_SUMMARY" --dry`
      exited 0 with no summary.
      - Fix (`cli/run.ts`): planning refuses all four, naming them.
        `cli.md` and `execution.md` say so. `--verbosity` is accepted and
        ignored there still: it promises no artifact, and planning prints
        what it prints.
      - Row: `cli.test.ts` › rejects --report / --report-file with --dry or
        --graph, exact messages, a real run as the control. Red without
        the fix.
993.  DONE (2026-09-27, the run-flags review's leads 3 and 4, its last).
      The run's output paths disagreed: `--graph=<dir>` (or an unreachable
      path) printed a raw EISDIR/ENOENT stack, where `--summarize` and
      `--profile` say one line; and `--report-file=nr/r.md` failed on the
      missing directory that the other three create.
      - Fix (`cli/run.ts`): the graph is written to the path resolved
        against the cwd; a failure is one line naming the path and why,
        and exit 1 (the graph is the command's product). The report's
        directory is made before the append. `cli.md`'s flag rows say so.
      - Rows: new `run-output-paths.test.ts`, through the CLI: all four
        paths under missing directories are written, and a directory given
        to `--graph` is one line and exit 1. Both red without the fix.

994.  DONE (2026-09-27, the config-validation review's lead 1). With
      `dependsOn: ['^build']` and `cache.inputs.tasks: ['build']`, a
      change in the dependency's source missed its `build` and left the
      dependent `up-to-date`: `build` selects only this project's task,
      so the filter folded nothing. The load check that refuses an
      unnamed exact entry compared only task halves.
      - Fix (`config-schema.ts`): the check compares forms too. `build`
        pairs with `build`, `^build` with `^build`, and a `pkg#task` on
        either side pairs with any form (the schema cannot tell this
        project from a dependency); two `pkg#task` entries must agree on
        the project. `schema.md` says so.
      - Row: `project-loader.test.ts` › rejects a filter whose form no
        dependsOn entry of that form names, four refusals and eight
        controls. Red without the fix.

995.  DONE (2026-09-27, the env-isolation review's lead 1). With the
      network restricted, SRT sets a sandboxed task's `JAVA_TOOL_OPTIONS`
      to its proxy agent's flag composed with the value in vx's own
      environment. A host value no layer passes reached the task out of
      its key, and a changed host value replayed the old output; a task's
      own `define` of the name never arrived.
      - Fix (`sandbox-runtime.ts`): the command's prefix cuts the host's
        value out of what SRT set and appends the task's own; where SRT
        left the variable alone it already holds the task's value and
        the prefix changes nothing. A persistent task's wrap is given its
        env too. `modules/sandbox-runtime.md` § The environment SRT sets
        says so, and names the proxy, CA and git variables SRT sets over
        a task's own (documented, not repaired: the sandbox's network
        goes through SRT's proxy only).
      - Row: `sandbox-runtime.unsafe.test.ts` › the host's value is cut
        out and the task's own kept, with the agent flag asserted in both
        values so SRT's path is proven to have run. Red without the fix.

996.  DONE (2026-09-27, the env-isolation review's lead 2). An
      `inputs.runtime` probe ran on vx's own PATH, a task on one led by
      its project's and the root's `node_modules/.bin`. With a tool only
      in the workspace, `mytool --version` failed with 127; with a global
      one too, the key followed the global tool while the task ran the
      local one, and a changed local tool replayed the old output.
      - Fix (`inputs.ts`): the probe's PATH leads with the task's two bin
        directories; `workspaceRuntime` gets the root's only (its value is
        shared by every project). The memo was already keyed per project
        directory. `schema.md` says so; `modules/env.md` no longer says
        the root's bin is never on a task's PATH.
      - Row: `inputs.test.ts` › runs on the task's PATH: the project's
        bin, then the root's. Red without the fix.

997.  DONE (2026-09-27, the config-validation review's lead 2).
      `cacheDir: ''` (or `'.'`) opened the index at the workspace root
      and wrote the cache directory's `*` `.gitignore` there: the next
      run warned that `src/**` matched nothing, and the one after replayed
      the old output over a changed source. `'packages/a'` did the same
      to one project, and with a root `.gitignore` of the user's own the
      artifacts still landed among the sources.
      - Fix (`cache.ts`): a first index in a directory holding a
        `package.json` or `pnpm-workspace.yaml` is refused, naming the
        field and `--cache-dir`, before anything is written. Asked only
        when there is no index yet, so an open cache pays no syscall. A
        manifest-less ancestor of projects (`'packages'`) is not caught.
        `schema.md` says so.
      - Row: `cache-gitignore.test.ts` › a first index in a directory
        holding a manifest is refused, with a manifest-less directory as
        the control. Red without the fix.

998.  DONE (2026-09-27, the config-validation review's lead 3). A
      `persistent.readyWhen` of `'('` loaded, and the runner's
      `new RegExp` then failed the task as an internal error (a
      `SyntaxError` from the engine) with "(no output)".
      - Fix (`config-schema.ts`): the loader compiles it as the runner
        does and refuses it naming the field and the engine's reason.
        `schema.md`'s table has the row.
      - Row: `schema-doc-drift.test.ts` › emits the documented symptom
        for the invalid regex. Red without the fix.

999.  DONE (2026-09-27, the config-validation review's lead 5a).
      `define: { 'A=B': 'x' }` gave the child `A` with the value `B=x`,
      `define: { '': 'x' }` was dropped, and a NUL in a define name or
      value failed the spawn with a wrong hint about exit 127;
      `passThrough` took `=` and NUL too, and `cache.inputs.env` took `=`
      (a name no environment holds, so it never moved the key).
      - Fix (`config-schema.ts`): one `isEnvName` (non-empty, no `=`, no
        NUL) holds the three lists and the define keys, and a define
        value holds no NUL. `schema.md` says so.
      - Row: `config-schema-refusals.test.ts` › an env name that no
        environment can hold is refused in every list, with exact
        messages and a controls line. Red without the fix.

1000. DONE (2026-09-27, the config-validation review's lead 5b). Task
      names `x#y`, `^gen`, `''` and `' sp '` loaded and could not be
      referenced: `dependsOn: ['gen#x']` said no such project,
      `['^gen']` looked in the dependencies, and `''` ran under `--all`
      as `a#` while `vx run a#` refused it.
      - Fix (`config-schema.ts`): a task name that is empty, padded,
        holds `#` or `*`, or starts with `^` or `!` is refused, naming the
        reason. `schema.md` says which names are refused and why.
      - Row: `config-schema-refusals.test.ts` › a task name dependsOn and
        the CLI cannot name is refused, seven exact messages and five
        controls. Red without the fix.

1001. DONE (2026-09-27, the config-validation review's lead 6).
      `schema.md` says an `exec.remote: 'only'` task must declare
      `cache`, and nothing held it: one without loaded, and with no remote
      executor the run printed "nothing ran" and succeeded, while the
      REAPI executor refused it at run time for want of described inputs.
      - Fix (`config-schema.ts`): refused at load, naming why the cache is
        needed. `schema.md` says so.
      - Row: `config-schema-refusals.test.ts` › an uncached remote 'only'
        task is refused; the accepted-spellings control gives `'only'` its
        cache. Red without the fix.

1002. DONE (2026-09-27, the config-validation review's lead 4, its last).
      `outputs: { files: ['**'] }` loaded, and the clean before the run
      deleted the project's source, `package.json` and `vx.config.mjs`
      while the run warned about the manifest and reported success. The
      refusal for `'.'` had told the user to write `**`.
      - Fix (`config-schema.ts`): an output glob that matches the
        project's `package.json` or its own config file (the basename of
        the path being validated, so `**/*.js` beside a `vx.config.ts`
        stays legal) is refused, and the `'.'` message names `dist/**`
        instead. `schema.md`'s table has the row. Outputs that overlap
        the declared inputs are not refused and need not be: a task's
        declared outputs are excluded from its inputs (`src/gen/**`
        beside `src/**` is codegen, and stays correct).
      - Rows: `config-schema-refusals.test.ts` › an output glob that
        takes the project's manifest or config is refused, with five
        controls; `schema-doc-drift.test.ts` pins the table row. Red
        without the fix.

1003. DONE (2026-09-27, a sandbox-grants review agent's lead 2). A write
      grant was realpath'd, so a link at it moved the bind: with
      `out.txt -> ../b/src/planted.txt` and `write: ['out.txt']`, vx
      (unsandboxed) created the empty file in project b, bound b's
      directory writable, and the task wrote and read there with exit 0.
      A task could plant `dist/vx -> ../../b/src/x` on one run and escape
      on the next, and the sweep removed a user's own link.
      - Fix (`sandbox-runtime.ts`, `sandbox-request.ts`): a
        project-relative write grant whose path through its links (a
        dangling last one included) leaves the project is refused, and the
        grants are resolved before any placeholder is made; a placeholder
        is created only where `lstat` finds nothing, exclusively; the sweep
        takes back only a regular file. `modules/sandbox-runtime.md` and
        `schema.md` say so. The empty directories a placeholder's parents
        leave behind stay (a small litter lead, not fixed here).
      - Rows: `sandbox-request.test.ts` › a write grant that leaves the
        project through a link is refused (dangling, directory and parent
        links; nothing created at the targets), the sweep leaves a link,
        and an in-project link as the control. Red without the fix.

1004. DONE (2026-09-27, a run-history review agent's lead 1). History
      retention ran in every cache handle's close, a reading verb's
      included: with runs 40 days old, `vx last --list` listed them and
      emptied the tables, the next `vx last` said "no recorded runs yet",
      and `vx cache prune --dry-run` ("delete nothing") pruned them too.
      A `--cache-dir` pointed at a copied CI cache was wiped by reading.
      - Fix (`cache.ts`): the handle remembers `Cache.inspect`'s mode and
        its close prunes nothing. `modules/cache.md` and
        `modules/config-cache.md` say so.
      - Row: `history.test.ts` › a reading handle prunes no history, with
        a writing close pruning the same rows as the control. Red without
        the fix.

1005. DONE (2026-09-27, the run-history review's lead 2). A `cache.db`
      SQLite could not read (garbage, or a garbled schema page) crashed
      every verb — `vx run`, `why`, `last`, `info` — with a raw
      `SQLiteError` and a stack, and the user had to find the file.
      - Fix (`cache.ts`): the open's pragmas, `schema_meta` and version
        read turn `SQLITE_NOTADB` / `SQLITE_CORRUPT*` into a `UserError`
        naming the file and the remedy, for a run and a reading verb
        alike. A delete of a live `-wal` gave `SQLITE_IOERR_SHORT_READ`
        in a probe and is not caught (an I/O code is also a real disk's).
        Corruption deeper in the file surfaces where it is read.
        `modules/cache.md` says so.
      - Rows: `cache-unreadable.test.ts`, the two shapes with SQLite's own
        code asserted first and a sound index as the control. Red without
        the fix.

1006. DONE (2026-09-27, the sandbox-grants review's lead 3). On Linux a
      glob grant is expanded to its hits and each bound, and bwrap binds a
      link by its target: `read: ['*']` over `shared -> ../b/src` let the
      task read project b, which `read: ['.']` did not, and with
      `inputs: ['**/*']` a change in b's file replayed the old output.
      - Fix (`sandbox-runtime.ts` `expandGrants`): a hit whose real path
        leaves the directory holding the pattern's first wildcard is
        dropped (and a write glob left with no hit says so, as before).
        `modules/sandbox-runtime.md` says so.
      - Row: `sandbox-request.test.ts` › a glob grant takes no link out of
        its base, with a file and an in-project link kept. Red without the
        fix.

1007. DONE (2026-09-27, found running item 1006's sandbox suite on a host
      that sets `JAVA_TOOL_OPTIONS`). Item 995's prefix was written
      whenever either side had a value, so a task passing the host's
      through got the value quoted twice before its command, and the
      "tags each wrap" row failed on such a host (the gate strips the
      variable from its tasks, so it passed there).
      - Fix (`sandbox-runtime.ts`): no prefix when the task's value is the
        host's; SRT's composition is already the task's own.
        `modules/sandbox-runtime.md` says so.
      - Row: `sandbox-runtime.unsafe.test.ts` › no JAVA_TOOL_OPTIONS
        prefix when the task's value is the host's, with a value of the
        task's own as the control. Red without the fix.

1008. DONE (2026-09-27, the run-history review's lead 4). History's
      "latest" and "previous" were ordered by `started_at`: after the
      clock stepped back an hour, `vx why` called the older run "this run"
      and the newest "previous", diffing `x.txt` two→one for an edit one→two,
      and `vx last` showed the older run.
      - Fix (`metrics.ts`, `history.ts`): latest, previous, the lists and
        the history window's floor follow recording order (`runs.id`,
        `invocations.rowid`); `started_at` stays for display and windows.
        `cli.md` says so. Retention still ages rows by the clock.
      - Row: `metrics.test.ts` › the newest recorded run is the latest,
        whatever the clock said (latest, why, the key diff and both lists).
        Red without the fix.

1009. DONE (2026-09-27, the run-history review's lead 3). `vx why` on an
      unchanged key that re-executed always said "re-executed on the same
      key (--no-cache / --force, or unrelated)": after a failed run on the
      same key, and after `vx cache prune` evicted the entry, with no flag
      passed and the invocation recording a full policy.
      - Fix (`metrics.ts`): the verdict reads the evidence in order — the
        previous run on the key failed; the invocation's `cache_policy`
        read no cache; the key's entry was created at or after this run's
        start (none was there when it ran) — and keeps the old text only
        when none applies. `cli.md` and `modules/metrics.md` say so.
      - Row: `metrics.test.ts` › names why an unchanged key re-executed,
        three causes and the old text as the control. Red without the fix.

1010. DONE (2026-09-27, the sandbox-grants review's lead 1). A root
      project (`workspaces: [".", "packages/*"]`) read every nested project
      through `read: ['.']`: the deny anchor is the workspace root, its own
      directory, while its key excludes nested projects, so a change in
      `packages/b` replayed the root task's old output. A file grant
      (`out.txt`) there was widened to the workspace root and the task
      wrote into `packages/b` and `.git` with exit 0.
      - Fix (`sandbox-request.ts`, `sandbox-binds.ts`): the request takes
        the node's nested project directories; with the root's `.git` and
        `.vx` they are walls. On Linux a read grant containing one is
        punched around it; a write grant whose bind inside the workspace
        would hold one is refused, naming it. A grant naming a wall, and a
        bind outside the workspace, stay. `modules/sandbox-runtime.md`
        § The walls a project stops at.
      - Rows: `sandbox-request.test.ts` › a root project stops at the
        walls (the punch, both write refusals, a leaf project and a named
        wall as controls). Red without the fix.
1011. DONE (2026-09-27, the sandbox-grants review's lead 4, documented).
      With `read: ['.']` and `write: ['dist/']` in a multi-package
      workspace, a new file at the project root (`undeclared.txt`,
      `dist2/y`) was written inside the task, read back, and gone
      afterwards, with no violation: the write grant punches the read
      bind into per-child binds, and the project directory is the deny
      anchor's writable scratch. `schema.md` said the write "is refused
      outright" and that an undeclared write fails the task.
      - Fix (`schema.md`): the scratch case is described where it occurs,
        and the fail-on-violation policy says which writes it covers. No
        stale output follows (nothing undeclared survives the run).
        Remounting the punched ancestor read-only needs a bwrap argument
        SRT does not emit; not pursued here.

1012. DONE (2026-09-27, the run-history review's lead 5, documented).
      Two worktrees sharing a `--cache-dir` share one history: `vx why`
      in one named the other's edit as "changed file", and `vx last`
      showed the other's run, with only the branch to tell them apart.
      - Fix (`cli.md`): says history is the cache directory's, not the
        checkout's. Scoping it by workspace would need a column on
        `invocations` and a `SCHEMA_VERSION` bump that drops every index;
        a shared cache is a choice the user makes, so the note is the fix.

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

**Releases.** Every green merge to main releases itself (item 1018,
`auto-release.yml`); the first auto-released version is the next patch
after v0.0.21. v0.0.21 is on npm, the four platform packages with it
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
    `docs/history/2026-09-improvement-loop-893-932.md` and 933–972 in
    `docs/history/2026-09-improvement-loop-933-972.md`. The loop above
    is the record since 973 (14dj in the next-log file); 14dk is below,
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
