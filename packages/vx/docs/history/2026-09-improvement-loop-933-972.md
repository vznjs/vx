# Shipped, 2026-09 — improvement-loop items 933–972

The record `docs/STATUS.md` carried until 2026-09-27, moved here whole
when the loop reached forty items (item 974). A PREFIX,
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
`2026-09-improvement-loop-893-932.md`; items 973 onward continue in
`docs/STATUS.md`.

933.  DONE (2026-09-26, the vx-lockfile review). Each parser folded a
      named list of install-wide fields into every project, and a field
      off the list moved no key and `--affected` selected nothing. Three
      such fields decide whose install scripts run, each reproduced with a
      real package manager: bun.lock's `trustedDependencies` (Bun 1.4.2),
      a pnpm 8 v6 lockfile's `onlyBuiltDependencies` /
      `neverBuiltDependencies`, and yarn 4's root-workspace
      `dependenciesMeta`. A workspace other than the root replayed output
      built under the old install.
      - pnpm and bun fold every top-level field except the ones they read
        per project. A berry entry folds every field except its dependency
        lists. So a field the parsers have never seen falls on the safe
        side. `DIGEST_VERSION` 3 → 4.
      - Rows: `bun.test.ts`, `pnpm.test.ts` and `yarn.test.ts` each have
        the reproduced field and a field no parser knows; all seven are red
        without the fix. Controls: removing any per-project exclusion
        reddens an existing row, and a new bun row does the same for
        `workspaces` (a workspace's own entry moves only it and what links
        it). v5's top-level lone importer stays in the global fold; it is
        the only importer, so nothing tells the two apart.
      - The configure guide's lockfile table says so. The site law that
        held its cell to the old list now holds it to the set each parser
        skips; it goes red when the cell drops one.
934.  DONE (2026-09-26, the trim the loop reached forty at). Items
      893–932 moved to `docs/history/2026-09-improvement-loop-893-932.md`
      in this commit. What that stretch was: review agents' reproduced
      leads, area by area — the inspection verbs (896–900), the lockfile
      plugin (901–904), `vx init` and migrate (905–909), `nx()`'s inputs,
      outputs and deps (910, 912–915), vx-reapi's reads, streams and
      retries (911, 916–920), the observability plugins (921–924,
      926–927) and the remote-cache adapters and schedule-history
      (928–930) — then Next 25's measurement and the two per-run costs it
      found (931, 932).
