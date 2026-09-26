# Shipped, 2026-09 — improvement-loop items 893–932

The record `docs/STATUS.md` carried until 2026-09-26, moved here whole
when the loop reached forty items (item 934). A PREFIX,
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
`2026-09-improvement-loop-853-892.md`; items 933 onward continue in
`docs/STATUS.md`.

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
922.  DONE (2026-09-26, the observability review's lead 2). `vx mcp`'s
      stdout is the JSON-RPC stream, and a tool that loads the workspace
      evaluates configs and plugin stages: what they printed landed in it,
      and a strict client drops a connection on a line that is not
      JSON-RPC.
      - `serveStdio` keeps the real writer and sends every other stdout
        write and console method to stderr while it serves. Bun's
        `console.log` writes to fd 1 without `process.stdout.write`
        (probed), so the console is replaced too.
      - Row: `server.test.ts` › keeps stdout JSON-RPC while a config or a
        plugin stage prints (both spellings), red without the fix. The
        server grew to 179 lines, and the four "about N lines" claims the
        site test holds moved to 180.
923.  DONE (2026-09-26, the observability review's lead 3).
      `OTEL_EXPORTER_OTLP_HEADERS` is W3C Baggage format, percent-encoded,
      and vendors document auth as `Authorization=Basic%20…`; vx-otel sent
      it literally, so the collector refused every export 401 behind one
      warning. `OTEL_EXPORTER_OTLP_<SIGNAL>_HEADERS` was not read at all.
      - Keys and values are percent-decoded (a malformed escape kept as
        written); a signal's own headers ride its POSTs over the shared
        ones, and the plugin's `headers` option tops both.
      - Rows: `otel.test.ts` › percent-decodes keys and values; a
        signal's own headers ride its POSTs over the shared ones. Both red
        without the fix.
924.  DONE (2026-09-26, the observability review's leads 4 and 5).
      vx-github's `clampSummary` cut the check-run markdown in UTF-16 units,
      so an emoji at the cut (the aborted label 🛑, or one in a task id)
      split into a lone surrogate the POST body carried. And `??` kept an
      empty `GITHUB_API_URL`, so the POST went to a relative URL fetch
      refuses — the one of the four variables the empty-is-absent rule
      missed.
      - The cap is held in UTF-8 bytes (never fewer than GitHub's
        characters), cut on a character as the job summary's clamp is;
        an empty API URL is absent.
      - Rows: `github.test.ts` › the check-run clamp cuts on a character
        and fits the cap in bytes (four offsets); resolveCheckRunEnv's
        empty API URL. Both red without the fix.
925.  DONE (2026-09-26, Next 24's third hit, CI on #997). The shard
      that hosts `output-memory.test.ts` ended three times on Linux CI with
      no failed row, its last line strace's own
      `ptrace(PTRACE_LISTEN…): Input/output error`, each time right after
      the stream-capture row — where the four concurrent stdout floods
      start and are SIGKILLed.
      - The file is `output-memory.unsafe.test.ts` now: every row is a
        child's RSS and needs no sandbox, and a traced task's exit code is
        strace's. What the floods do to strace stays unproven (11 local
        runs clean, bare and sandboxed); if the error recurs elsewhere,
        the trigger was not this file, and Next 24 says so.
926.  DONE (2026-09-26, the observability review's lead 7). JSON-RPC 2.0
      never answers a notification. `vx mcp` stayed silent for one that
      succeeded or named an unknown method, but a `tools/call`
      notification with a bad name, or one whose tool crashed, was
      answered with `id: null`.
      - Every error path goes through one helper that is silent for a
        notification.
      - Row: `server.test.ts` › a notification gets no reply even when it
        fails; the same call with an id does. Red without the fix.
927.  DONE (2026-09-26, the observability review's lead 6). vx-otel sent
      each run's task counts as CUMULATIVE monotonic sums with no start
      time, on a series named only by service name and version: a backend
      read two runs of 10 tasks as a series that never rose, and parallel
      CI jobs interleaved on it.
      - The counts are the run's own, so they are DELTA sums from the
        run's start to its end; the cache hits are one metric with a point
        per source, not two metrics of one name.
      - Rows: `otel.test.ts` › the metrics request (exact envelope) and
        the sink's metrics POST carries the run's start and end; each red
        without its part of the fix (the sink row catches the end passed
        as the start).
928.  DONE (2026-09-26, the remote-cache adapters review). Bun's fetch
      refuses a header value holding a line break, a NUL or a character
      past Latin-1, grpc-js anything outside printable ASCII, and both
      QUOTE the value in the error: a token read from a two-line secret
      file reached every degrade warning as `Bearer <token>`.
      - `turboCache()` / `nxCache()` refuse such a token when configured,
        naming the variable, never the value; vx-otel drops the header
        and warns with its key; vx-github skips the check run with a
        warning; vx-reapi's wire refuses the header at construction.
      - Rows: one per package (the turbo-cache and nx-cache sweeps,
        `otel.test.ts`, `github.test.ts`, `wire-sweep.test.ts`), each
        pinning the exact refusal or warning, which names no token.
929.  DONE (2026-09-26, the remote-cache adapters review).
      `turboCache()`'s batch query answers each hash with ArtifactInfo,
      null, or an `{ error }` entry, and `hasMany` counted anything not
      null as present: an error entry became a hit whose GET drew a 404.
      Only an object without an `error` field counts now.
      - Row: `turbo-cache-sweep.test.ts` › a batch query holds only the
        hashes answered with artifact info.
930.  DONE (2026-09-26, the schedule-history review). `assume` values
      reached the critical path unchecked: a NaN (`Number()` of an unset
      variable) became a NaN weight and a string from an untyped `.mjs`
      config a string weight, and core refused both as a UserError outside
      the plugin's fail-open, so an ordering hint failed the run.
      - A value that is not a finite non-negative number is dropped with
        one warning naming its task ids; the rest still order the run.
        The README says so.
      - Row: `schedule-history-e2e.test.ts` › an assumption that is no
        finite number is dropped by name; the run and the rest stand.
931.  DONE (2026-09-26, Next 25's measurement). `nx()`'s implicit-dep
      note built a two-project package graph for every Nx edge, on every
      run: 1,474 graphs, 36 ms cold, at 300 projects.
      - One graph of the workspace answers every edge. A manifest path
        through a third project reaches the target too: `^build` runs it
        first and the key folds it, so such an edge is no longer reported.
      - A/B on the 300-project Nx workspace (warm, CLI, interleaved,
        before arm a `main` worktree): `load configs` 141.0 → 118.8 ms
        at min (N=11); the wall 524 → 504 ms at min and 563 → 532 at
        median (N=31). A first 21-rep wall pass read 505 → 502 at min,
        555 → 541 at median.
      - Row: `nx-map-sweep.test.ts` › a manifest path through another
        project is no implicit dep, with the control that drops the
        middle entry. Red without the fix.
932.  DONE (2026-09-26, Next 25's measurement). Loading configs for a
      run walks the package-graph closure of each project a cross
      `pkg#task` edge names. It skipped the walk once every project was
      pending, but it read that off `pending`, which each round empties.
      So after the first round every cross edge walked its target's whole
      closure again: 1,500 walks for `nx()`'s twins at 300 projects.
      - A count of the projects considered replaces the length, and a
        closure is walked once per project.
      - A/B on the 300-project Nx workspace (warm, CLI, interleaved,
        before arm an item-931 worktree): `load configs` 130.7 → 107.9 ms
        at min (N=11); the wall 516 → 502 ms at min and 562 → 546 at
        median (N=31).
      - Row: `scoped-config-loading.test.ts` › a closure is walked once
        per project, and not at all once every project is in. Red without
        the fix, and red with either guard removed.
