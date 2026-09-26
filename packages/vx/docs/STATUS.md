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
893), so
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

893.  DONE (2026-09-26, the trim the loop reached forty at). Items
      853–892 moved to `docs/history/2026-09-improvement-loop-853-892.md`
      in this commit. What that stretch was: a Ctrl-C made to end a run
      cleanly, with no history row and no prune (853–858); a guard that
      takes a SIGKILLed vx's task groups down with it, and its sweeps
      (860–871); the sandbox's port bridges and temp files cleaned up,
      and the reset a held server needs (873–884); then review agents'
      reproduced leads: two stale hits (an output skip-restore stamped
      by inode and ctime, 886; a file's mode in its key, 887), impure
      config imports (888), a remote's provenance (889), the
      `...^` filter (890), the watch loop's re-read (891) and a
      dependency-only server's crash (892).
894.  DONE (2026-09-26, item 890's last open note). `vx run ci --all
--exclude-dependencies` on a group ran nothing and exited 0. A group
      is its members, and bare `--exclude-dependencies` dropped the group's
      own edges with the rest, so only the group stayed scheduled.
      - Now `'all'` keeps a group's edges (nested groups too) and drops
        its members' dependencies: `ci` runs lint and test, not build.
      - A name list still decides edge by edge, so
        `--exclude-dependencies=lint.oxfmt` still takes one member out
        of `lint`. The existing row for that form guarded this, and a
        first draft that kept every group edge broke it.
      - Rows: `task-graph.test.ts` (item 894). The `'all'` row over a
        nested group fails without the fix; the name-list control passes
        both ways.
895.  DONE (2026-09-26, macOS CI on #967). `run-lock.test.ts` › "a wait
      longer than a second names the holder once" went red once on
      macOS, at 2001 ms, in code #967 does not touch. The recap tail
      held no assertion text, so which side moved is unproven. The row
      slept a fixed 1.3 s against the notice's 1 s threshold, a 300 ms
      margin on a loaded runner.
      - It now waits for the notice (up to 4 s), measures it came at
        1 s or later, lets several more polls pass while the holder
        lives, and compares the exact lines at both ends, so an extra
        line would show in the failure.
      - Mutants caught: a zero threshold, and a notice on every poll.
        The first draft missed the second, because it ended the holder
        right after the first notice. 25 runs of the file under CPU load
        on Linux were green before the change.
      - A re-run of the job was refused (403), so the row went into
        #967 rather than a PR of its own.
896.  DONE (2026-09-26, an inspection-verb review agent's lead 1). A
      reading verb reset the cache index. `vx last`, `vx why`, `vx info`
      and `vx cache prune --dry-run` dropped every table of a `cache.db`
      whose schema they could not read, entries and run history alike.
      They did it to a NEWER schema too, and said "vx upgraded" after
      the downgrade. So did a run: an older vx binary beside a newer one
      (a global install and a workspace's own) wiped the newer one's
      index.
      - Now only an earlier schema is reset, and only by a writing
        opener. `Cache.inspect(dir)`, used by the four reading verbs,
        refuses any schema it cannot read. Every opener refuses a newer
        one. Each refusal is a `UserError` naming the directory and both
        versions, and leaves the index as it was.
      - Rows: `schema-reset-notice.test.ts`. One per reading verb over an
        earlier schema, plus a newer schema refused by a run and by
        `last`, each comparing the index before and after. All five fail
        without the fix. The old `last` and `why` rows, which pinned the
        reset notice, are replaced; `vx show` still shares the run's
        loader and resets like a run.
897.  DONE (2026-09-26, the same review's lead 6). A task was looked up
      as `tasks[name]` on a plain object, so a name that
      Object.prototype carries was a task. `vx show constructor` printed
      a group task for every project, `vx show a#toString` printed one,
      and `vx run a#toString` ran nothing and exited 0, where an unknown
      name is an error.
      - `declaredTask(config, name)` in the graph module now looks a task
        up by own property. The builder, the request helpers and
        `vx show` all go through it. `select.ts` walks own keys already.
      - Rows: `task-graph.test.ts` covers the request helpers, with a
        control where the config does declare `constructor`.
        `show-info.test.ts` covers both show forms. Both rows fail
        without the fix.
898.  DONE (2026-09-26, the same review's leads 4 and 5). `vx why`
      misdescribed a run that did not execute cleanly.
      - A skipped task read `skipped · executed · key ` with nothing
        after "key". It never ran and derived no key, so it now reads
        `skipped · no key`.
      - A failed run saves no entry and keeps no fingerprints, but the
        detail line said "the entry was pruned". `cli.md` names "the
        run failed and never saved one" as a cause. The note now names
        whichever side ended without passing: "this run ended failed
        and saved no entry", or "the previous run …".
      - Rows: `why.test.ts` covers the skipped line; `metrics.test.ts`
        covers the failed side, both ways round. Both fail without the
        fix. The pruned row now pins its exact sentence as the control.
899.  DONE (2026-09-26, the same review's lead 3). `vx last --list 1`
      read the `1` as a run id. `--list` then ignored that id, and ten
      runs came back with exit 0. Only `--list=1` worked, though every
      other value flag on these verbs takes the space form.
      - `--list` now takes the next argument as its count when it is a
        bare integer; a run id never is one.
      - A run id beside `--list` is refused, rather than dropped.
      - Row: `last.test.ts` › `parseLastArgs`, with the exact results of
        the forms side by side. It fails without the fix.
900.  DONE (2026-09-26, the same review's lead 2, its last). A reading
      verb made a cache. `vx last --cache-dir .vx/cahce` created the
      typo's directory, a `.gitignore` and a database, then said "no
      recorded runs yet". `why`, `info` and a dry prune did the same, and
      on a workspace that never ran each of them created `.vx`.
      - `Cache.inspect` over a directory with no `cache.db` now reads an
        empty index in memory and creates nothing.
      - A `--cache-dir` the user names that is not there is refused by
        name (`namedCacheDir`). `vx info` checks it itself, because
        `collectInfo` also serves `vx mcp`, which passes the resolved
        default of a workspace that may never have run.
      - Rows: `inspect-no-create.test.ts` runs the four verbs both ways,
        with the positive (a run does make `.vx`). Both rows fail without
        the fix.
      - The gate found two rows that leaned on the old behaviour. A
        `vx info` orphan row wrote into the directory an earlier row's
        `info` had made; it now makes the directory itself. The
        `cliCacheDir` row resolved a directory that did not exist; it now
        resolves one that does, and a new row pins the refusal. A first
        draft put the check in `collectInfo` and broke the doctor's bun
        row, which is how the `vx mcp` caller came to light.
      - macOS CI then failed the refusal row: the fixture root came from
        `mkdtemp` (`/var/…`, a symlink), while the verb names the path its
        cwd resolves (`/private/var/…`). Reproduced on Linux with a
        `TMPDIR` reached through a symlink; the fixture root is now
        canonical.
901.  DONE (2026-09-26, a lockfile-plugin review agent's lead 3). A stale
      hit in `@vzn/vx-lockfile`'s bun parser. A dependency of a scoped
      package nested under another (`foo/@s/y` → `bar`) stepped up to
      `foo/@s` rather than past it, and resolved to `foo/@s/bar`, another
      package. The root `bar` it installs was never folded, so bumping it
      re-keyed nothing.
      - The resolver now walks package levels, a scoped name being one
        level at any depth, not only at the root.
      - Row: `bun.test.ts` (item 901), with the control of the same bump
        and no scoped sibling to mistake. It fails without the fix.
      - The same review reproduced two yarn stale hits (items 902, 903).
902.  DONE (2026-09-26, the same review's lead 1). A stale hit in the
      yarn classic parser. A descriptor re-pointed from one entry to
      another, as a deduplication or `yarn upgrade` writes it
      (`foo@^1.0.0` moving from the 1.0.0 entry to the 1.1.0 one), changes
      what a workspace installs. Every entry's version, url and integrity
      stay as they were, and those were all the digest read. The run
      after was a hit, and `--affected` said nothing was affected.
      - Each classic entry now folds the descriptors it satisfies,
        sorted, so their order in the header moves nothing.
      - Row: `yarn.test.ts` (item 902), with the reordered-header control.
        It fails without the fix. On the review's repro the run misses
        and `--affected` names both projects.
903.  DONE (2026-09-26, the same review's lead 2). A stale hit in the
      yarn berry parser. A root `resolutions` override to a `patch:`
      leaves no `is-number@npm:^7.0.0` key in `yarn.lock`, so the
      dependency that asks for it resolved to nothing. The patched entry
      installed in its place was reached by no workspace, and a patch
      edit, which rewrites that entry's hash and checksum, re-keyed
      nothing.
      - A berry descriptor the file does not key now reaches every entry
        of its package name, as a catalog range already did: a bump of
        any of them moves the workspace, never a bump of none.
      - Row: `yarn.test.ts` (item 903), a patch entry with no `npm:` key
        whose hash changes. It fails without the fix. On the review's
        real Yarn 4 repro the run misses. The README says so.
904.  DONE (2026-09-26, the same review's minor lead). A pnpm lockfile
      the plugin could not read was refused as "pnpm-lock.yaml:
      pnpm-lock.yaml is not a YAML document". The plugin prefixes a
      parser's message with its file unless the message opens with
      `<file>:`, and pnpm's parser named it another way. The same was
      fixed for bun on 2026-09-20.
      - The class is held now: one row in `refusal-message.test.ts` pins
        each manager's whole refusal, file named once, the install that
        fixes it, and the side it came from. Only pnpm's entry fails
        without the fix.
905.  DONE (2026-09-26, an init/migrate review agent's leads 3 and 4).
      `vx init` and `@vzn/vx-migrate` fold a script's `pre<name>` /
      `post<name>` hooks into its command. They did it with a plain
      `&&` join, and that mis-ran two ways:
      - Forwarded `--` args are appended to the command, so they landed
        on the post hook: `echo POST --flag`.
      - A body holding a `;` split the chain, so `test -f ready.flag &&
echo A; echo B` went green after a failed pre hook, and a cache
        block would have saved that success.
      - The fix is one function, `foldScriptHooks`, on the migration seam
        (façade, 46 runtime symbols), that both mappers call. Each part
        is its own subshell, and each ends on its own line so a trailing
        `# comment` cannot swallow the paren. The chain sits in a
        `vx_script` function that the forwarded args reach, and only the
        body takes them, as npm does. A script with no hooks is still its
        body, verbatim.
      - Rows: four behaviour rows in `migration.test.ts` run the fold
        through `sh` as the runner does (args, a failing pre hook with a
        `;` body, a failing body, trailing comments), with the no-hook
        control. Three fail against the old join. The review's three
        repros now match `bun run`.
906.  DONE (2026-09-26, the same review's lead 1). A stale hit in
      `turbo()`. A package `turbo.json` overlay array holding
      `$TURBO_EXTENDS$` (Turbo 2.5+) means the inherited list plus the
      overlay's own entries. The mapper spread the overlay whole, so the
      token became a literal input glob and env name, and the root's
      `inputs`, `env` and `dependsOn` were gone. An edit to `src/`, and a
      change of `MODE`, hit the cache with the old output, and
      `lib#build` never ran first.
      - `withOverlay` keeps the inherited list and appends for any
        overlay array that holds the token; one without it still
        replaces.
      - Rows: `turbo-map-sweep.test.ts`, the three fields at once, with
        the replace control. It fails without the fix, and the review's
        repro now misses. The vx-migrate README says so.
907.  DONE (2026-09-26, the same review's lead 5). `vx init` made a
      `build` that only delegates (`build: pnpm run compile`) a group over
      `compile`, and a group carries no `^build`. So `app#compile` ran
      before `lib#build`, and read a `dist` that was not there.
      - The edge goes on the task that does the work, followed through
        a chain of groups to the first command. On the group itself it
        would not hold: the group waits on both, `compile` on neither.
      - Row: `init.test.ts` › `migrateScripts` (item 907), direct and
        chained. It fails without the fix, and the review's repro now
        builds `lib` first. `cli.md` says so.
908.  DONE (2026-09-26, the same review's lead 6). `vx init` read a
      script that runs the package manager's own command as a delegation
      to a script of that name. `bun x tsc` became a group over a script
      `x`, and `bun test` / `pnpm install` / `yarn add` did the same.
      - Only `npm run`, `npm test` / `npm start`, `<pm> run <name>` and a
        bare `<pm> <name>` that is not one of that manager's own
        commands delegate now. Each other command stays a command.
      - Rows: `init.test.ts` › `delegatedScript`: `bun x`, `bun test`,
        `bun build`, `pnpm install`, `yarn add` stay commands, and
        `bun dev` still delegates. They fail without the fix, and an old
        row that pinned `bun x` as `x` is corrected. `cli.md` says so.
909.  DONE (2026-09-26, the same review's lead 2). A stale hit in
      `turbo()`. Turbo 1 names an env dependency as `$NAME` in a task's
      `dependsOn` and in `globalDependencies`. The mapper dropped the first
      and read the second as a workspace glob that matched nothing, so a
      changed `API_URL` replayed the old `dist`.
      - Both now join `cache.inputs.env` and `exec.env.passThrough`.
        `$TURBO_ROOT$` and a `$` inside a name are not env names (a
        control row).
      - Row: `turbo-map-sweep.test.ts` › turbo 1 `$NAME` env
        dependencies. It fails without the fix, and the review's repro
        now misses on a changed var. The vx-migrate README says so.
910.  DONE (2026-09-26, an nx() review agent's leads 1 and 2). A stale
      hit in `nx()`. Nx hashes `^production` over the project graph
      whether or not a task edge exists, and the mapper dropped it as
      "folded through dependsOn": the stock `test` (`default`,
      `^production`, no `dependsOn`) hit after a dependency's source
      changed. Project-level `namedInputs` were not read either.
      - Each project gets an `nx-input:<name>` twin keyed on its own
        input and chained along the Nx graph; a task reading `^name`
        depends on its direct dependencies' twins. No `inputs` is
        `default` + `^default`, as in Nx.
      - A first cut listed the closure's globs on every task: 2.5
        million globs, mapping 91 → 1,535 ms at 1,000 projects. The
        twins: 91 → 144 ms, and a warm 300-project run 159 → 256 ms (598
        twins, about 0.16 ms each; the "before" arm is the stale key).
        Next 25 is the follow-up.
      - Rows: `nx-map-sweep.test.ts` › `^` inputs fold over the project
        graph (seven: chained twins, implicit `^default`, project named
        inputs, `projects`, a missing input, a transparent node, a
        cycle). Each fails without the fix, and the review's two
        end-to-end repros now re-run. The design doc and README say so.
911.  DONE (2026-09-26, a vx-reapi review agent's lead 1). Wrong bytes
      cached through remote execution. The execution record splits an
      output directory the worker returned whole by the declared globs,
      and its walk followed directories only: `dist/*` recorded `dist/sub`
      and dropped `dist/index.js`, so a replay returned exit 0 without it
      and core saved the short tree under the pure-input key.
      - The last segment matches files and symlinks too, recorded as the
        record's output files and symlinks, as the local glob saves them.
      - Same class, same function: a glob the walk cannot split
        (`dist/*.js`) was skipped while its sibling split, so
        `['dist/*.js', 'dist/*/gen']` recorded only `gen`. Any such glob
        now keeps the entry whole.
      - Rows: `executor-helpers-sweep.test.ts` › the record's output
        directories (three new, each failing without its fix; the
        directory-only rows are controls). Found, not fixed: a graft
        takes a record's files and directories, not its symlinks.
912.  DONE (2026-09-26, the nx() review's lead 3). Nx interpolates
      `{workspaceRoot}`, `{projectRoot}` and `{projectName}` anywhere in a
      path; the mapper read only a leading token. `@nx/jest`'s
      `{workspaceRoot}/coverage/{projectRoot}` output became the literal
      glob `coverage/{projectRoot}/**`, saved nothing, and a hit restored
      nothing. Outputs also resolved only their first `{options.x}`.
      - One helper, `nxWorkspacePath`, interpolates to a workspace path;
        a path that lands in the project is a project glob, else a
        workspace one. Inputs go through it too.
      - Rows: `nx-helpers-sweep.test.ts` › a token anywhere in a path
        (three). With the old leading-token rule put back in the new
        code, those three fail and nothing else does. The review's repro
        now restores `coverage/packages/app/lcov.info` on a hit.
913.  DONE (2026-09-26, the nx() review's lead 4). Nx runs a
      `{ runtime }` input at the workspace root; the mapper put it in
      `cache.inputs.runtime`, which runs in the project dir. So
      `cat tools/version.txt` failed a run Nx passes, and a command that
      runs in both places hashed a different fact.
      - It is `workspaceRuntime` now, which also runs each command once
        per run, not once per project. The `.env` probe stays in
        `runtime`: its paths are project-relative. schema.md no longer
        calls `runtime` the Nx input's equivalent.
      - Row: `migrate.test.ts` › pkg-a covers … (the runtime line), red
        without the fix; the review's repro now succeeds.
914.  DONE (2026-09-26, the nx() review's lead 6, and a regression of
      912). vx has no character classes (a bracket is literal, item 667)
      and no extglobs, so an Nx input `src/**/*.[jt]s` matched no file — a
      stale hit on any source edit — and Nx's own default `production`
      negation, `?(*.)+(spec|test).[jt]s?(x)`, excluded nothing. And 912
      read a brace set (`*.{ts,tsx}`) as an unknown token, dropping that
      input with a todo.
      - A class is a brace set, plus the literal in a positive glob (the
        route dir may be meant; more inputs only cost hits). `?()` and
        `@()` are brace sets; `+()` and `*()` narrow to one repetition
        only inside a negation, which then excludes fewer files, never
        more. A range, a negated class, `!()` or nesting is a todo.
      - A leftover token is `{name}` with no comma; a brace set is a glob.
      - Rows: `nx-helpers-sweep.test.ts` › Nx glob grammar in inputs
        (four). Undoing the translation fails three; undoing the token
        rule fails the brace-set row.
915.  DONE (2026-09-26, the nx() review's lead 5). Nx splits `a:b`
      into project and target only when `a` names a project; otherwise the
      whole string is a target of the same project, which is how
      script-inferred targets are named. `dependsOn: ["test:unit"]` was
      read as project `test` and dropped with a todo, so `ci` ran without
      its tests first.
      - A colon string whose head is no workspace package is this
        project's own target when it has one; neither is the old todo, not
        a same-project edge core would refuse at load.
      - Row: `nx-helpers-sweep.test.ts` › mapNxDeps › a colon string whose
        head is no package, red with the branch disabled. That closes the
        nx() review.
916.  DONE (2026-09-26, the vx-reapi review's lead 2). A remote read
      that failed the task instead of degrading. Replaying an execution
      record is a cache read, and a failed record read already warned and
      executed; but the replay's stdout Read and its output writes ran
      outside any catch, so one transient UNAVAILABLE failed the task.
      - Any failure on the replay path warns and executes for real. Core
        cleaned the declared outputs once, before the executor, and not
        again, so a replay that wrote part of the tree takes back what it
        CREATED (the outermost new directory, a file `wx` could create, a
        link whose name was free); what it overwrote was on disk before
        and stays. Replayed stdout is delivered only once the replay has
        landed, so a fall-through does not print twice.
      - Rows: `executor-sweep.test.ts` › the execution record (two: a
        transient stdout Read executes; a part-way failure takes back
        what it created and only that), each red without the fix; the
        cleanup's two mutants (none, everything written) are caught.
      - Found, not fixed: `readBlob` / `readBlobStream` have no retry on
        UNAVAILABLE, unlike the unary calls, so on the execute path one
        transient Read of a finished action's outputs fails the task.
917.  DONE (2026-09-26, the vx-reapi review's lead 3). A remote-execution
      hang with no deadline. When the stall timer (`exec.timeout` /
      `executeTimeoutMs`) fired while `execute` slept in the backoff
      between a dropped stream and its `WaitExecution`, the re-attach
      subscribed to an already-aborted signal whose listener never fires,
      and the stream has no deadline of its own: a wedged server held the
      task forever.
      - `operationStream` refuses at once on an aborted signal, before it
        opens a stream, and the backoff sleep is abortable.
      - Rows: `wire-exec-sweep.test.ts` › an abort that came before the
        stream is heard without opening it; `executor-sweep.test.ts` › a
        stall that fires during the re-attach backoff still bounds the
        task (elapsed under 350 ms against a 200 ms bound, measured
        202–210). Each fix is held on its own: a plain sleep with the
        pre-check kept is caught (515 ms), and the pre-check removed is
        caught by the wire row.
918.  DONE (2026-09-26, the vx-reapi review's lead 4). A stream that
      ended cleanly after QUEUED or EXECUTING resolved with that last,
      unfinished operation, and the executor failed the task with
      "returned no ActionResult" while the action was still running on the
      server.
      - `execute` returns only a `done` operation: a clean end on an
        unfinished, named one re-attaches with `WaitExecution` on the
        dropped-stream budget (three, backing off 100/400/1600 ms), then
        refuses by name; an unnamed one cannot be re-attached and is
        refused at once. A stream with no operation is refused as before.
      - Rows: `wire-exec-sweep.test.ts` (three: re-attaches by name,
        spends the budget then refuses, an unnamed one is refused), each
        red without the fix; the no-operation row is the control.
919.  DONE (2026-09-26, found fixing item 916). Every unary REAPI call
      retries UNAVAILABLE and RESOURCE_EXHAUSTED on a bounded budget; a
      ByteStream Read did not, so one transient status reading a finished
      action's stdout or outputs failed the task after the action had
      succeeded.
      - `readBlob` retries on the same budget (100/400/1600 ms);
        `readBlobStream` retries until its first message reaches a
        reader, never after.
      - Rows: `wire-sweep.test.ts` › a transient Read is retried (whole
        and streamed) and a Read that stays unavailable fails once the
        budget is spent, both red without the fix. Item 916's replay rows
        inject INTERNAL now, which still reaches the fall-through.
920.  DONE (2026-09-26, found fixing item 911). A consumer of a
      remote-only upstream grafts the upstream's execution record into its
      input root by reference; the graft took the record's files and
      directories but not its symlinks, so the action ran without an input
      it declared and its result was cached under a key asserting it.
      - The record's `output_symlinks` graft as symlinks of the input tree.
      - Row: `executor-sweep.test.ts` › a record graft keeps the
        upstream's symlinks, red without the fix. That closes the
        vx-reapi review.
921.  DONE (2026-09-26, an observability review agent's lead 1). A
      failed run that exited 0. A plugin's `telemetry()` was awaited with
      no deadline, unlike its flush and teardown: a hook that never
      settled held the run before its first task, and once the loop
      drained Bun exited 0 — the task never ran and CI went green.
      - The consultation goes through `settleWithin(teardownTimeoutMs())`
        and drops the plugin with a warning, as a throwing one is.
      - The class: `bin.ts` fails any process whose loop drains before
        the verb returned, with a line saying so, so a hook that never
        settles anywhere else (a `setup`, any stage) exits 1, never 0.
      - Rows: `telemetry-lifecycle.test.ts` › a hook that never settles
        (in `telemetry()`: dropped, the run runs; elsewhere: exit 1 and
        the line), each red with its own fix undone.

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
   item 885 (2026-09-26, the day's items 873–884, a tie at 1,000 projects; 863 was the one before), and the
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
    `docs/history/2026-09-improvement-loop-820-852.md` and 853–892 in
    `docs/history/2026-09-improvement-loop-853-892.md`. The loop above
    is the record since 893 (14dj in the next-log file); 14dk is below,
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
24. **strace's own ptrace error ended a sandboxed task (2026-09-26,
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
25. **A key-only task for `nx()`'s `nx-input:<name>` twins (item 910).**
    A twin runs `true` so that its key, the project's `^` input, folds
    into its dependants. At 300 projects the 598 twins cost 97 ms of a
    159 ms warm run. A task kind that is a key and nothing else (no
    spawn on a miss, no history row, not printed) would take most of it
    back. Measure the twins' share first: is it the key, the lookup or
    the row?

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