935.  DONE (2026-09-26, a turbo() review agent's lead 1). A root
      `pkg#task` in turbo.json was merged field by field over the generic
      `task`. Turbo instead looks up `pkg#task` and falls back to `task`
      only when it is missing. So an `app#build` that names no `inputs`
      (Turbo's every file) inherited the generic task's `src/**`, and an
      edit outside it replayed a stale build.
      - The `pkg#task` definition replaces the generic one, and the
        package's own turbo.json still overlays field by field. The
        README's definition order says so.
      - Row: `turbo-map-sweep.test.ts` › a root `pkg#task` replaces the
        generic task for its package, while the others keep it. Red
        without the fix.
936.  DONE (2026-09-26, the turbo() review's leads 2 and 7). Two input
      lists mapped wrong.
      - `inputs: []` is Turbo's default, every package file. It was
        mapped as no files, so an edit to the package replayed a stale
        build.
      - A list of exclusions alone (`["!**/*.md"]`) was refused by core,
        and that refusal failed the whole run.
      - An empty list now maps to `**/*`, and exclusions alone narrow
        `**/*`. The widest reading can cost a hit, never serve a stale
        one. The README says so.
      - Rows: `turbo-map-sweep.test.ts` › inputs `[]` and `["!**/*.md"]`,
        each red without the fix, plus a control that a list with a
        positive entry is left as it is.
937.  DONE (2026-09-26, the turbo() review's leads 5 and 6). Two
      turbo.json global fields mapped wrong.
      - A wildcard or `!` entry in `globalEnv` / `globalPassThroughEnv`
        reached core. Core refused it, and every task in the run failed.
        A task's own `env` wildcard was already a todo.
      - Turbo 1's `globalDotEnv` was never read, so an edit to one of its
        files re-keyed nothing and nothing was reported. A task's `dotEnv`
        was only an unknown-key todo.
      - A global wildcard is now a note, and the explicit names still key
        and pass through. `globalDotEnv` joins `workspaceFiles` the way
        `globalDependencies` does, and a task's `dotEnv` joins its `files`
        when it narrows `inputs`.
      - A gitignored `.env` among them gets core's existing refusal, as a
        `globalDependencies` literal already did: vx cannot key a file git
        does not report. The README, the migrate guide and the
        from-turborepo post name the new fields. The site law that counts
        the global fields the mapper reads now expects four.
      - Rows: `turbo-map-sweep.test.ts` › a global env wildcard is a note,
        and turbo 1's `globalDotEnv` and task `dotEnv` key the task. Each
        is red without the fix.
938.  DONE (2026-09-27, the turbo() review's lead 4). Turbo 2.5+ reads
      `turbo.jsonc` too, but only `turbo.json` was looked for.
      - A `turbo.jsonc` root failed the `turbo()` run with ENOENT.
      - A package's `turbo.jsonc` overlay was skipped in silence, so the
        inputs it added keyed nothing: a stale hit.
      - `bunx @vzn/vx-migrate` said there was nothing to migrate, and
        `vx init` did not name the file.
      - The mapper, the migrate CLI and `vx init` now take `turbo.json`,
        else `turbo.jsonc`. The README says so.
      - Rows: `turbo-map-sweep.test.ts` (root and package `.jsonc`),
        `migrate.test.ts` (a `.jsonc` root migrates, named as it is), and
        `init.test.ts` (the note names `turbo.jsonc`). Each is red without
        the fix.
939.  DONE (2026-09-27, the turbo() review's lead 3). A task Turbo
      defines but a package has no script for is still a node in Turbo's
      graph: a no-op that keeps its own edges. The mapper dropped it,
      edges and all. With `test → codegen → ^build` and no `codegen`
      script, `app#test` ran before `lib#build` and its key never folded
      it: a stale hit and a wrong order.
      - A dependency on such a task follows that task's own `dependsOn`
        in its place, once per task, and cycles end. A name Turbo does not
        define is still no edge. The README says so.
      - A `pkg#task` hop into a package without the script keeps its
        dropped-edge todo: its `^` edges belong to that package and have
        no form here.
      - Row: `turbo-map-sweep.test.ts` › a script-less task in a chain
        passes its edges through. Red without the fix. The review's
        fixture, run through real vx, now plans `app#test` after
        `lib#build`.
940.  DONE (2026-09-27, the turbo() review's lead 8, its last). Turbo 2
      hashes and passes a framework's env prefix (`NEXT_PUBLIC_*` for a
      package on `next`) with nothing in turbo.json saying so. vx env
      names are explicit, so the variables were stripped in silence and a
      Next build inlined empty values. That is not a stale hit (the
      variable never reached the task), but it is wrong output with no
      word of why.
      - A note names each framework, the packages that run a task on it,
        and the prefix to list. Only prefixes known for certain are
        listed: next, vite, react-scripts, gatsby, astro. The README says
        so.
      - Row: `turbo-map-sweep.test.ts` › a framework Turbo infers is named
        with its env prefix, with the control that a package running no
        task is not named. Red without the change.
      - The review is done: leads 1–8 are items 935–940.
941.  DONE (2026-09-27, a local-cache review agent's lead 1). Two output
      globs, one nested in the other (`dist/**` and `dist/extra/**`),
      were not counted as an overlap. The check decided glob against glob
      only for identical strings, and a row pinned the gap as a limit, so
      the pair was neither refused nor made additive. The wide task
      packed the narrow one's file into its own artifact. On a later hit
      it cleaned `dist/**` and put back its old copy after the narrow task
      had judged itself up-to-date, so `dist/extra/b.txt` flipped between
      B1 and B2 on alternate runs, green each time. With an edge between
      them, the pair was also never additive, so the wide task counted
      the narrow one's file as a stray and re-restored on every warm run.
      - A whole subtree `P/**` covers every glob whose literal prefix is P
        or under it, and that is certain, not guessed. With no edge the
        pair is refused; with one it is additive. Undecidable pairs
        (`dist/*` beside `dist/sub/**`) still pass. The candidate index
        finds the new pairs from the glob's side, and its 3,000-config
        fuzz against all-pairs still agrees. The warm path is unmoved:
        `build graph` 16.3 → 15.4 ms at min (N=11, interleaved, the
        300-project workspace, before arm a `main` worktree). The index
        work runs only for a project with two or more tasks that declare
        outputs, which that workspace barely exercises.
      - The review's fixtures through real vx: the no-edge pair is refused
        at graph build. The pair with an edge is up-to-date on a warm run,
        and its bytes are right through four input edits.
      - The same review measured that a restore does not get a new inode:
        ext4 reuses the one the clean freed. `caching.md` and
        `output-index.ts` claimed otherwise; both now say ctime is the
        guard and widen the residual to a recreated file. `schema.md`
        names the nested case.
      - Rows: `output-collision.test.ts` › four nested pairs refused in
        either order, plus an edge making the pair additive. All are red
        without the fix. The controls (a sibling subtree; a one-level
        glob beside a subtree) pass both ways.
942.  DONE (2026-09-27, a remote-cache-seam review agent's leads 1 and
      2). A remote artifact is untrusted bytes, and the restore
      materialised whatever names it carried.
      - Poisoned artifact: one naming `outputs/src/in.txt`,
        `workspace-outputs/.git/hooks/post-commit` and another project's
        file overwrote the input, planted the hook and wrote the file, all
        under a green `cache-hit-remote`.
      - Conflicting names: one holding `out.txt` as a file and as a
        directory failed the run with a message blaming the tree. It kept
        failing every run from the local copy after the remote was gone.
      - Ingest is the boundary now, and each case is refused there. The
        remote read becomes a miss and the task runs:
        - a file not in the task's declared `cache.outputs`, checked
          against the lookup's new `CacheGetContext.outputs` from
          `getContext` (in `remote-prefetch.ts`);
        - a path held as both a file and a directory.
      - Two lookup sites ask a remote, the prefetch and the task's own
        read, and both pass the declared outputs. The short-circuit probe
        runs only without a remote layer, where the context goes unread.
      - `caching.md` says so.
      - Rows: `remote-artifact-names.test.ts`. The poisoned and the
        conflicting artifact are each red without the fix; a row spies
        both lookup sites; the control, a clean remote artifact, is a
        remote hit. Removing each of the three parts (the name check, the
        file-and-directory check, the forwarding into ingest) reddens a
        row, and so does reverting either site.
      - Dropped as unheld: a restore-time "unrecorded entry" check (only a
        tampered local file reaches it) and a duplicate-name check (a
        duplicate rewrites one declared file).
      - Next from the same review: 943, an artifact is not bound to the
        key it was stored under, so a plugin's key mix-up replays another
        task's bytes. 944, a layer's `durationMs` is not sanitised.
943.  DONE (2026-09-27, the remote-cache-seam review's lead 3). Nothing
      tied an artifact to the key it was stored under. A remote layer
      that answered one key with another's bytes replayed the other
      task's outputs under a green `cache-hit-remote`; causes include a
      truncated or colliding key mapping, or two namespaces mixed. The
      review probed it: project `b`'s build restored project `a`'s
      `out.txt`.
      - The sidecar (`.vx-meta.json`) records the key. Ingest refuses an
        artifact whose key is not the one it asked for, or that records
        none, so the read is a miss.
      - `CACHE_VERSION` v34 → v35: the container changed, and a v34
        artifact records no key. The bump retires those rather than
        refusing each one on read. `caching.md`'s bump list, the module
        page, `cli.md`, CLAUDE.md and the bump skill say v35.
      - Rows: `remote-artifact-names.test.ts` › an artifact packed under
        another key, and under none, is a miss and its bytes are not
        restored. Both are red without the check. The 942 rows' fake
        remote now packs under the key it is asked for, so they still
        reach the check they are there to hold. Three ingest fixtures
        that built a keyless tar by hand now carry a sidecar with their
        key, and the ms-mtime row re-ingests an entry under its own key
        instead of another's. `key-fold.test.ts`'s digest is re-pinned,
        as every bump does.
944.  DONE (2026-09-27, the remote-cache-seam review's minor lead, its
      last). A remote layer's `durationMs` reached the entry row
      unchecked. A NaN failed the row's NOT NULL after the artifact was
      renamed into place: the valid hit was thrown away, the task ran and
      the bytes were orphaned. A negative, infinite or huge value was
      stored and replayed as the outcome's stored duration.
      - The layered cache takes the value only as a non-negative count
        up to `Number.MAX_SAFE_INTEGER`, rounded; anything else is 0.
      - Row: `remote-duration.test.ts` › NaN, Infinity, -5 and 1e300 are
        each a remote hit recorded as 0 ms, and 1.7 as 2. Red without the
        fix; removing each bound or the rounding reddens it.
      - The review is done: leads 1–4 are items 942–944.
945.  DONE (2026-09-27, a `vx watch` review agent's lead 1). `vx watch`
      judged a path it had never seen by its mtime alone. `mv`, `cp -p`,
      `rsync -a` and `tar x` carry a file's old mtime onto the new one,
      so a backup restored over an input counted as the initial run's and
      no cycle ran. The output stayed stale while the watcher looked
      current. Moving an old-dated package into `packages/` was worse:
      the member watcher's event read as "same", so no rearm ran and
      later edits inside it were missed too.
      - `modifiedBefore` compares the later of mtime and ctime. No
        process can set a ctime, and a rename or a write moves it. The
        initial run's own writes, which macOS delivers after the arm,
        carry both clocks from before it and stay quiet.
      - `cli.md` and the module page say so.
      - Rows: `watch-rules.test.ts` checks that a file with a backdated
        mtime and a new ctime is not "before" the arm, with the mtime
        alone as control. The loop row in `watch-loop.test.ts` moves an
        hour-old file over a watched path and gets one cycle. Both are red
        without the fix. The loop row's old "stale" half faked an old file
        with `utimes`, which moves the ctime too; no Linux operation fires
        an event and leaves both clocks old, so that half is the function
        row's now.
      - Next from the same review:
        - 946: another task's declared outputs hide the watched task's
          inputs.
        - 947: a task with no cache never re-runs on a git-ignored file.
        - 948: a held server's own writes restart it forever, with no
          notice.
        - 949: a config's imports outside its project, and the workspace
          config's imports, are neither watched nor re-read.
946.  DONE (2026-09-27, the `vx watch` review's lead 4). Watch's ignore
      list folded every task's declared outputs, in every project. So an
      in-place formatter declaring `src/**` as its outputs hid every
      `src` edit from a `build` watched beside it: no cycle ran, and
      `vx run build` would have run it.
      - The sweep also collects each project's declared input globs, and
        `makeWatchIgnore` never drops a path some task reads, whoever
        declares it as an output. A formatter's own rewrite costs at most
        one settled cycle; the streak notice catches a loop.
      - `cli.md` and the module page say so.
      - Rows: `watch-rules.test.ts` checks that an input under a declared
        output still counts, with the same map without inputs hiding it
        as control. `watch-loop.test.ts` re-runs `build` on a `src` edit
        beside a `src/**` formatter. The loop row is red without the fix.
947.  DONE (2026-09-27, the `vx watch` review's lead 6). Watch drops a
      git-ignored path because "no cache key can see it". But a task with
      no cache has no key and reads what it likes: its `.env.local` edit
      re-ran nothing.
      - The sweep records each project with a task that has a command and
        no cache, persistent servers aside. Under such a project, a
        git-ignored path the user wrote is judged like any other. One
        written inside the last cycle stays ignored: that is the task's
        own pid file, the loop the filter exists for (the self-write row
        caught a first cut that judged both).
      - `cli.md` says so.
      - Row: `watch-loop.test.ts` › a task with no cache re-runs on a
        git-ignored file it reads, in exactly one cycle, since its own
        rewrite of the ignored `shown.txt` is the run's. Red without the
        fix; the self-write row still holds.
948.  DONE (2026-09-27, the `vx watch` review's lead 5). A dev server
      that rewrote a log in its project restarted itself forever: 12
      restarts in 8 s, and no word of why.
      - The streak notice counts a path only when the cycle before wrote
        it. The server's write lands after that cycle ended, so it never
        counted.
      - While a server the last cycle started is held, the streak reads
        that cycle as open-ended, and the initial run's server counts from
        the arm.
      - The notice names the path with `.gitignore` as the remedy, since a
        persistent task declares no outputs. The restarts go on until the
        user acts, as for any self-write.
      - The 947 rule for a user's edit to an ignored file keeps the
        closed window.
      - `cli.md` says so.
      - Row: `watch-loop.test.ts` › a server that rewrites a file in its
        project is named after three restarts. Red without the fix.
949.  DONE (2026-09-27, the `vx watch` review's leads 2 and 3, its last).
      A config's imports from outside its project were in no arm.
      - Project config: a shared preset (`../../shared/preset.mjs`, the
        way configs compose) changed what a run evaluates, and watch ran
        nothing, while `vx run` ran the new command.
      - Workspace config: its imports are loaded in this process, and Bun
        keeps the module. Editing its helper was no event, and a later
        cycle still ran the old helper.
      - `configImports` (workspace module) lists a config's
        relative-import closure outside `node_modules`. The sweep collects
        it for every project config and for the workspace config. Watch
        arms each directory holding one outside the watched projects,
        non-recursive.
      - A project config's import is a cycle that re-reads the configs. A
        workspace config's import is named with the restart it needs: no
        supported API drops Bun's module, and the config holds plugin
        functions, so it cannot move to a JSON worker as project configs
        did.
      - `cli.md` and the config-cache module page (which now lists
        `configImports`) say so.
      - Rows: `watch-loop.test.ts` › a shared preset outside the project
        is watched and its edit re-runs under it, and an edit to a file
        the workspace config imports is named with the restart it needs
        (no cycle). Both red without the fix.
      - The review is done: its six leads are items 945–949.
950.  DONE (2026-09-27, a config-cache review agent's leads 1, 2 and 4).
      The config eval cache replayed an old evaluation, and so an old
      command and key, run after run; `--cache=local:` showed the new one.
      - A symlink on an import's way: retargeting `shared -> sharedA`
        edited no listed file, and the warm path re-hashed the old target.
      - `./preset.js` answered by `preset.ts` (the NodeNext style): a
        `preset.js` created later was what Bun evaluated, unseen.
      - A config linked in from elsewhere: its imports were resolved beside
        the link, Bun resolves them beside the real file, so the key
        folded a decoy. `configImports` (watch's arms) had it too.
      - Fix: imports resolve from the importing file's real path, and a
        closure is indexed only when each import names its file outright
        (explicit extension, the file itself, no symlink). A named file is
        taken without `Bun.resolveSync`, whose directory cache kept a
        retargeted link's old target for the process; the other spellings
        still ask it, recorded in the module page.
      - The first cut real-pathed the config itself, which opens it; the
        read-once pin caught the second `openat`. The directory is
        real-pathed instead, at the first relative import only.
      - Rows: `config-cache.test.ts` › the link, the `.js` → `.ts` and the
        linked-config rows red without the fix; a named import through a
        symlinked root stays indexed (control).
      - Next from the same review: 3 (an import after a same-line comment
        is never scanned), 5 (`bunfig.toml` `[define]` is not in the key),
        6 (the purity deny-list reached `Function` without a denied word).
951.  DONE (2026-09-27, an `--affected` review agent's lead 2). A repository
      that asks git to hide its submodules (`diff.ignoreSubmodules`, or
      `submodule.<name>.ignore` in `.gitmodules`) hid them from `--affected`
      too: with `dirty`, an edit inside one selected nothing; with `all`,
      so did a committed bump. The task's key moved each time, and
      `cli.md` says a dirty or moved submodule is selected.
      - Fix: the diff passes `--ignore-submodules=none`.
      - Row: `affected.test.ts` › the nested-repository row now also sets
        `diff.ignoreSubmodules all` and asks for the edit and the bump. Red
        without the fix.
      - Next from the same review: 1 (a `vx.workspace.*` edit, or one to a
        file its plugins read such as `turbo.json`, re-keys every task and
        selects nothing), 3 (a `workspaceFiles` path inside another project
        is never asked about), 4 (a deleted package skips its dependents),
        5 (a config's `fs` read is not followed), 6 (`--affected` is
        appended after every `!` exclude).
952.  DONE (2026-09-27, the config-cache review's lead 3). The config
      cache's import scan was a regex over the raw source that wanted a
      statement start before `import`, so an import after a comment on
      its line was never seen (`/* shared */ import …`). Its preset was
      neither keyed (an edit replayed the old evaluation) nor gated (a
      preset reading `process.env` was cached as pure). A string-named
      binding (`import { 'a-b' as x }`) was missed the same way.
      - Fix: the scan runs on `stripLiterals` output, comments gone, each
        string kept as a numbered placeholder, and every `import` token in
        the code must sit in a statement it matched, or the config
        evaluates live. `configImports` (watch's arms) uses the same scan.
      - Rows: `config-cache.test.ts` › the comment, the string-named and the
        unplaced-`import` rows, red without the fix.
953.  DONE (2026-09-27, the `--affected` review's lead 1, first half). An
      edit to `vx.workspace.*`, or to a file it imports, re-keyed every
      task (its plugins' `config` and `project` stages shape every
      resolved config) and `--affected` selected nothing, exit 0. The
      fingerprint leaves the file out on purpose, and selection mapped
      the root path to no project.
      - Fix: such an edit selects every project (`workspaceConfigChanged`
        in `affected.ts`, over `configImports`). Selection is not hashed;
        no key moves.
      - Row: `affected.test.ts` › the workspace config and its import each
        select every project, an unrelated root file nothing (control). Red
        without the fix.
      - Open, the lead's second half: a file a plugin READS at run time
        (`turbo()`'s `turbo.json`, `nx()`'s `nx.json`) re-keys tasks and
        is not seen. It needs a seam, a plugin declaring the root files it
        reads, as `fingerprint` claims do; `vx watch` wants the same list.
954.  DONE (2026-09-27, the `--affected` review's lead 3). A
      `workspaceFiles` glob naming a file inside ANOTHER project
      (`schema.md` allows it) re-keyed the declarer when the file changed,
      and `--affected` ran the owner alone: the glob owners were asked
      only about paths no project owns.
      - Fix: they are asked about every changed path, once something
        changed. The `--affected` sugar's graph walk has staged every
        config already, so it costs nothing there; a bare `[ref]` filter
        pays that one staged load. `projectsContaining` lost its orphan
        list, now unread.
      - Rows: `affected.test.ts` › an in-project path is asked too;
        `affected-workspace-files.test.ts` › a glob into another project
        selects its declarer through the real CLI. Both red without the
        fix; the nothing-changed row keeps the cost gate.
955.  DONE (2026-09-27, the `--affected` review's lead 6). `--affected`
      is `...[<base>]`, appended after every `--filter`; filters apply in
      argv order, so a `!` exclude ran before it and removed nothing
      (`--affected --filter '!app'` still ran app, either order).
      - Fix: the sugar is the first pattern, so every `--filter` applies
        after it. `cli.md` says so.
      - Row: `affected-base-notes.test.ts` › a `!` exclude removes a
        project from `--affected` on either side of it, the bare
        `--affected` its control. Red without the fix.
956.  DONE (2026-09-27, the config-cache review's lead 5). A
      `bunfig.toml` `[define]` the config reads (`BUILD_MODE`, a bare
      identifier no deny word sees) was not in the eval key: flipping it
      from `dev` to `prod` replayed the `dev` evaluation run after run.
      A `preload`, `--define` or `BUN_OPTIONS` could do the same.
      - Fix: the seed folds the transpile inputs: the cwd's and the global
        `bunfig.toml` bytes, `process.execArgv` and `BUN_OPTIONS`, read
        once per process (a running Bun does not reload them either). No
        version bump: the seed moved, so every old row misses.
      - Row: `config-staleness.test.ts` › flipping the define re-evaluates,
        through the real CLI; red without the fix. The seed pin names the
        new part's place.
957.  DONE (2026-09-27, the config-cache review's lead 6, its last). The
      purity gate reached `Function` with no denied word in code:
      `(() => 0)['constructor'](…)` (the literal was stripped before the
      test) and `Object.getOwnPropertyNames(Object.getPrototypeOf(…))`, and
      such a config was cached as pure while reading `process.env`.
      - Fix: the deny-list takes the reflective primitives (`Reflect`,
        `getPrototypeOf`, `setPrototypeOf`, `getOwnPropertyNames`,
        `getOwnPropertyDescriptor(s)`, `__proto__`, `prototype`, the
        `__define…__`/`__lookup…__` accessors), and a string literal
        holding `constructor`, `__proto__` or `prototype` evaluates live.
      - The claim is qualified: a key assembled at run time still passes,
        so the gate stops accidental impurity, not a config written to
        defeat it (`config-cache.md`, `caching.md`). A runtime taint on
        `Function`'s constructors was weighed and left: it rewrites
        prototypes in the process that evaluates live configs too.
      - Rows: `config-cache.test.ts` › four new spellings in the refusal
        table, each red without the fix. The module page and the
        resolved-config-hashing post list the new words, held to
        `IMPURE_RE` by their laws (flat alternatives: the laws read
        `[^)]*`).
      - The review is done: leads 1–6 are items 950, 952, 956, 957 (1, 2
        and 4 were one fix).
958.  DONE (2026-09-27, the `--affected` review's lead 5). A deleted or
      renamed config-import target does not resolve, and an unresolvable
      import contributed no edge: `--filter '[HEAD]'` exited 0 with the
      importing config broken.
      - Fix: such a specifier records its edge to the path it names (and,
        bare of an extension, each file Bun would have tried), so the
        deleted path reaches its importer.
      - The lead's other half, a file a config READS with `fs`, is
        documented as a limit in the config-imports module page, with the
        remedy (a JSON import is followed, or `workspaceFiles`): selecting
        every config the purity gate cannot vouch for on any unowned change
        would run them all on a README edit.
      - Rows: `affected.test.ts` › deleting an imported orphan, and an
        extensionless import's target, selects the importer. Both red
        without the fix.
959.  DONE (2026-09-27, the `--affected` review's lead 4). A deleted package
      (`git rm -r pkgs/lib`), or one dropped from the root `workspaces`,
      re-keyed and broke its dependents' builds while `--affected` said
      nothing affected: its paths map to no project now, and the
      dependents walk sees only today's graph. A committed root lockfile
      usually masked it.
      - Fix (`dependentsOfRemoved` in `affected.ts`): a `package.json` the
        base had and the tree lacks is read at the base for its name, and
        every project naming it in a dependency field is selected. A root
        `workspaces` edit selects every project. Only deleted manifests
        cost a `git show`.
      - Rows: `affected.test.ts` › a deleted package selects its dependent
        (an edited manifest its control), and a `workspaces` edit selects
        all (another root edit its control). Both red without the fix.
      - Left from the review: lead 1's second half, a file a plugin reads
        at run time (a seam).
960.  DONE (2026-09-27, the Next list's standing duty 6). Re-measured the
      warm run after the day's items 927–959, whose run-path changes were
      the config key (950, 952, 956: the import scan, the transpile seed)
      and selection (953–955, 958, 959, `--affected` only).
      - Method: base 25c8c27c (item 926) against head a84c84b1 (item 959),
        source runs, 1,000 projects, `run build --all` all-hit, one
        workspace copy per arm pre-warmed by that arm, interleaved, with an
        A/A control (head on a third copy).
      - n=25: base median 405.3 ms (min 342.4), head 398.9 (min 362.1),
        A/A 399.6 (min 354.2). A tie: the medians sit within 7 ms, and
        head and its A/A differ by 8 ms on the min. A first n=15 pass read
        base 389.8 against head 403.0, A/A 398.9, the same box noise.
      - Expected: the warm config path keys from the closure index, which
        none of the day's items touched; the transpile seed is three
        reads once per process.
961.  DONE (2026-09-27, the `--affected` review's lead 1, second half, its
      last). A root file a plugin's stages read without importing it
      (`turbo()`'s `turbo.json`, `nx()`'s `nx.json`) re-keyed every
      mapped task through the resolved configs while no project owns the
      path: `--affected` selected nothing, exit 0, and `vx watch` dropped
      the edit as a stray root file.
      - Seam: `VxPlugin.fingerprint` may now claim any bare root name, not
        only a lockfile core folds. For a name core folds nothing changes;
        for another nothing is taken out, `--affected` asks the claimant
        (claims load only when a ROOT name changed), and `vx watch`'s root
        arms treat it as they treat a lockfile. A path is refused (the
        root arm is not recursive); the refusal row and the schema table
        say so.
      - `turbo()` claims `turbo.json` and `turbo.jsonc`, `nx()` claims
        `nx.json` (both at the workspace root only), answering every
        project: which tasks an edit moved would take mapping both sides.
      - Rows: `affected.test.ts` › a claimed root file core does not fold is
        asked (an unclaimed README its control); `watch-rules.test.ts` › a
        claimed root file is an event, only at the root; vx-migrate
        `turbo.test.ts` › an edit to turbo.json selects every project
        through the real CLI, red with either half reverted; `nx.test.ts`
        › `nx()`'s claim. All red without the fix. The e2e row's own
        commit is asserted: its first cut committed nothing under the
        gate's sandbox and read as "HEAD did not resolve".
962.  DONE (2026-09-27, an exec review agent's lead 3 and a scheduler
      review agent's leads 2 and 3, one cause). A task was `aborted` only
      when its child died of SIGINT/SIGTERM, never because the run was
      stopping.
      - A task that traps the forwarded SIGINT and exits 0 (the reason vx
        forwards SIGINT) was a success: its partial outputs were cached
        under the healthy key, and the next run restored them.
      - One that exits 1 on the trap was RETRIED after Ctrl-C: two more
        attempts spawned, and vx left only at the handler's bound, with no
        summary and no teardown.
      - One SIGKILLed at the end of the grace read as a failure (the OOM
        hint).
      - Fix: `ExecuteArgs.stopSignal` carries the run's stop; an attempt
        that ends while it is aborted is `aborted`, before the retry
        decision. The child-signal rule stays (a `kill` vx never saw).
      - An aborted task's frame now prints where a frame would have: the
        trap's cleanup output was dropped with the count.
      - Rows: `signal-handling.test.ts` › a task that traps SIGINT and
        exits 0 is aborted, not cached; one with retries that exits 1 on
        SIGINT is not attempted again. Both red without the fix. The
        Ctrl-C output row now also expects the aborted section closing the
        summary.
      - Next from the exec review: 1 (a sandboxed task reads anything
        outside the workspace, unkeyed), 2 (the sandbox's shared TMPDIR
        persists across tasks and runs), 4 (a sandboxed task runs under
        bash, an unsandboxed one under sh), 5 (schema.md says the root's
        bin is not on PATH; it is). Not taken: 6, a task that SIGTERMs
        itself is `aborted`, a deliberate reading (`aborted-outcome.test.ts`).
      - Next from the scheduler review: 1 (a restore-tier hit releases its
        exec-tier dependents before its own dependencies finish).
963.  DONE (2026-09-27, the scheduler review's lead 1). A restore-tier hit
      (a confirmed local hit, run before its deps) released its dependents
      at its own finish. `q#check` → `p#build` (hit) → `p#deploy`: deploy
      started 300 ms before check ended, and when check FAILED deploy ran
      and reported success, under fail-fast too. The skip test read direct
      deps only, and the hit's `cache-hit` hid the failure behind it. The
      docs promised the opposite.
      - Fix (`scheduler.ts`): a restore-tier task that finishes before its
        deps holds its dependents until they settle; at release, a dep that
        failed, was skipped or aborted (or blocked a restore itself) marks
        it blocking, and its dependents are skipped naming the root. The
        hit stays a hit. `--continue=always` blocks nothing.
      - Rows: `scheduler.test.ts` › a restore-tier task's dependents wait
        for its own deps; a failed dep skips them, naming the root (the
        `always` run its control). Both red without the fix.
      - Warm path (the scheduler is on it): 1,000 projects all-hit,
        interleaved, n=21, one pre-warmed copy per arm: item 962's head
        min 363.0 ms (median 385.3), this head 361.6 (396.1), A/A 366.0
        (379.5). A tie; the medians spread 17 ms between identical arms.
964.  DONE (2026-09-27, the exec review's lead 4). Adding `exec.sandbox`
      switched a task's shell from `sh` to `bash`: the Linux wrapper ran
      `setsid bash -c <command>`. `echo x{1,2}` printed `x1 x2` sandboxed
      and `x{1,2}` unsandboxed on a dash box, `[[ … ]]` worked only
      sandboxed, and `echo 'a\tb'` differed, so a command green in the
      sandbox could fail unsandboxed or on a remote executor.
      - Fix (`ownGroupCommand`): `setsid sh -c`; with no `setsid`, the
        command is `exec sh -c` too, not the runtime's own shell.
      - Row: `sandbox-runtime.unsafe.test.ts` › a sandboxed task runs under
        the shell an unsandboxed one does (the same probe's output both
        ways, which holds where sh is bash too). Red without the fix.
965.  DONE (2026-09-27, the exec review's lead 2). A sandboxed task's
      `TMPDIR` was SRT's one host directory (`/tmp/claude`), bound
      read-write and kept across tasks and runs: a writer's `$TMPDIR/x`
      was a cached reader's undeclared input, and the reader replayed the
      first value after the writer changed it. No write grant was
      declared, yet the file persisted on the host.
      - Fix: each task gets `vx-task-<pid>-<tag>` under it, exported as
        `TMPDIR` after the command's tag, created before the spawn and
        removed with its bridges at the end (at exit too); a `kill -9`
        leaves it. A sweep of dead owners' directories by pid was built and
        dropped: the gate's nested vx, in another pid namespace, read the
        outer vx as dead and removed its task's `TMPDIR` mid-run (230
        shard rows red). The shared directory stays writable (SRT's policy): a
        command naming it outright still reaches it, recorded in the
        module page.
      - Rows: `sandbox-runtime.unsafe.test.ts` › a temp file one task wrote
        is gone for the next, and so is its directory (red without the
        fix); the tag row names the export after the tag.
966.  DONE (2026-09-27, the exec review's leads 1 and 5, docs). Two pages
      promised what the code does not do.
      - The sandbox's read wall is the WORKSPACE ROOT (`baseDenyRead:
[workspaceRoot]`): `sandbox: {}` read `$HOME/.gitconfig` and
        `/etc/hostname`, and a task that `cat`s a file outside the
        workspace replayed its old output after the file changed. schema.md
        said the baseline "reads nothing" and to "declare" `~/.cache` and
        `/etc`; the sandboxing guide and the sandbox post said the same.
        Each now says reads outside the workspace are open and fold into no
        key, and that such an input is declared as a key input. Walling
        `$HOME` was weighed and left: every tool reads its own cache there,
        this repo's sandboxed gate tasks included.
      - schema.md and execution.md said only the project's own
        `node_modules/.bin` is on PATH; `taskBinDirs` puts the workspace
        root's after it (since the gate needed it).
      - No code change, so no row; the docs laws hold the pages.
967.  DONE (2026-09-27, a `vx lock` review agent's lead 1). A cold run
      executed a different command, under a different key, from the warm
      run and `--frozen`. A first in-process config load returned the
      module object, which shares what the source shares (one preset task
      imported by two configs, one `exec` in two tasks); a `project` hook
      editing in place edited all of them: `echo P +plug +plug` cold,
      `echo P +plug` warm and frozen. Hits and the lock parse JSON, so only
      the cold path aliased, and `vx lock --check` (pre-stage) saw nothing.
      - Fix (`project-loader.ts`): the live path returns the parse of the
        JSON it already builds for the eval cache. About 1.7 ms per 1,000
        configs (1,000 parses, min of 20), on the live path only.
      - Row: `config-staleness.test.ts` › a config the project stage edits
        in place runs the command a warm run does. Red without the fix.
      - Next from the same review: 2 (`vx watch --frozen` does not re-run on
        a re-lock), 3 (comments and the 2026-06 design page still promise
        a staleness check `--frozen` does not make), 4 (the lock write is
        not atomic).
      - The review is done: its six leads are items 951, 953–955, 958,
        959 and 961.
968.  DONE (2026-09-27, a cache-prune review agent's lead 2). The orphan
      sweep unlinked every row-less `*.tar.zst` an hour old in `cacheDir`,
      and `cacheDir` is the user's to point anywhere: a `release.tar.zst`
      beside the index went with a run's `cacheRetention`, under a green
      run.
      - Fix (`cache.ts`): the sweep takes only `<16 hex>.tar.zst` and the
        temp `tempPath` makes of one. `cli.md` says so.
      - Row: `cache.test.ts` › the orphan sweep leaves a `*.tar.zst` vx
        did not name. Red without the fix. Fixtures that planted `h-*`
        orphans now use key-shaped names.
      - Next from the same review: 1 (`cacheRetention` takes a zero or
        bare-number bound), 3 (the run lock is keyed by the temp
        directory), and index rows whose artifact is gone still count
        toward the size bound.
969.  DONE (2026-09-27, the cache-prune review's lead 1). A
      `cacheRetention` of `{ olderThan: '0s' }`, `{ maxSize: '0' }` or
      `{ maxSize: '10' }` loaded and emptied the cache at the end of every
      run, the entries that run had just saved included, so nothing ever
      hit; `vx cache prune` refused all three.
      - Fix (`config-schema.ts`): the config refuses them too, by name; a
        bare number needs a unit (`10B` still loads). `schema.md` lists
        the three rows (pinned by `schema-doc-drift.test.ts`) and no
        longer says a run's own entries are never due: `maxSize` is
        least-recently-used first.
      - Row: `cache-retention.test.ts` › refuses the bounds that evict
        every entry after every run. Red without the fix.
970.  DONE (2026-09-27, the cache-prune review's lead 3; docs only). The
      run lock lives under the temp directory each process sees, so two
      shells with different `TMPDIR`s (a `nix develop` shell sets its
      own) held two locks: a prune evicted five entries while a run was
      inside its task. `caching.md`, `cli.md`, `orchestrator.md` and the
      `run-lock.ts` header said runs on one workspace take turns; they
      now say only under one `TMPDIR`, and why the lock stays there: under
      the workspace it would outlive a reboot, and off Linux an entry
      names no start time, so a reused pid would read as a live holder
      forever.
971.  DONE (2026-09-27, the `vx lock` review's lead 2). Under
      `vx watch --frozen` every cycle loads configs from `vx-lock.json`,
      and no watcher heard the lock: a re-lock ran the old configs until a
      restart.
      - Fix (`watch.ts`): under `--frozen` the lock is a root file the
        loop listens for, beside a plugin's claims, and its edit re-reads
        the watched set. `cli.md` says so.
      - Row: `watch-loop.test.ts` › under --frozen a re-lock re-runs. A
        config edit first starts a hit cycle that executes nothing; then
        `vx lock` must run the new command. Red without the fix (timed
        out waiting for the re-run).
972.  DONE (2026-09-27, the `vx lock` review's lead 4). `writeLockfile`
      truncated the lock in place, so a `--frozen` run reading it
      meanwhile, or `vx watch --frozen` woken by the write itself (item
      971), could read it empty and fail on "not valid JSON".
      - Fix (`lockfile.ts`): write a temp file beside the lock, then
        rename it over; a failed write removes the temp.
        `modules/lockfile.md` says so.
      - Rows (`lockfile-boundary.test.ts`): a name hard-linked to the old
        lock keeps the old bytes (red with a write in place); a rename
        onto a directory rejects and leaves no temp (red with the cleanup
        removed); a refused write names `vx-lock.json`, not its temp (CI's
        read-only-checkout row, skipped as root, caught the temp's name in
        the message; the cleanup's own ENOTDIR had also replaced the
        refusal, so it is best effort now). Each of the three is red
        with its line removed.
