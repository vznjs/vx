# Shipped, 2026-09 — improvement-loop items 973–1012

The record `docs/STATUS.md` carried until 2026-09-27, moved here whole
when the loop reached forty items (item 1041). A PREFIX,
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
`2026-09-improvement-loop-933-972.md`; items 1013 onward continue in
`docs/STATUS.md`.

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
