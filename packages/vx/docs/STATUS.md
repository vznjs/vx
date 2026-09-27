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
934), so
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
    `docs/history/2026-09-improvement-loop-853-892.md` and 893–932 in
    `docs/history/2026-09-improvement-loop-893-932.md`. The loop above
    is the record since 933 (14dj in the next-log file); 14dk is below,
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
    Third hit (CI on #997), the same place; item 925 moved the file to
    the unsandboxed suite. This entry closes if no shard ends this way
    again.
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
