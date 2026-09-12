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
`docs/history/2026-09-review-arc.md` on 2026-09-10, and items 65–104
to `docs/history/2026-09-improvement-loop-65-104.md` on 2026-09-11, so
this file stays the handoff and not the log; numbering continues from
there. Keep it that way: when the loop below passes forty items, move
the oldest batch there in one commit.

## Improvement loop (2026-09-09, after the review pass merged)

Open-ended, owner-delegated: find flaws, widen seams, sharpen DX,
refactor toward cleaner layers. One coherent commit per step, gated,
recorded here as it lands. Layer map measured first (imports between
`src/<module>` directories): util ← workspace ← cache, exec ← graph ←
orchestrator ← cli, `config.ts` a leaf, no back edges — the boundaries
test is telling the truth.

105.  DONE (same night — the rest of the survey's first tier): path
      filters take a glob (`./packages/*`, `{apps/**}`), matched against
      the project's own root-relative dir as pnpm and Turbo do; a
      `--cache` spec naming a remote axis with no remote layer prints
      one line saying so; pins for the cycle message's path, an unknown
      `pkg#task` target, `--concurrency <n>%`, and `pkg#task` running
      under `--filter '!pkg'`; comparison rows for the bare-task
      cross-product vx does not do and the `parallelism: false` mapping
      (`exec.resources` reserving the whole budget). Deferred with
      reasons in the design note: implicit project edges, project
      selectors in `dependsOn`, a default base setting, `FORCE_COLOR`
      for children, a structured log stream, richer dry/summarize JSON.
106.  DONE (same night — the survey's second tier): a signal mid-run
      now escalates. SIGINT/SIGTERM SIGTERMs every live and persistent
      child, waits `VX_KILL_GRACE_MS` (2 s, shared with the persistent
      shutdown), SIGKILLs the survivors — the registries are re-read on
      the way out so a child the still-live scheduler spawned during the
      grace goes too — closes the cache and exits 130/143; a second
      signal skips the grace. Before, `process.exit` followed the
      SIGTERM at once and a child that trapped TERM (`trap '' TERM`,
      which `exec` preserves) outlived the run under init; the pin
      fails that way without the fix. And a task that shells out to
      `vx run` in its own workspace is refused: every child carries
      `VX_RUN_WORKSPACE` / `VX_RUN_TASK` (set over the isolated env in
      `taskEnv`, documented in schema.md) and `run()` throws a UserError
      naming the task when the root it resolved is the one running it —
      on the root, not the task, because a nested run that terminates
      (`ci` shelling out to `vx run lint`) is still a run the outer
      graph cannot see: its tasks escape the schedule, the concurrency
      budget and the cache key. A task driving another workspace (the
      control) is untouched. `tests/signal-handling.test.ts`,
      `tests/recursive-run.test.ts`, parity rows, `docs/cli.md` exit
      codes. Measured (interleaved, 7 reps, 100 projects, against a
      worktree at main 1c7a6a5): restore arm 186 → 180 ms median (min
      178 → 173), no-restore 129 → 126 (125 → 122) — no cost, as two
      env assignments on the miss path and one env read per run
      predict. The day's `run.ts 1000 5`: 2,642 / 227 / 916 ms
      no-cache / warm-no-restore / warm-restore against last night's
      2,488 / 227 / 1,049.
107.  DONE (2026-09-10, night — the 2026-07 parity doc's LOW rows,
      closed): L7 pinned — a NUL, `\r` progress rewrites and raw ANSI
      replay byte-identical from the SQLite row on a hit
      (`tests/replay-fidelity.test.ts`; bun:sqlite binds and reads
      TEXT with an explicit length, and nothing calls SQL `length()` on
      `stdout`). L4 fixed — `docs/caching.md`'s invalidation table sent
      `package.json`'s `workspaces` field to the fingerprint, which
      has never hashed it; the row now names the real mechanism
      (membership, step 1; the file per project, step 4) and
      `tests/caching-doc-drift.test.ts` pins the fingerprint
      enumeration and every step-3 row against
      `WORKSPACE_FINGERPRINT_FILES`. L2 pinned — `../packages/*` is
      refused loud naming the pattern; not made a path form, `./` being
      root-relative by documented choice. L1 (symlinks fold as the
      target string: code and doc already agree), L3 (root member
      affected) and L6 (prune racing a restore, orphan grace) were
      already true and pinned; the doc rows now say where. L5 (watch
      across a checkout) stays open with M7/M8 until the watch harness
      stops being flaky. M2 marked done with a `vx show`-in-a-task
      control added.
108.  DONE (2026-09-10, night — the survey's last candidate): scoped and
      whole-repo git enumeration are property-tested equal. A run that
      loads few projects lets git scan only their dirs (`gitPathspecs`);
      one that loads more, or declares `workspaceFiles`, scans the tree
      and partitions it — both feed the key, so a divergence would key
      one task two ways depending on which OTHER projects a run loaded.
      `tests/enumeration-equivalence.test.ts` draws twelve seeded trees
      (a clean, a modified, a deleted, a staged, an untracked, an
      ignored file and an untracked directory, in random mixes, across
      a project whose dir is a prefix of a sibling's, a nested project,
      a space and a non-ASCII name) and asserts, per partition, the two
      modes equal AND equal the plan's own expectation: every
      non-ignored file of the project and its nested projects, and
      trusted OIDs for exactly the clean tracked ones. Holds on every
      seed; the pin catches the prefix-bleed mutation (`dir` without
      its slash) on every seed too. No defect.
109.  DONE (2026-09-10, night — item 106's class, grepped): a run can be
      aborted from outside, and every SIGTERM vx sends escalates. A
      probe (`SIGTERM` to `vx watch` during its initial run) refuted
      the watch loop's contract — the handlers went in AFTER the
      initial run, so Bun's default exited 143 and the cycle's `sleep`
      lived on under init; mid-cycle the handlers resolved 0 over the
      same orphan. Fix as a seam, not a special case: `RunOptions.
signal` (an `AbortSignal`) runs the one teardown the process
      handler now shares — `terminateChildren` in `signals.ts`: SIGTERM,
      grace, re-read the registries, SIGKILL, reap — and the scheduler
      reads the signal so nothing further dispatches, every
      never-started task completing `aborted`; run() returns to its
      caller. `vx watch` installs its handlers before the initial run,
      aborts one controller on either signal, drains the cycle and
      resolves 0 (`tests/watch-signals.test.ts`, the probe made a pin;
      `tests/abort.test.ts` for the seam itself). Two more sites in the
      class: the persistent readiness timeout's SIGTERM now escalates
      like the run timeout's (a never-ready server is in no registry;
      `trap '' TERM` pin), and the foreground keep-alive waited for
      EVERY requested server with a dead SIGTERM loop after it — now
      the first exit ends the session, the others are torn down and a
      non-zero exit fails the run (`tests/keep-alive.test.ts`, both
      exit codes; the old code hangs it 20 s). Docs: cli (watch exit
      codes, the foreground rule), execution, modules/signals,
      cli-watch, orchestrator, options, scheduler, runner.
110.  DONE (2026-09-10, night — the watch loop end to end, and a
      regression it found): `tests/watch-loop.test.ts` pins the loop on
      markers, not sleeps — "watching" means every watcher proved
      delivery, an execution count kept OUTSIDE the workspace says what
      actually ran — for the three claims the 2026-07 doc left unpinned:
      an edit re-runs exactly once, the same bytes written again cost
      no cycle and no execution (M8), a `git checkout` rewriting twenty
      inputs is one cycle with the new content (L5). The first claim
      was false: every edit cost TWO cycles, the second labelled `dist`
      and reporting up-to-date, since item 99's clean prunes an emptied
      `dist` and the task re-creates it — a change to `dist` itself,
      which `dist/**` never matched. `makeWatchIgnore` now also drops
      the directory holding an output tree and its ancestors
      (`outputContainer`: `dist` for `dist/**`, `build/out` and `build`
      for `build/out/*.js`, nothing for `*.js`), and treats a literal
      entry as its tree like the resolver does (item 102 had not
      reached the watch side: a literal `gen`'s files counted as
      edits). Unit pins in `tests/watch-rules.test.ts`; the e2e fails
      with two cycles without the fix, three runs in a row green with
      it. M7 (an edit during the initial run is dropped) stays as
      documented, deliberately.
111.  DONE (2026-09-10, late night): the foreground keep-alive's
      ending is said, not just coded — `vx: app#dev exited with code
1; stopping 1 other persistent task` on the status stream before
      the teardown, since the summary above had already reported the
      server `success` and an exit 1 with no word about why is a
      mystery in a CI log. Pinned in `tests/keep-alive.test.ts` on
      both exit codes. PR #276 (106–110) merged at 18:38Z, main
      fb97a97; 111 merged as PR #277 at 18:43Z, main 7878582.
112.  DONE (2026-09-10, late night — a stale hit, found by a probe): an
      input written `./src/**` folded ZERO files. The resolver matches
      globs against git's enumeration (`src/a.ts`), and `Bun.Glob`
      fed the literal `./` matches nothing, so the key never moved
      with the source and an edit under it replayed the old outputs
      as a green hit; outputs took the same spelling through a scan,
      which tolerates `./`, and worked — the asymmetry hid it. Fix at
      the one funnel every glob passes (`asTrees`): `normalizeGlob`
      strips every leading `./` after an optional `!`, and the
      unmatched-literal guard sees the same normalized names; the
      schema refuses an entry that is only `.` / `./` (it names the
      directory itself and selected nothing, silently) in
      `inputs.files`, `outputs.files` and both `workspaceFiles`; the
      watch loop's `outputContainer` normalizes too. A key-derivation
      fix whose old key was already wrong: self-healing, no
      `CACHE_VERSION` bump. `tests/dot-slash-globs.test.ts` (the
      probe: fails with a hit without the fix; `!./gen/**`; the
      outputs control; three refusals), `tests/watch-rules.test.ts`.
      `./packages/*` in the workspace file already discovered
      projects (probed). Also this commit: the watch loop reuses the
      resolver's `asTrees` instead of its own copy of the
      literal-tree rule. Probed the rest of the class one spelling at
      a time against `Bun.Glob` and folded the silent ones into the
      same normalization: an inner `/./` segment, a doubled `//`, and
      a trailing `/` on a PATTERN (`src/*/` is the trees under `src`,
      so `src/*/**`; a literal's trailing slash stays `asTrees`' job).
      `src\a.ts` stays nothing — Windows is WSL.
      The rule then moved to `util/paths.ts` and found its other
      readers: workspace member globs (`!./packages/legacy` and
      `!packages//legacy` excluded nothing — `legacy` stayed a member,
      pinned in `tests/workspace.test.ts`, fails without),
      `wholeSubtreePrefixes` (a `./dist/**` output lost the dir-mtime
      short-circuit), and the watch loop's `outputContainer`, which is
      now `staticPrefix` over the normalized glob instead of a second
      copy of the prefix rule. `staticPrefix` itself learned that a
      brace set is a wildcard: `{dist,build}/**` read as the literal
      directory `{dist,build}` gave the sandbox baseline a prefix that
      exists nowhere (pinned in `tests/util-paths.test.ts`).
113.  DONE (2026-09-10, late night — the survey's open question,
      decided as owner): `--filter '...app'` follows cross-project
      `dependsOn` edges. An `e2e` whose `test` declares `dependsOn:
['app#build']` and no manifest dependency was invisible to the
      dependents walk, so a CI running "what changed and everything
      depending on it" silently left it out — the flagship use case
      under-tested. No new field (Nx's `implicitDependencies` stays
      unspelled): the task graph already knows the edge, so the
      selector reads it from the staged configs (`taskEdges` in
      `cli/select.ts`, only when a filter walks the graph) and
      `buildPackageGraph` merges it into `directDeps` — `^task` walks
      and `...` / `^...` agree. `tests/filter.test.ts` (unit, a ghost
      target and a self edge are nothing) and
      `tests/task-edge-selection.test.ts` (e2e: `...lib` runs
      `e2e#test`; `e2e^...` reaches app and lib; a plain name is
      unchanged), both failing without. Rejected in the same breath: a
      workspace default base for `--affected` — one flag in CI, and
      `origin/HEAD` covers the rest.
114.  DONE (2026-09-10, late night — owner's ask: "clone solid, put vx
      on it with turbo, how much faster, cold and restore"): the first
      real-repo head-to-head. `solidjs/solid` (b25c557, 5 packages,
      pnpm 9, Turbo 2.10.10, Node 22) with a two-line
      `vx.workspace.mjs` (`plugins: [turbo()]`) over the repo's own
      turbo.json; same executed graph both sides (4 `build` tasks, 7
      for `test test-types`; the dry runs compared), the identical 64
      output files restored by both. Interleaved, compiled vx, Turbo
      without its daemon, this four-core box: `build` cold 40.6 s vs
      45.5 s, restore 66 ms vs 127 ms, no-op 51 ms vs 95 ms; `test
test-types` cold 53.6 s vs 58.2 s, restore 80 ms vs 166 ms,
      no-op 59 ms vs 93 ms. Warm rows 1.6–2.1× in vx's favour; the
      cold rows are the toolchain, with a 4–5 s (9–12%) gap that is
      Turbo's per-task work around the same commands — observed, not
      root-caused. `packages/vx-bench/real/turbo-repo.sh` reproduces
      it on any Turbo repo; `docs/benchmarks.md` § A real Turbo repo.
      The mapper found nothing to fix on this repo: `pkg#task` keys,
      cross-package `dependsOn`, `**/dist/**` outputs all mapped; the
      only warnings are `outputLogs: "new-only"`, which has no vx
      spelling.
115.  DONE (2026-09-10, night — owner's ask: a blog section for the
      announcement articles): the site has a blog at `/blog/` (RSS at
      `/blog/rss.xml`, authors, tags, pagination) — `starlight-blog`
      0.29 on the same Starlight, reason recorded in
      `astro.config.mjs`; posts are tracked Markdown under
      `packages/vx-docs/src/content/docs/blog/`, the how-to (frontmatter,
      relative links, drafts) is in `packages/vx-docs/README.md`, and
      `hello-vx.md` is the first post. One trap on the way: the
      plugin's Markdown engine (`satteri`) loads a native binding at
      runtime, and bundled into a prerender chunk under `dist/` it had
      nowhere to resolve from in Bun's isolated layout (the same class
      as In-flight 1's astro dependency) — kept `ssr.external` and
      declared by the site so it loads from its real path in the store.
116.  DONE (2026-09-10, night — README, site and the repo for launch):
      the README's benchmark sentence was hand-typed and had drifted
      (559 ms where the committed run says 510); it is now a block
      `update-site.ts` renders from `results.json` between `bench`
      markers and `check.site` guards, plus one sentence on the real
      Turbo repo (item 114) that points at the tables; the landing
      page's benchmark note gained the same sentence. Every "Edit page"
      link on the site was a 404: `editLink.baseUrl` named a `docs/`
      path that exists nowhere, for imported and hand-authored pages
      alike — imported pages now carry their own `editUrl` to
      `packages/vx/docs/<file>` (written by `import-docs.ts`), the base
      serves the hand-authored ones (Starlight appends the content
      path), verified in the built HTML for all three page kinds.
      `LICENSE` said "nxt contributors" — the project's old name.
      `SECURITY.md` (private reporting, what is in scope) and
      `CONTRIBUTING.md` (the gate, the pin rule, the number rule)
      added at the root. CI then refused the README read: `check.site`
      runs sandboxed and its allow-list named the two sibling files but
      not the root README — declared as a read and a `workspaceFiles`
      input (the same shape as the other two; this container cannot
      host the sandbox, CI is the proof).
117.  DONE (2026-09-10, night — perf, from the real-repo stage table):
      a hit on a task with no declared outputs extracted its logs-only
      artifact anyway — an `exists` and a tar read per hit for nothing
      (1.7 ms each on solid's `link` and `element`, `VX_TIMING`); its
      stdout replays from the row. `restoreHit` now skips clean and
      restore when nothing is declared (`tests/no-output-hit.test.ts`,
      fails without; the control with outputs still extracts).
      Measured on solid, seven interleaved no-op runs against the
      previous binary: 53 → 52 ms median, 49 → 46 min — at the noise
      floor, as 3.4 ms of 51 predicts.

118.  DONE (2026-09-10, night — owner's ask: "20+ blog posts about
      technicals, what vx is, why it is fast, its methodologies and
      values, migration, no choice on the market, the mechanics"):
      thirty posts under `packages/vx-docs/src/content/docs/blog/`,
      every claim taken from the docs and verified against source
      where the docs were silent (three drafts were corrected on the
      way: output overlap is refused only when provable, a clean-filter
      path loses its index OID rather than trusting it, the purity gate
      denies globals not `Math.random`). Series: what vx is · why fast ·
      keys from git · resolved-config hashing · strict output ownership
      · no daemon · pipeline with seams · the local floor · cascade
      through inputs · `vx why` · explicit over magical · the sandbox ·
      lockfile-aware keys · dev servers in the graph · Ctrl-C · watch ·
      bitsets and the scheduler · no choice on the market · from
      Turborepo · from Nx · honest benchmarks · remote execution ·
      agents and MCP · values · one binary · config in TypeScript ·
      `vx lock` · telemetry never breaks a run · one command per task ·
      flaky tasks. All dated today and published (not `draft: true`);
      the owner re-dates or drafts them to stage an announcement
      cadence. Built with the site (all thirty render; every relative
      link resolved in the built HTML), site tests pass. The index
      tie-broke same-day posts by title, so a reader landed on the
      lockfile post first: each post now carries a time on the same
      day in reading order (`what-vx-is` at 23:59, one minute less per
      post; the page shows only the day), pinned in the site README.

119.  DONE (2026-09-10, late night — bug hunt, from a probe of `vx
watch` on a Turbo-plugin workspace): with any
      `inputs.workspaceFiles` declared — every Turbo `globalDependencies`
      maps to one, so most Turbo repos — the loop runs on ONE recursive
      root watcher that triggered on EVERY write in the tree. The probe
      redirected its own output to a log inside the repo and the loop
      never settled: each cycle grew the log, the log was an event, the
      event was a cycle (eight cycles in six seconds, all hits). A
      coverage run or an editor scratch file at the root cost a cycle
      each the same way. Without `workspaceFiles` the root watcher was
      already filtered (fingerprint names only) and a root file was
      not an event — the recursive arm just never got the same rule.
      `makeRootEventFilter` keeps the three kinds of path a key can
      see (inside a project dir, a fingerprint file at the root, a
      declared `workspaceFiles` glob; `!` patterns not consulted) and
      drops the rest before the trigger; `sweepConfigs` now hands the
      loop the declared globs. Pinned as a table in
      `tests/watch-rules.test.ts` and end to end in
      `tests/watch-loop.test.ts` (a root `build.log` and a
      `coverage/lcov.info` are no cycle, the declared root file is
      one; with the filter removed from the arm the log write is a
      cycle — Expected 0, Received 1). Left open, pre-existing and now
      visible: the per-project arm watches only the projects in the
      run's scope, so an edit to an upstream dependency outside
      `--filter` is not a cycle there, while the root arm accepts any
      project's dir (Next 13).

120.  DONE (2026-09-10, late night — Next 13, the gap item 119 made
      visible): `vx watch build --filter app` watched `app` only, so an
      edit to `lib` — which every cycle rebuilt for `app#build`'s
      `^build` — was never an event; the loop printed "watching 1
      project(s)" and sat there. `watchedProjects` is now one rule for
      both arms: the scope plus its transitive dependencies through
      `buildPackageGraph` with the cross-project `dependsOn` edges
      `taskEdges` (now exported from `select.ts`) collects — the closure
      `--filter 'app...'` walks. A whole-workspace scope walks nothing.
      Pinned e2e in `tests/watch-loop.test.ts`: two projects, `--filter
app`, "watching 2 project(s)", a `lib/src` edit is one cycle that
      re-executes `lib#build` and `app#build`; with the closure removed
      the marker never appears (timed out at "both projects watched").

121.  DONE (2026-09-10, late night — owner: "the website should really
      put focus on cold run metrics … imagine your tasks take 3 min and
      tooling doubles that or 10×; vx just adds a few %"): the site,
      the README and the benchmarks doc now lead with the runner's
      overhead over the ideal schedule, rendered from `results.json` by
      `update-site.ts` so it cannot drift (`over()`: under 2× a
      percentage over the schedule, above it a multiple): on the
      3,270-task graph the tasks alone take 3m 38s; vx 3m 46s (+4%),
      Turborepo 5m 13s (+44%), Nx 34m 44s (9.6×). The hero's first
      tile is that 4% with the other two in its subline (the "7.0×
      faster warm runs vs Nx" tile gave way; the ratio stays in the
      note); the benchmark section's heading is "Your tasks, plus a few
      percent." and its note opens with the three wall times; the
      README's generated block opens the same way; the benchmarks doc's
      overhead sentence carries all three. Hand-written copy followed:
      the why-fast concept page's first bullet, the honest-benchmarks
      post (a cold-build column in its table) and the why-fast post's
      opening. `check.site` guards the three generated files as before.

122.  DONE (2026-09-10, late night — bug hunt on solid with
      `@vzn/vx-lockfile`): the lockfile claims held end to end (a
      whitespace edit to `pnpm-lock.yaml` is four hits; an integrity
      bump on `component-register`, which only `solid-element` reaches,
      is one miss, `vx why` names `plugin @vzn/vx-lockfile/pnpm`, and
      `--affected --exclude-dependencies` selects that one task) — and
      the probe showed every `@vzn/vx-turbo` warning printed TWICE under
      `--affected` with a diff and under `--filter 'solid-element...'`,
      once under `--filter solid-element`. Root cause: a filter that
      walks the graph stages every config in `resolveFilters` →
      `taskEdges` to read the `pkg#task` edges, and the run loaded them
      all again — the `project` stage's cost paid twice per run, its
      warnings doubled. The selection load now travels into the run
      (`RunOptions.staged`; `loadProjects` takes a staged entry as is,
      seeding and scoping unchanged) and `vx watch` hands its sweep's
      load to the watched-set walk while deleting `staged` from the
      options a cycle re-runs. Pinned in `tests/staged-once.test.ts`
      with a counting `project` plugin: a graph-walking filter stages
      each config once (differential: not handing the load on, each
      twice); a plain scope once (control); a watch start is four stage
      calls, not six, and the cycle after an edit stages live (six).
      The second half, found when solid still doubled under
      `--affected` after the first fix: a changed root file is an
      orphan path even when a plugin claims it, and the owners walk
      (`workspaceGlobOwners`, which project's `workspaceFiles` glob
      covers it) staged every config on its own. `resolveFilters` now
      has ONE memoized load that the edge walk, the owners walk and the
      run all read (pinned: `--affected=HEAD` with an orphan root file
      and a `lib` edit stages each config once; differential, the owners
      walk loading for itself: twice). On solid, `--affected --dry`
      with a lockfile diff prints each Turbo warning once.

123.  DONE (2026-09-10, late night — bug hunt, `vx watch` on solid): an
      edit to `solid-element/src` cost three cycles, and the small
      repro of the shape was worse — an UNCACHED task that deletes and
      recreates its output (`rm -rf dist && tsc`, most build scripts
      with no `outputs` declared) looped forever: 780 executions in two
      minutes from one edit, where the docs promised one redundant
      cycle. Two holes in the content gate: a deletion and a directory
      passed unconditionally, and the debounce judged paths mid-run, so
      a `dist` deleted and not yet rebuilt was "a change" every cycle
      (with a gap, absent/present alternated forever). Now a path is
      judged on its SETTLED state — a file's bytes, a directory's entry
      names and sizes, absence — and never while a cycle runs: what
      lands mid-run waits and is judged together one window after the
      run, under the label of what actually arrived (the follower used
      to carry the first cycle's label). Pinned in
      `tests/watch-loop.test.ts` for the shape with and without a gap:
      one edit is exactly three executions and two cycles, the follower
      labelled `app dist`; differential, a directory passing the gate:
      executions climb past three. On solid the same edit is two
      cycles. Refuted the same night: a persistent task under `vx
watch` (a `readyWhen`-gated dependent, two edits, then Ctrl-C)
      spawns one server per cycle with the previous one dead before the
      next starts, and none survive the stop — nothing to fix there.

124.  DONE (2026-09-10, late night — DX, from every solid run): the Turbo
      mapper warned `turbo key "outputLogs" ("new-only") has no vx
equivalent — map it manually` on every run, for the value every
      Vercel template carries. `new-only` — frames for the tasks that
      ran, a one-liner per cache hit — is vx's default flow already, so
      it now maps to nothing and warns about nothing; the other values
      (`full`, `hash-only`, `errors-only`, `none`) have no per-task knob
      in vx, so their todo names the run flag (`--output-logs
<mode>`), and an unknown value names the four. Pinned in
      `packages/vx-turbo/tests/turbo.test.ts`; the README and the
      Turbo migration table carry the row. Also refuted the same night,
      on solid: `vx lock` on a plugin-filled workspace locks 0 projects
      and `--frozen` derives the same four keys as live; `vx last`,
      `vx info`, `vx why` disambiguation, `--report=markdown` and
      `--summarize` all read right; and the warm no-op's largest span,
      `output glob` at 10 ms for the two `**/dist/**`-shaped tasks, is
      wall time across four concurrently classified tasks — called
      directly, `resolveOutputs` is 0.9 and 1.0 ms — so there is no
      restore-side lead in the globstar idiom.

125.  DONE (2026-09-10, late night — owner: "make the landing page a
      visual masterpiece … a tool from the future, cinematic, bending
      time and space, crushing competitors, really good visual
      effects", then "I asked for complete cinematic breath taking
      redesign … not just improved design"): the landing page rewritten
      from scratch as a scroll-driven film. The first delivery layered
      effects over the old page and was rejected; the second is a new
      `index.astro` and `landing.css`. Five pinned scenes, each
      `section.scene.pin` `--len` viewports tall with a sticky stage
      the script scrubs by a scroll progress `--p`: the cold open (a
      warp field of streaks toward the viewer, `vx run build --all`
      typing itself, "Bend time. / Not the rules." rising in), the
      clocks (three runners on one orbit at real cold-build times, ×60
      then ×600 after vx and Turbo finish, captions at T+3:46, T+5:13,
      T+34:44, the HUD reading the lap and the rate), the wall (the
      three overheads as monoliths that rotate with the scroll, vx +8 s,
      Turbo +1m 35s, Nx clipped "off the chart · 9.6×"), the warm replay
      (510 ms over a diagonal dot sweep, the three stat tiles beneath
      it), and "One binary." (daemon, cloud, walled features, rewrite
      struck through with a glitch, the line blurring in); then the
      flowing sections — the cards, the ten-stage pipeline rail with a
      pulse, the live terminal and config, the proof panel with bars
      and ratio badges — and the outro ("Warp in.", the install pill,
      the migrate CTA). Every number is still server-rendered from
      `results.json` and every generator hook intact (`check.site`
      passes: the stat tiles, the bench data block and the note
      paragraphs are what `update-site.ts` rewrites; the clocks and the
      wall read the same `over()` constants, so a re-benchmark reshapes
      every scene). No dependency; one `<script>`; the DOM reads
      complete without it; `prefers-reduced-motion` unpins every scene
      and holds each on its final frame. Verified in a real Chromium
      (playwright-core in the session scratchpad, never in the repo):
      every scene captured at several progresses at 1440 and at 390,
      `scrollWidth` equal to the viewport at both. Two fixes found by
      looking: the warm dot grid covered only the top of the stage and
      fought the number (a full-bleed sweep under a dark backdrop now,
      widened on a phone where the copy is centred), and the Nx
      monolith's "off the chart" label sat inside the clip mask that
      cuts the tower (the label lives outside the mask).

126.  DONE (2026-09-10, late night — the `project` stage names the
      workspace): `ProjectHookContext.projects` is every package core
      discovered — config file or not, in the scope or out of it — as
      the one array every visit of a run receives. `@vzn/vx-turbo` was
      walking the workspace a second time inside the stage
      (`loadWorkspace` + `listProjectMetas` on the first visit) because
      the context named only the package being visited, and Turbo's
      `dependsOn` is only valid against every package's scripts at
      once; it reads the array now and imports neither. Interleaved
      A/B, six rounds, the 1,000-project bench under `turbo()` (each
      package with its own `vx.config.mjs`, so every fill is a no-op
      and the mapping's cost is all that differs), the old plugin from
      an immutable copy: `load configs` 52.8 min / 55 median → 41.2 /
      43 ms, the warm run ~200 → ~190. What is left of the stage's
      cost under the plugin (41 ms against 22 without it) is the
      1,000 per-package `turbo.json` probes, the mapping and the clone
      per fill; probing the overlays in flight at once instead of one
      await per package was measured (41.4–45.4 against 41.2–47.8 ms,
      six rounds) and does nothing — `Bun.file().exists()` on a
      warm inode is microseconds — so it is not in. Pinned twice:
      core, a `project` plugin visiting `a` under `projects: ['a']`
      lists `b` (no config, out of scope) in `ctx.projects`; the
      plugin, its `project` hook called with a context whose
      `projects` names a package that is not on disk maps it (the old
      plugin's re-discovery could not have seen it). Both fail without
      the change. Recorded on the way: a cold `vx run build --all` on
      solid (`VX_TIMING=1`, the compiled binary) spends 57 ms before
      the graph and 32 ms across its four saves inside 37.7 s of
      tasks — the miss path is at its floor there, nothing to take.

127.  DONE (2026-09-10, late night — found by item 126's seam): under
      `vx watch`, a `package.json` script edit in a Turbo-mapped package
      re-ran the task (the bytes are in the key) on the OLD command.
      The workspace module is imported keyed on its bytes, so one
      process reuses it across runs and the plugin instance with it,
      and `@vzn/vx-turbo` memoized its mapping for the instance's
      life — right for one run, stale for every cycle after an edit;
      the same for a `turbo.json` edit. Probed end to end (a watch on
      a one-package Turbo workspace, the script switched from writing
      `v1` to `v2`: the cycle ran, `dist/out` still read `v1`), fixed
      by keying the memo on `ctx.projects` — one array per run, so its
      identity is the run's, which the context now documents — and
      the probe reads `v2`. Pinned in the plugin's suite as two
      `planRun`s in one process with the script edited between
      (`echo lib-v2` is the second plan's command); fails without the
      change. The README says it: the mapping is read once per run,
      never once per process.

128.  DONE (2026-09-10, late night — found reading the watch arms for
      item 127): an edit to `vx.workspace.*` under `vx watch` was no
      event. The non-recursive root arm listened for fingerprint files
      only and the recursive one (`makeRootEventFilter`) for project
      trees, fingerprint files and `workspaceFiles` globs — the
      workspace config is no task's input, so nothing named it, while
      it shapes every cycle (plugins, the `config` stage, concurrency,
      the cache dir) and a cycle re-evaluates it for free (its import
      is keyed on its bytes). A plugin added under a running watch
      waited for a restart while the loop looked alive. Both arms take
      `WORKSPACE_CONFIG_FILENAMES` at the root now (exported from the
      workspace module; a name below the root is not it). Pinned: the
      filter table (`vx.workspace.ts` kept, `nested/vx.workspace.ts`
      dropped) and end to end — the workspace file rewritten under a
      running watch with a `config` plugin that warns a marker; the
      cycle prints it, is one cycle, and executes nothing (the config
      is not key material). Both fail without the change. What is
      still no event at the root: a `project` plugin's own source
      (`turbo.json` for `@vzn/vx-turbo` — a per-package overlay lives
      in a project dir and is; a root edit needs a restart). No seam
      names a plugin's root files, and inventing one for one consumer
      is the special case the seams exist to avoid; a second consumer
      makes it a seam.

129.  DONE (2026-09-10, late night — the zero-migration stage, timed by
      piece): a config-less 1,000-package Turbo workspace (scripts in
      every `package.json`, no `vx.config`, `bench1000-bare` in the
      scratchpad) loads in 42 ms under `turbo()` where 1,000 cached
      config evaluations take 22, and the run is otherwise the same
      ~200 ms. The pieces, in one process: the first visit's mapping
      9–18 ms (the 1,000 overlay probes and the mapper's 3–7 ms
      warm), the 999 other visits 10–22 ms, the 1,000 re-validations
      2–3. Each visit looked its package up with `Array.find` over the
      mapping — a million comparisons per run at this size, and the
      square of it at any other — so the mapping is indexed by name
      once per run: the visits read 8.8–11.8 ms after. At the run
      level the interleaved A/B (six rounds, the linear-scan plugin
      from an immutable copy) ties inside the box's jitter:
      `load configs` 41.2 min / 44.9 median → 41.8 / 44.0 ms. Kept for
      the shape, not the number, and the number is recorded as a tie. What
      is left is the overlay probes (sequential or in flight, the same
      — item 126), two `structuredClone`s per fill and core's
      per-plugin re-validation; none is a lever at this size.

130.  DONE (2026-09-10, late night — probed after item 128): a package
      added while `vx watch` runs. The watched set was fixed when the
      loop armed: the new directory was no event (the per-project arms
      never saw it, the root arm is non-recursive), the next cycle any
      other edit caused ran the new package (a run re-discovers), and
      every edit inside it after that was silence. Now the directory
      each `<dir>/*` package glob names (`memberBaseDirs`, exported by
      the workspace module — `packages/` for `packages/*`) has one
      non-recursive watcher: a member coming or going there is a cycle,
      and that cycle's end re-reads the workspace (`rediscover`:
      discovery, the sweep, the watched closure under the scope
      resolved at start) and `rearm`s — new project dirs get an arm
      that proves delivery before the loop goes on, dropped ones are
      closed by slot (an OS watcher that never proved delivery is a
      poller in its slot), and the root filter and the ignore filter
      are rebuilt on the new set. Pinned end to end: `packages/b`
      added under a running `--all` watch is a cycle that executes it,
      the loop reports two projects watched, and an edit in `b/src` is
      a cycle that rebuilds it; fails without the change. Not done, by
      choice: a glob of another shape (`apps/**`) has no such
      directory and a package added under it waits for a restart; and
      the watcher shape is not re-decided — a new package declaring
      the first `workspaceFiles` input keeps the per-project arms until
      a restart. Both in the docs. CI's macOS job then failed the
      uncached-task pin (PR #297, a docs-only head): on macOS a
      non-recursive watcher on `packages/` also reports a member whose
      CONTENTS changed — FSEvents names the directory a write landed
      in — so the arm's own probe file and a task's write into its
      project read as a member event and cost the uncached task one
      execution per cycle; Linux's inotify never reports a child's
      contents on the parent, so the container could not see it. The
      watcher reacts only when the member SET changes now
      (`memberEntries`: directories and links, not dotted, not
      `node_modules` — discovery's rule), pinned in
      `tests/watch-rules.test.ts`. The next macOS run failed the
      neighbouring uncached pin the same way (one execution before any
      edit, the deletes-and-recreates test this time) with the set
      check in place, so the member watcher was not the whole story —
      three earlier macOS runs with it had passed, which makes this an
      intermittent extra cycle right after the arms go live, on an
      uncached task only (a cached one would hit and show nothing).
      Unproven candidate: an FSEvents item event for the watched
      directory ITSELF (its mtime moves when the probe or the task's
      write lands in it), which arrives as an empty relative name and
      passed every filter into the judge, where a directory's first
      sighting is a change. `armWatcher` drops an event whose name is
      empty or `.` now — nothing a key can see is named by it — and
      the six initial-run assertions in `tests/watch-loop.test.ts`
      throw with the watch's own output on a miss, so the next failure
      names the label that re-ran instead of a count. It did
      (2026-09-11, a docs-only head): `app dist; re-running...`
      right after "watching", with nothing written
      after the initial run — the per-project arm delivered the
      INITIAL RUN's own `dist` write after it went live (FSEvents
      hands a new stream what landed just before it started), and a
      path the loop had never judged passed the settled-state gate
      unconditionally. The gate reads the path's mtime against the
      instant the watchers went live now: a first sighting last
      modified before it is the initial run's, not an edit; after it,
      a change; a path already gone stays a change (a deletion has no
      date). `modifiedBefore` is pinned in `tests/watch-rules.test.ts`;
      the e2e proof is CI's macOS job. Linux never showed it: inotify
      delivers nothing from before the watch.

131.  DONE (2026-09-10, late night — owner: "Remove no node no bun — no
      one cares. Warm run is also minor. Focus on overhead, flexibility,
      plugins, openness, no paywalls, performance and modularity,
      compatibility, test coverage, correctness, sandboxing etc.,
      differentiators. And use the same unit — not 44% then 9.6×. Also
      don't focus on 4%: I don't want people to think this scales; the
      overhead is on a very big example. Focus on how vx scales with
      the codebase and that it does its job in seconds, not minutes"):
      the film reframed. One unit for every runner everywhere the
      three overheads appear — clock time over the ideal schedule,
      `+0:08` / `+1:35` / `+31:06` — and the per-package figure (8 ms /
      88 ms / 1,712 ms, the same overhead over 1,090 packages) as the
      scaling number; no percentage, no multiple, on the site, in the
      README's bench block, in `benchmarks.md`, in the two posts and
      the concept page that quoted them. The generator prints both
      (`plus`, `perPkg`; `over`/`overPct` gone) and its three stat
      tiles are now the per-package tiles, one per runner, in the
      runner's lane colour. Scenes: the open lede ("adds seconds where
      others add minutes"), the wall's plates in `+m:ss` with the
      per-package line, the warm scene replaced by the scale scene
      (3,270 tasks counted over the dot sweep, "grow the graph and the
      runner grows in milliseconds per package"), the strikes gained
      "No paywall." and the line under them is "Open, all the way
      down." (MIT, open protocols, every seam a hook) with the
      Node/Bun sentence gone, the cards rewritten to the nine
      differentiators the owner named (overhead at any size,
      sandboxing, a plugin at every stage, open with no paywall,
      correct by construction, compatible, modular, 2,700+ tests, a
      cache you can interrogate), the proof panel titled "Seconds, not
      minutes." with the cold row's badges in `+m:ss` and the
      multiples gone. The warm number stays as one clause in the note
      and one line in the README. `update-site.ts --check` passes on
      the regenerated site.

132.  DONE (2026-09-10, late night — the scaling claim gets a table):
      the site says the runner grows with the graph in milliseconds
      per package; `benchmarks.md` now shows it at three sizes. vx
      alone, the generator's shape, one trivial `build` per package,
      the compiled Linux binary at 1a35ec3, `run.ts` medians of 3 on
      this 4-core container: 100 / 300 / 1,000 packages cold 310 /
      762 / 2,091 ms (3.1 → 2.5 → 2.1 ms per package), warm 56 / 100 /
      178 ms (0.56 → 0.33 → 0.18), restore 126 / 269 / 808 ms (1.26 →
      0.90 → 0.81). Ten times the packages is 6.7× the cold time and
      3.2× the warm: sub-linear, the fixed cost amortized, nothing
      growing faster than the graph. The source form read 338 / 794 ms
      cold at 100 / 300 — the ~40 ms transpile the binary does not pay,
      as the harness's header says. The head-to-head per-package
      figures on the site stay the owner's committed run.

133.  DONE (2026-09-11 — owner: "The website looks bad. It's laggy,
      too complex, tons of visual bugs, inconsistent"): the film is
      gone; the landing page is static. No canvases (the warp field,
      the orbit, the dot grid), no pinned scroll-scrubbed scenes, no
      grain or vignette overlays, no card tilt, no reveals, no
      typewriter, no glitch — one script, for the install command's
      copy button. `document.getAnimations()` is 0 and the page has
      no `<canvas>`; a real Chromium loads it in ~120 ms at 1440 and
      ~50 at 390, no horizontal overflow at either. What stays is the
      message the owner set on 09-10 (one unit, the per-package
      scaling number, the differentiators, "Open. All of it.") in
      one visual language: the benchmark panel's bar draws the
      overhead chart, the stat tile is the one primitive, two display
      sizes, hover states only. Sections: hero with the terminal
      (static rows), the overhead chart with the three per-package
      tiles, the four "no"s, the nine cards, the pipeline rail with
      the platform cards, the config card, the benchmark panel, the
      migrate call to action, the footer. The generator's regions are
      unchanged and `update-site.ts --check` passes; the stylesheet
      went from 1,759 to 1,167 lines and the page from 1,152 to 714.

134.  DONE (2026-09-11 — owner: "Make sure things are consistent: if
      the same layout is repeated it's exactly the same, no extra
      info, no text. Don't focus on seconds-not-minutes, focus on we
      are always the fastest no matter what. Too much small text. Add
      refs to docs to every point"): three primitives, each identical
      everywhere — the section head (kicker, `h2`, one line), the
      card (icon, title, two sentences, "Docs →"), the benchmark panel
      (legend, rows, every competitor a multiple of vx, vx's own row
      "fastest"). The message is "The fastest task runner. In every
      row.": the panel gains the overhead row (what each runner adds
      over the ideal schedule, so Turborepo reads 11× vx and Nx 221×)
      above cold, cached, restore and CPU; the same panel repeats for
      solidjs/solid (cold, restore, cached; vx first in each); the
      per-package tiles become "First at any size". The nine
      differentiators, the three "no"s and the six plugin cards are
      one card; the rail, the overhead chart, the `nots` list and the
      two-column layouts are gone. Body text is 16–20 px (was 13–15);
      the benchmark note paragraphs left the page for the docs, and
      the generator no longer rewrites them (`update-site.ts`: rows
      and tiles only). Every card and every section links to the page
      that proves it (benchmarks, sandboxing, plugins, comparison,
      trusting the cache, migrate, architecture, parity, `vx why`,
      extensibility, remote execution and caching, MCP, schema).

135.  DONE (2026-09-11 — owner: "Find the most popular repo using
      Turborepo by stars, something big with many packages, so we can
      bench against it; solid is too small"): n8n-io/n8n. Verified
      against GitHub on 2026-09-11 — stars n8n 204k (root
      `turbo.json`, 27 tasks; pnpm 12, Node ≥ 24), next.js 142k
      (turbo, but a Rust monorepo with a handful of JS packages),
      supabase 109k (no `turbo.json` on master any more), astro 62k
      (turbo, ~90 `build` scripts but 553 workspace members, most of
      them examples and test fixtures), cal.com 48k (turbo, yarn 4),
      payload 45k (turbo, pnpm), medusa 36k (turbo, yarn 3, 100+
      packages). n8n on a shallow clone in the scratchpad: 84
      workspace members over six globs, 71 with `build`, 78
      `typecheck`, 76 `test`; under `@vzn/vx-turbo` with nothing
      written, `vx run --dry` plans build 71 tasks, typecheck 139,
      test:unit 119, lint 133, all four 274 — every `pkg#task` root
      key, the one per-package overlay (`@n8n/storybook`) and the
      `^build` chains map. The run itself needs the bench host (this
      container has Node 22, four cores); the recipe is at the top of
      `packages/vx-bench/real/turbo-repo.sh` and in Next 15. Found on
      the way and fixed: the plugin warned once PER TASK that a task
      is persistent — n8n marks `dev` and `watch` persistent in most
      packages, a hundred identical lines before the first frame — and
      reports them in one line per run now, naming the count, the task
      names and the package count; pinned in the plugin suite.

136.  DONE (2026-09-11): every mapper gap is one line per run. Item
      135's one-line form covered persistent tasks only; the astro
      dry-run under `@vzn/vx-turbo` then printed 57 identical lines
      for `!vendor/**` (one per package whose `build` and `build:ci`
      negate an output). The plugin now indexes every task-level todo
      by its text at mapping time and reports each once, naming the
      count, the task names and the package count (a gap one task
      carries keeps its `pkg#task:` form); the persistent line is the
      same shape. Pinned in the plugin suite: two packages sharing a
      negated output are one line, and the per-task form is absent.
      Astro's task set under the plugin was also checked against
      Turbo's own dry-run for the repo's build scope: Turbo lists 64
      tasks of which 32 are `<NONEXISTENT>` placeholders (`build`
      depends on `prebuild`, which only `astro` defines); the 32 real
      ones are exactly vx's plan, so both tools run the same graph in
      item 137's bench.

137.  DONE (2026-09-11; narrowed by item 149 — only a peer that would
      close a cycle orders nothing): a peer dependency orders nothing. Mapping
      medusajs/medusa under `@vzn/vx-turbo` planned zero tasks — a
      task-graph cycle, analytics to test-utils to medusa and back to
      analytics, every hop a `build` — while Turbo's own dry-run
      planned 83. The edge that closed the loop is test-utils' PEER
      on medusa; the other two are a devDependency and a dependency.
      Turbo reads no peers at all. The package graph now has two
      adjacencies: order (`directDeps`, the `'^name'` walk) is
      dependencies, devDependencies, optionalDependencies and the
      task edges — what the package has installed for itself — and
      reach (`transitiveDeps` / `transitiveDependents`, what
      `--filter pkg...` and `--affected` read) adds peers, because a
      change in a peer can still break the package that peers on it.
      Pinned in `tests/package-graph.test.ts` (a peer reaches but
      does not order; the medusa shape is no cycle), documented in
      `modules/package-graph.md`, `cli.md` and `schema.md`. Under
      the fix medusa plans the same 83 `pkg#task` ids Turbo runs.
      Payload's scope was checked the same way: its `build:core`
      (negated `plugin-*` / `storage-*` filters) differs between the
      tools — Turbo still builds an excluded package when a selected
      one depends on it, vx drops it from the run — so the bench
      uses `build:all` (templates excluded, leaves either way), where
      both plan the same 45 tasks.

138.  DONE (2026-09-11): two more Turbo shapes the bench repos
      taught the mapper. (a) A per-package `{ "extends": false }` with
      nothing else is Turbo's opt-out — n8n's `@n8n/storybook` has
      `build` and `test` scripts, the root defines both, and Turbo 2.9
      runs nothing for it (probed with `--dry=json`: filtered to the
      package, zero tasks; with an `outputs` key added, the task runs
      on that key alone, no `^build` from the root). vx planned 71
      `build` tasks to Turbo's 70. The mapper now drops the task for
      an opt-out and, for an overlay with keys, starts from the
      overlay instead of the root definition. (b) A glob that climbs
      out of the package — cal.com's app-store-cli writes its output
      to `../../packages/app-store/*.generated.ts` — is a
      workspace-root glob in vx's terms: re-anchored on the root into
      `outputs.workspaceFiles` / `inputs.workspaceFiles` (negation
      kept); one that climbs out of the workspace is reported. Before,
      core refused the project-relative glob and the whole cal.com run
      aborted. Both pinned in the plugin suite. Every bench repo now
      plans exactly Turbo's real task set (Turbo's dry-run minus its
      `<NONEXISTENT>` placeholders): astro 32, payload 45, medusa 83,
      cal.com 13, n8n 70.

139.  DONE (2026-09-11): a negated output that carves the package
      root out of a wildcard runs the task uncached. medusa's
      turbo.json declares `build` outputs as `*/**` and `.medusa/**`
      minus `!src/**` and `!node_modules/**`; the mapper kept the
      positive globs and reported the negations, so core would have
      cleaned `*/**` — the sources — before every exec. vx has no
      output negation by design (the clean and the restore are exact),
      so the rule is: a negation under a literal-rooted output
      (`dist/**` minus `!dist/**/*.map`) leaves a harmless superset of
      build products and stays a todo; a negation against a
      wildcard-rooted positive makes the task uncached, with a todo
      that says to declare the exact outputs in a vx.config. Pinned
      in the plugin suite with the medusa shape: no cache block, the
      one-line warning, and a real run whose `src/` survives (fails
      on the previous mapper — the clean deleted the fixture's
      generated source). The bench gives medusa exactly that: a
      ten-line project-stage plugin in its `vx.workspace.mjs` naming
      `dist/**` and `.medusa/**`, so both tools cache the same files.
      Three more findings from the first astro rep, all in the
      harness: (a) Turbo on astro's explicit `inputs: ["**/*"]` hashes
      its own restored `dist/**` (an explicit inputs glob matches the
      filesystem, gitignore or not — touching a gitignored
      `dist/index.js` changed the task hash in `--dry=json`), so its
      first run after a restore is a full rebuild (62 s on the noop
      arm) and it stabilizes only on the run after; the harness gained
      a `noop2` arm so both are reported. vx excludes declared outputs
      from the inputs and answered the same noop in 636 ms. (b) The
      cold gap on astro was concurrency, not the runner: Turbo defaults
      to 10 workers whatever the core count, vx to the core count;
      astro cold on four cores was 70.5 s at 4 workers, 53.8 s at 8,
      56.5 s at 10, 54.3 s at 16 (Turbo 66.3 s), but payload was
      120 s at 4 and 128 s at 8 — a CPU-bound swc build gains nothing
      from oversubscription — so the default stays the core count
      (refuted: "raise the default"; two repos disagree) and the
      matched bench passes vx `--concurrency 10` through the new
      `VX_ARGS`. (c) payload keeps 42 `tsconfig.tsbuildinfo` files in
      the package roots; a wipe of `dist` alone made the next
      incremental tsc skip its declaration emit and every dependant
      failed with TS6305 under either tool — the wipe removes them
      too.

140.  DONE (2026-09-11, owner): adoption is one package. `@vzn/vx-turbo`
      (the `turbo()` project-stage plugin and the mapper), `@vzn/vx-turbo-cache`
      (`turboCache()`) and `@vzn/vx-nx-cache` (`nxCache()`) merged into
      `@vzn/vx-migrate` as `src/turbo/`, `src/turbo-cache/` and
      `src/nx-cache/`, one entry exporting all of it beside the migrate
      CLI; every plugin from it is named `@vzn/vx-migrate` (a plugin's
      name is its package name, and core reads names only in messages
      and the key stage's material prefix). `@vzn/vx-prune` is removed
      with its verb; `vx prune` prints that it is gone unless a declared
      plugin claims the verb. Suites, READMEs, the docs tables and the
      bench harness follow the move; the shim test's package list too.

141.  DONE (2026-09-11 — Next 15; owner: "one thing at a time", "real
      comparison not cheating", "best possible scenarios"): five real
      Turbo repos, benched and fixed. astro, payload, medusa, n8n and
      cal.com on this container against each repo's own Turbo, one
      arm at a time, full artifact cleanup before every cold and
      restore arm: `docs/benchmarks.md` § Five real Turbo repos; every
      revision, toolchain and bench-side adjustment in
      `packages/vx-bench/real/REPOS.md`. What the profiles of the first
      tables exposed in vx, each fix with a pin that fails on the
      previous code: (a) `Bun.write` blocks the calling thread for a
      small buffer, so restores serialized — `writeFile` from
      node:fs/promises, the containment check and the mkdir memoized
      per directory, chmod/utimes/rename committed in synchronous
      batches of 256 (payload restore 6.3 s → 3.44 s); (b) the
      directory snapshot after a restore was taken inside its own racy
      window and refused, so the first warm run after every restore
      walked its output trees (41 of payload's 45 tasks, 14,430 files)
      — taken at run end like the miss path's; (c) `OUTPUT_DIRS_CAP`
      256 → 8192 (`@payloadcms/ui` has 535 output directories); (d)
      `inputs.workspaceFiles` resolved per task — memoized per run and
      snapshot, the stability gate reads the memo (medusa's 83 tasks
      share one `globalDependencies` literal, 76 were hashed twice;
      no-op 2.5 s → 947 ms); (e) an absent output prefix (medusa's
      `.medusa/**`) refused every snapshot — recorded as absent. Bench
      side, named in the doc so nobody reads them as the mapping:
      medusa's and cal.com's output lists (item 139; cal.com's
      `.next/node_modules` holds 110 symlinks to directories, which
      the artifact format does not store — Next), astro's `build`
      inputs fixed for Turbo's benefit, n8n's `@vscode/ripgrep` never
      built, cal.com's `.env`. The trade payload's no-op shows: vx
      stats every recorded output file on a hit (~36 ms for 14,430)
      and Turbo checks nothing on disk, and the doc says Turbo takes
      that row. Refuted: a hand-written `ls-files` parser (slower than
      the regex), synchronous small writes, `UV_THREADPOOL_SIZE`. The
      box is 16 GB but the session's memory cgroup allows 13.3 GiB:
      the wide n8n set (`build typecheck lint`, 220 tasks) at 4
      workers lost `n8n-editor-ui#lint` and `#typecheck` to the OOM
      killer (3.6 GB resident each, `dmesg`; the lint passed alone on
      the same inputs), and at 3 workers its last three tasks — vue-tsc
      at 5.7 GB and two eslints at 3.85 — filled the cgroup to the byte
      and thrashed 20 minutes at 97% system time; dropped (owner:
      "leave n8n alone, we have plenty of repos"); medusa's wide set
      dropped too — its `test` declares no `dependsOn`, so a cold tree
      runs tests before their imports are built under both tools, and
      astro's for the same gap (`test` depends on `^test` only) — so
      the wide pass is payload `build lint` (89: cold 318 s to Turbo's
      334, the warm rows within 3% on the repo's own uncached lint
      floor) and cal.com `build lint` (24: Turbo's cold by 4%, vx's
      warm rows by 1.22–1.26×) at 3 workers, and the harness keeps one
      log per tool and arm, outside the artifact clean. The landing
      page's real-repo panel shows n8n (the most-starred), cold row
      and all — Turbo took it by 3%, inside the disk's noise — and the
      hero no longer claims every row on real repos: the cold row is
      the compilers', the runner's rows are vx's on all five.

142.  DONE (2026-09-11 — the Nx round, Next 15): a script that calls
      yarn's `run` builtin runs as `yarn run <name>`. yarn ≥ 2 runs
      scripts in its own shell, where `run -T rollup -c` is "the root's
      rollup" and `run clean && run build` chains siblings; inlined into
      sh — both mappers' rule, one process less per task — every strapi
      package was `run: command not found`. `scriptCommand` in
      `@vzn/vx-migrate` is the one place both mappers turn a body into a
      command; the pin covers `vitest run` and `prerun-check` (not the
      builtin). Bench side, strapi's `build:code` and `build:types`
      share `dist/**` with `build`, which vx refuses (an exact clean
      cannot serve two tasks one directory); the bench runs the
      siblings uncached and benches `build`. Nx parity by task graph
      (`nx run-many --graph=<file>` against `vx --dry=json`): query 25,
      strapi 39, identical sets; medians of three in
      `docs/benchmarks.md` § Real Nx repos — query cold 47.4 s to Nx's
      55.1, restore 656 ms to 1.98 s, no-op 174 ms to 1.88 s; strapi
      cold 238 s to 246, restore 1.61 s to 3.94, no-op 341 ms to 4.02 s.
      Harness: `real/nx-repo.sh`, the four
      arms against the repo's own Nx with `NX_DAEMON=false` and
      `NX_NO_CLOUD=true`, the pinned package manager on PATH for both
      (corepack's shim fetches the registry per spawn, which vx's
      isolated env cannot). Two migration gaps the round exposed, in
      Next: the generated `vx.config.ts` is compiled by a package's own
      `tsc --build` (query's `include: **/*.ts`; the bench rewrites the
      configs to `.mjs`), and two targets on one output directory
      (strapi's `build:code` / `build:types` / `build`, all `dist/**`).
      The gate for this item ran on the bench box with four shards
      side by side (load 6–8) and lost `cli.test.ts`'s "workspace-root
      lockfile changes trigger a cycle" to its 45 s window once; alone
      it passes in 0.3 s and CI passed on the same head. The window is
      a claim about time under that load, not a refuted one.

143.  DONE (2026-09-11 — the Nx round, novu): an empty package script is
      not a command. Nx lists `test:watch: ""` as an `nx:run-script`
      target and `pnpm run` runs it as nothing; the mapper wrote
      `command: ''`, which the loader refuses, so one empty script in
      `libs/dal` sank the whole workspace. It is the placeholder with a
      todo naming the script, like a missing one; `nx:run-commands`
      and a plain `command` guard the empty string too. Pinned in the
      Nx fixture (fails on the previous mapper). novu: 43 projects,
      416 `nx:run-script` and 39 `nx:run-commands` targets (the lints,
      with workspace-root `cwd`s); `build` minus the repo's own
      excludes (`nextjs`, `nestjs`) is 37 tasks, identical under
      `nx run-many --graph` and `vx --dry`.

144.  DONE (2026-09-11 — the Nx round, novu): `pre<name>` / `post<name>`
      hooks ride inside the mapped command. npm and pnpm run them
      around `<name>` without being asked, so Nx and Turbo, which run
      `pnpm run build`, get them for free; the inlined body did not,
      and `@novu/js#build` failed on the CSS its `prebuild` copies.
      `scriptCommand` folds them in that order, the way `vx init` has
      since its scripts mapper (workspace/migrate-scripts.ts), skips
      the package manager's own lifecycle names, and folds none for a
      yarn ≥ 2 script (that shell runs no hooks). Pinned; fails on the
      previous helper. The novu bench rows before the fix (vx cold
      183 s, exit 1) are discarded; with it, medians of three: cold
      291 s to Nx's 299, restore 3.10 s to 9.05, no-op 655 ms to
      8.55 s (`docs/benchmarks.md` § Real Nx repos).

145.  DONE (2026-09-11 — Next 15's first gap): `--mjs` on `vx init` and
      `vx-migrate`. The seam's `format` (`ts` | `mjs`) names the files
      (`vx.config.mjs`, `vx.workspace.mjs`, the Turbo preset
      `vx-preset.mjs` with its import specifier) and renders the same
      objects with no type import and no `satisfies`; the report and
      the example follow. Why: a package whose `tsconfig` includes
      every `.ts` under it compiles a generated `vx.config.ts` into its
      dist — TanStack/query's `tsc --build` failed on the type import in
      every sibling — and the bench had to rewrite the configs by hand.
      Pinned in `init.test.ts` and the Turbo suite (the `.mjs` files
      load through `loadProjectConfig`). The watch e2e flake (Next 5)
      showed again on this item's suite runs: `workspace-root lockfile
changes trigger a cycle` lost its 45 s window once alone on an
      idle box and passed five of five right after, with and without
      this change.

146.  DONE (2026-09-11 — Next 15's second gap): two targets on one output
      path resolve at migration time. vx cleans a task's outputs before
      it runs and before a restore, so the loader refuses two cached
      tasks whose outputs provably overlap — and strapi's `build`,
      `build:code` and `build:types`, all on `dist/**`, met that refusal
      at load time after a clean migration report. `resolveSharedOutputs`
      in `@vzn/vx-migrate`, after both mappers: the loader's own
      conservative overlap test (equal literals, a literal a glob
      matches, identical globs), the task with a `^` edge keeps its
      cache (the first declared when none has one), every other task on
      that path runs uncached with a todo naming the keeper and the
      fix. Pinned as a unit (the strapi shape, the disjoint-prefix
      case the loader lets through, tasks without cache) and in the Nx
      fixture (`pkg-b#build:types` on `build`'s `out`).

147.  DONE (2026-09-11 — Next 15, storybook's prerequisite): an
      `nx:run-commands` target runs where Nx ran it, with its
      placeholders expanded. Nx runs those commands from the WORKSPACE
      ROOT unless `cwd` says otherwise and interpolates `{projectRoot}`,
      `{projectName}` and `{workspaceRoot}`; the mapper emitted the
      string verbatim into a task vx runs from the project dir, so a
      root-relative command (storybook's `node ./scripts/build/
build-package.ts --cwd {projectRoot}`, novu's `npx biome lint
apps/worker`) found nothing, and `cwd: '{projectRoot}'` earned a
      spurious todo. `nxRunCommand` expands the three placeholders and
      prefixes the `cd` from the project dir to where Nx ran it (none
      when that is the project dir; `{args.*}` is a todo — params
      forwarding). A plain `command` is the same shorthand. Pinned as a
      unit (storybook's `compile`, a `{projectRoot}` cwd, a declared
      sub-directory, the root project) and in the Nx fixture, where
      the run-commands pins now carry the `cd` (three fail on the
      previous mapper).

148.  DONE (2026-09-11 — Next 5, the watch e2e flake): the arm instant
      is read off the mtime clock. A first-sighted path is a change
      only if it moved since the watchers went live, judged by its
      mtime against `armedAt`; `armedAt` was `Date.now()`, the fine
      clock, and an mtime is the kernel's coarse clock, up to a tick
      behind — measured here: 2 of 3,000 tight writes carried an mtime
      5.8 ms EARLIER than a `Date.now()` taken before the write, and
      more under CPU load, where the tick is skipped. So an edit made
      right after the ready line was judged the initial run's and
      dropped, and the loop waited forever: three shard runs lost a
      45 s window that day, and the reproduction (four CPU burners,
      `scratchpad/watch-probe.sh`) failed 3–5 of every 6 runs, the
      traced failures reading raw event → trigger → `same=true` on the
      edited file. `fsClockNow(cacheDir)` writes and removes a stamp
      under the cache dir and returns its mtime, so both sides of the
      comparison share one clock and every later write is at or after
      it; the same-tick case reads as a change (one benign extra cycle
      on the macOS late-delivery path the rule exists for). Pinned in
      `watch-rules.test.ts` (2,000 writes right after the stamp, none
      "before" it; the stamp removed; an older file still before) and
      by the probe: 12 of 12 loaded runs green on the fix, 0 of 24 test
      executions lost, against 0 of 24 idle and 3 of 24 loaded before.
      The e2e timeouts carry the watch's stdout and stderr (PR #310)
      so the next miss names itself.
149.  DONE (2026-09-11 — Next 15, found by the fourth Nx repo): a
      workspace peer orders the build unless it would close a cycle.
      Item 137 made every `peerDependencies` entry reach only (a peer
      is the consumer's to provide), and TanStack/router refuted the
      half of that claim that matters for order: `router-devtools-core`
      peers on `router-core`, pnpm links the peer into the package's
      own `node_modules` (`linkWorkspacePackages`; bun, npm and yarn
      hoist it to the root, where it resolves just the same), the build
      type-checks against the peer's `dist`, and Nx orders `^build` on
      the edge — vx built the devtools first and failed (77 of 85 on
      the cold probe, 9 skipped downstream). The rule now: order edges
      are the three hard fields, the task edges, and each workspace
      peer that does not reach the package back through the order
      edges so far, tried in (package, peer) name order so a mutual
      peering keeps the same edge on every run; a peer that would
      close a cycle stays reach only (medusa's shape from item 137,
      still runnable, still affected). Pinned in
      `tests/package-graph.test.ts` (the four-field pin flipped; the
      peer-behind-a-dev-dep and mutual-peering differentials; the
      medusa pin kept) and on router: the plan carries
      `router-core#build` under the devtools build. Warm path: an
      interleaved A/B of compiled binaries on the 1,000-project bench
      (no peers there — the cost is one sort and an empty pass), 12
      reps: base min 199 / median 203 ms, head 195 / 205. A tie.
150.  DONE (2026-09-11 — Next 15, the fourth Nx repo): TanStack/router
      benched, `build test:build` = 85 tasks at the repo's
      `parallel: 5`, medians of three: cold 199.9 s vs Nx 23.2.0's
      226.7 s, restore 1.00 s vs 3.33 s, no-op 505 ms vs 3.21 s
      (`docs/benchmarks.md`, `REPOS.md`). Two things the repo taught:
      the peer order edge (item 149), and Nx 23's cache living per
      user under `~/.nx/<workspace id>/`, outside anything the
      harness's clean sees — rep 2's Nx cold arm read 85 of 85 hits
      from it (5.0 s) and is not in the medians; `nx-repo.sh` pins
      `NX_CACHE_DIRECTORY` inside the repo since, and an Nx-only rep
      on the pin (224.1 s cold, the cache under `.nx/cache`, nothing
      under `~/.nx`) replaced the row. The install is the packages,
      benchmarks and root filters only (1 GB; the examples pull every
      framework and are out of the repo's own scope anyway).
151.  DONE (2026-09-11 — from router's configs): the Nx mapper's
      directory heuristic took a leading dot for an extension, so
      `{projectRoot}/.output`, `.netlify` and `.wrangler` (router's
      `build` outputs; Nx's own plugins declare `.next` and `.nuxt` the
      same way) were written bare while `dist` became `dist/**`. A bare
      name for a directory saves nothing — the output scan lists files
      and symlinks, never a directory itself — so a hit would have
      restored no `.output`, the stale-hit class in a generated config.
      Only a dot past the first character marks a file now; pinned in
      `migrate.test.ts` (`.output` → `.output/**` beside `lcov.info`
      kept), documented in the package README.
152.  DONE (2026-09-11 — Next 15, the fifth Nx repo): refinedev/refine
      benched, the 35 library `build` tasks at Nx's default
      `parallel: 3`, medians of three: cold 104.2 s vs Nx 18.2.2's
      115.3 s, restore 636 ms vs 2.23 s, no-op 184 ms vs 2.11 s
      (`docs/benchmarks.md`, `REPOS.md`). Out of both tools: the
      examples (the repo's own scope) and its two Next apps —
      `refine-ui`'s build fetches Google Fonts (no egress here) and
      `live-previews` is one 280 s `next build`. `types` shares
      `dist/**` with `build`, so item 146 leaves it uncached under vx
      while Nx caches it: not benched. The mapper wrote the repo's
      `{projectRoot}/.next` output as `.next/**` (item 151). Nx round
      closed at five repos (owner: 3–5): query, strapi, novu, router,
      refine.
153.  DONE (2026-09-11 — the real-repo no-op, profiled): vx reports
      76 ms of refine's 183 ms no-op wall and 293 of router's 513, so
      the rest was measured on refine with `VX_TIMING=1` (three runs,
      180 ms wall, the table's 162 ms): startup 27, git enumeration 34,
      classify + probe 34 (the 35 task hashes 24, the batched probe
      8), run graph 42, record history 5, and ~15 ms of Bun boot before
      the first mark (`--version` is 20 ms wall; the tail after the
      table is 7 ms under strace). Discovery and config load are 10 ms
      for 206 projects. The run graph's 42 ms is the output proof:
      6,790 output files under 35 `dist/**` (median 70 per package, max
      1,192) stat'ed synchronously at three workers — ~6 µs a file,
      the price of "a hit over intact outputs" meaning intact, and the
      one cost that scales with the repo rather than the task count
      (payload's 14,430 files, STATUS 2026-09-11, are the same lane).
      Refuted on the way, so nobody re-runs them: scoping the git
      enumeration to the run — strace shows both spawns already carry
      the loaded closure's 35 package directories as pathspecs (`git
status -uall` scoped is 19 ms here against 54 for the tree; the
      64-pathspec cap in `gitPathspecs` is what a `--all` run on a
      200-project tree exceeds, by design); and a cost in the exit
      path. Nothing to take without a design change to the proof.
154.  DONE (2026-09-11): `VX_TIMING=1` prints the stage table at the
      end of a `--dry` run too. Item 153's profile needed a 2.3 GB
      reinstall of refine because the table was silent under `--dry`,
      and the prepare stages (discovery, config load, the git
      enumeration) are exactly what a dry run exercises on a checkout
      with no install. Pinned in `tests/timing-dry.test.ts` (the
      table through `build graph` and `close` with the variable, absent
      without); `modules/timing.md` and `cli.md` say so.
155.  DONE (2026-09-12 — owner: "frozen should always be faster;
      the benchmarks page says otherwise"): it is a tie, and the page
      said why wrongly. Since the config-evaluation cache (2026-09-02)
      a plain warm run evaluates nothing for a provably pure config and
      serves the validated object from `cache.db` with no
      re-validation (`project-loader.ts`: "stored AFTER validation, so
      a hit needs none"); `--frozen` parses the 1.1 MB lock and
      re-validates all 1,000 entries, because the lock is hand-editable
      (`lockfile.ts`, deliberate). Frozen skips only the per-config
      identity stat and pays the parse back. Measured on the
      1,000-project bench, compiled binary, 12 interleaved reps: plain
      min 154 / median 177 ms, frozen 148 / 165; `load configs` 20–25
      ms plain against 6–10 (lock read) + 12–14 (load) frozen, with a
      temporary mark. The 2026-09-03 46-package row (83 vs 76, median
      of 1) is that tie under noise, not a regression. No code change:
      the validation is the boundary. `benchmarks.md` corrected in
      place — the frozen paragraph, and "Known headroom", which still
      said an evaluation cache had been rejected — and `--frozen`
      documented for what it buys: the guarantee, and eval-free runs
      for configs the purity gate cannot prove.

**The restore arm is at its floor (2026-09-10, late night).** The
1,000-project warm-restore run spends its wall in `restore: extract`
(2.4 ms accumulated per task under four workers; `VX_TIMING=1`), so
one artifact was timed alone, sequentially, 200 reps: `restoreOutputs`
0.375 ms min / 0.75 avg, of which the five file syscalls the extractor
needs (mkdir, write temp, chmod, utimes, rename) are 0.18–0.26 ms,
zstd decode 0.02 ms, the artifact read 0.01 ms, the rows lookup
0.003 ms, `realpath` 0.01 ms. The run's 393 ms `run graph` over 1,000
restores is 0.39 ms per task — the sequential floor, overlapped. What
is left is syscall round trips on the thread pool; folding chmod into
the write (mode at open is umask-dependent, so the chmod stays for
exactness) or skipping utimes would buy ~0.05 ms each, 15–25 ms of a
434 ms run, on the stale-hit-critical path. Not worth the risk;
recorded so the next reader does not re-derive it.

**Shard weights refreshed (2026-09-10, after items 65–67).** Three
suites moved to packages and `init.test.ts` shrank, so the deal was
running on stale numbers: twelve shards side by side on this four-core
box read 11.8–14.6 s (wall 14.7 s). Re-weighed from that run's JUnit
(`--weigh`), the same files deal to 13.5 s each by the new weights
against 14.6 s for the old deal's heaviest — the wall follows the
heaviest shard, so about a second. The weights are what a twelve-way
run on four cores measures, the condition the gate runs under.

**Plugin names, one convention (2026-09-10; superseded by item 69 the
same day).** `vx info` listed the repo's own plugins as `vzn/otel`,
`@vzn/vx-github`, `vx/mcp` and `vx/schedule-history` — three spellings
across four lines. The interim answer was `vx/<thing>` everywhere; the
owner's answer is that the name is the package name and nothing else,
which item 69 enforces. No first-party plugin fills `key`, where the
name is folded into the material, so nothing re-keyed either way.

**The guide pin under the sandboxed gate (2026-09-10, after item 67).**
CI's Linux job went red on 15136a6 in `@vzn/vx-docs#test`: the plugins
guide's type-check pin exited 1 with no diagnostic line captured. The
cause was the sandbox, not the types: item 65 had pointed the pin's
tsconfig `paths` straight at `packages/vx-schedule-history/src`, a
sibling the site does not depend on, and a sandboxed task may read its
project, its `node_modules` and what those link to — nothing else. The
fix is the honest one: the site declares `@vzn/vx-schedule-history` as
a devDependency, Bun links it into the site's `node_modules`, the
sandbox grants the link target, and the pin resolves the package
through that link. Reproduced and proven differentially under the real
sandbox here, not on CI alone — a probe refuted on the way: with the
link present, even the direct path passed, so the denial was never
about the route but about an ungranted target. Recipe, since the
container runs as root and the runtime refuses a nested user namespace
there: copy the bun binary somewhere world-readable, `chmod 1777
/tmp/claude`, and run `vx run <task> --no-cache --excludeDependencies
--cache-dir <writable>` as `nobody` with `HOME` set — bwrap works for
an unprivileged user on this kernel. The pin now carries oxlint's tail
when it exits non-zero without a diagnostic line, so the next such
failure names its cause on CI.

**Two warm-path probes refuted after item 61 (2026-09-10).** Cold
config evaluation, measured by deleting `config_evals` and
`config_closures` on the warm 1,000-project copy: the `load configs`
stage reads 584 ms cold against 26 ms warm — 0.58 ms per config through
the worker, so a 2,000-project first run pays about a second there and
no batching lead exists; `scale-graph`'s 9.5 s `beforeAll` is its
generator, git and warm plan, not evaluation. And the accumulated
`output dirs` counter (52 ms over 1,000 proofs, 52 µs each for one or
two `statSync` calls) is not a cost to chase: an accumulated span
measures wall time between its start and end, and under the
scheduler's concurrency that window holds other tasks' work, so the
per-call figure over-counts. The rule for the stage table: stage rows
are exclusive and comparable; accumulated rows are upper bounds.

**Profiles after item 50 (2026-09-10).** `bun --cpu-prof` on the
pre-warmed 1,000-project copy, third run of three. `vx show` (93 ms
sampled): 28% in the discovery closure (`workspace.ts:303` — the
per-package readdir + manifest read, async continuation attributed to
the closure), 11% `JSON.parse` of manifests, 5% `listProjects`, then
the staged load and the eval-cache keys at 1–3% each. Warm `vx run`
(228 ms sampled): `statSync` 9% (the two output proofs, 2,000 stats,
chosen sync by the 2026-09-09 A/B: 100 → 54 ms on the run-graph
stage), `findConfigFile` 5%, `bun:sqlite` query 3.5%, package graph
2.5%, `hashProjectPackageJson` 2.4%, then a long tail under 2%. No
new hot spot: every frame over 2% is a measured decision already
recorded (discovery 8(e), the proofs' sync stats, the manifest hash).
The next warm-path gain is structural (8(e)'s stat-keyed discovery
memo), not a frame.

**Warm path after item 46 (2026-09-10).** Interleaved A/B, 1,000
projects, twelve reps, both orders, base = the immutable c0b20ca
worktree: main min 225 / med 242 ms vs head 231 / 246 in one order,
head 221 / 233 vs main 222 / 232 in the other — a tie inside
run-to-run jitter, the sign flipping with the order. The reset
property read (39), the env field check (44, on the eval path only)
and the orphan scan (35, prune only) cost the warm run nothing
measurable.

**Handoff after item 45 (2026-09-10, morning).** PR #265 carries the
loop, 70+ commits; every head is green on CI except the ones a
same-day commit fixed (d295a90 timing, 1414cf2 `.mcp.json`, f549719
unformatted tables, 92e1682/f4a0d48 a doc law reading outside the
sandbox — each recorded above). The shape since item 31: the owner's
two asks (item 43's `vx lock` report and item 45's suite speed) both
resolved to measurement first — a repro that round-trips, a JUnit
timing pass — and each fix carries a pin that fails on the old code;
three probes became laws (`doc-references`, `schema-unknown-keys`,
`sandbox-hint`); the reset notice (39), the orphan sweep (35) and the
doctor's orphans row (41) close the schema-bump story end to end. The
suite runs ~95 s of test bodies across eight shards on four cores;
what remains over a second is real work (rate floods, an 87k-edge
graph, Worker spawns, ~130 end-to-end CLI spawns at ~100 ms). Start
the next session from Next § 8: (e)/(f)/(g) are open with reasons;
(c) is done for every verb but `vx lock`, on purpose. The scratchpad
harnesses (`ab2.ts` warm, `ab3.ts` cold, `abshow.ts` for `vx show`,
`junit/` for suite timing) take two worktrees and two workspace
copies; recreate the copies with the bench generator.
Next-list 8(b) decided: `--max-size` keeps reading a bare integer
as bytes — it is pinned (`cli-arg-hygiene`: `--max-size 1` is one
byte), documented as `<bytes>`, and the zero bound is the guard;
refusing unitless there would reverse an earlier call for one
footgun the docs already name.

## In flight

**Open after the sandbox arc (2026-09-05).** Local `vx run ci --all` is
green, 36/36, no violations. CI is not, and every remaining item is
either a one-line decision or a known constraint, not a mystery:

1. DONE 2026-09-09: `@vzn/vx-docs#build` on Linux CI, red since
   2026-09-05 with exit 1 and nothing on either stream. Not the
   telemetry EROFS recorded before (real, but not what exited), not the
   runner's Node. A diagnostic frame from CI (hooking `process.exit` and
   both rejection channels) said `Cannot find package 'yargs-parser'
from …/node_modules/astro/dist/cli/index.js` — astro's OWN
   dependency, unresolvable because the task's write grants under
   `node_modules` (`.astro/**`, `.vite/**`) made `punchWritePaths` bind
   node_modules' children one by one, and bwrap mounts a SYMLINKED child
   (every package in Bun's isolated layout) as the directory it points
   at, so astro sat in a plain directory with no `.bun/` siblings.
   astro's and vite's caches now live under `.astro/` (astro.config.mjs)
   and the grants follow; `punchWritePaths` warns, naming the grant,
   whenever a punch meets a symlinked entry. The build also runs under
   `bun --bun` (half the wall time; no dependency on the runner's Node)
   and the telemetry define stays.
2. DONE 2026-09-09, and the diagnosis was wrong: the four perf baselines
   did not fail from eight-way contention but from ptrace. The Linux
   sandbox wraps every task in `strace -f -e trace=openat`, and without
   `--seccomp-bpf` strace stops the tracee on EVERY syscall and filters
   in userspace, so a stat-heavy micro-benchmark ran 2.5–7× over
   budget. Reproduced outside the sandbox: plain `bun test` 24/24, the
   same four fail under strace, 24/24 again under `--seccomp-bpf`. The
   flag is on (strace ≥ 5.3; older gets the slow form), which also
   takes that tax off every other sandboxed task on Linux — the gate's
   `time 138s · max 89s` on the last run is the number to compare.
3. DONE 2026-09-10 (item 79): a sandboxed task exposes a port on Linux
   through `allow.localBinding: [port, …]` — a per-port socat pair over
   a unix socket in the sandbox tmpdir, the task's side in front of the
   command, the host's side released when the task exits. The arming
   went as this entry said (the unix-socket allowance from the run's
   union at `initSandbox`), and found the reason the first probe still
   died: on Linux the availability probe initializes SRT with an EMPTY
   config and `initialize()` returns early ever after, so the run's own
   call — the domain union included — never reached the runtime.
   `initSandbox` now hot-reloads the run's config (`updateConfig`).
   Was: macOS works and is properly gated; on Linux every sandboxed task
   gets `--unshare-net`, so nothing saw the port.
4. DONE 2026-09-09: persistent tasks run inside their `exec.sandbox`.
   `wrapSandboxedCommand` is the enforcement half of `runSandboxed` on
   its own and the persistent path spawns through it; the violation
   report stays one-shot only, since it reads the trace after exit and a
   server exits at teardown. `vx-docs`'s `dev` and `preview` blocks mean
   what they say now. Pinned in the unsafe suite: a sandboxed server that
   reads a workspace-root file sees the denial, the same server without
   the block reads it.
5. **macOS violation reporting is lossy while any violation fails the
   task.** The unified log drops records under load, so the same task can
   pass or fail run to run. Enforcement is unaffected — the OS denied the
   operation either way — but the REPORT is not a reliable gate on that
   platform.

- **v0.0.18 is fully on npm; one owner step remains before the next
  release.** npm released the two held packages about ninety minutes
  after the publish: all five serve 0.0.18 as `latest` (2026-09-04
  00:20Z). `npm.yml` now publishes with trusted publishing only — no
  token read anywhere, `--provenance` explicit, the npm ≥ 11.5.1 +
  sigstore guard on both jobs, `permissions: {}` at the top, every
  action in `npm.yml` and `release.yml` pinned to a commit SHA, and the
  object-form `repository` npm was rewriting. OWNER STEP before the next
  release: on npmjs.com add the GitHub Actions trusted publisher (owner
  `vznjs`, repo `vx`, workflow `npm.yml`, no environment) to each of the
  five packages, then delete the `NPM_TOKEN` secret (it is no longer
  read; npm restricts it — v0.0.17's `E401`, v0.0.18's hold). The
  build half is PROVEN: a `workflow_dispatch` dry run of the new
  workflow (run 33812502741, 2026-09-04) succeeded on both jobs — pinned
  actions resolve, the npm ≥ 11.5.1 guard passes on macOS and ubuntu,
  all five packages build and assemble at the stamped version, and
  only the two publish steps were skipped, as `dry_run` intends. The
  auth half is proven by the next release. Documented in
  `docs/cli.md` § Releasing.

**Launch checklist (2026-09-10, the owner's "what is needed to go
fully live").** What a public announcement needs, in order, with the
state of each:

1. OWNER: npm trusted publishing — on npmjs.com add the GitHub Actions
   publisher (owner `vznjs`, repo `vx`, workflow `npm.yml`, no
   environment) to `@vzn/vx` and the four platform packages, then delete
   the `NPM_TOKEN` secret. Until then `npm install -g @vzn/vx` installs
   v0.0.18 from 2026-09-04, four days of work behind main. Documented in
   `docs/cli.md` § Releasing.
2. OWNER: cut the release — a GitHub release with the tag is the whole
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
4. DONE tonight: the blog (item 115) with thirty posts for the
   announcement series (item 118), README and site numbers generated
   and checked, "Edit page" links that open the right file, LICENSE
   holder, SECURITY.md, CONTRIBUTING.md (item 116).
5. OWNER, optional: enable GitHub private vulnerability reporting
   (Settings → Security) so `SECURITY.md`'s instruction is live; issue
   templates are not needed for a first announcement.
6. Known limits an article should state plainly: Bun ≥ 1.4 for source
   installs (the binary needs nothing); Linux sandboxing needs
   `bubblewrap` + `socat` and cannot run as root inside a container;
   Windows is WSL; macOS violation reporting is lossy under load
   (In-flight 5); the remote seam moves whole artifacts in memory
   (Next 2, fine below ~100 MiB).

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
2. **The remote seam still moves whole artifacts.** With save, ingest
   and restore bounded, `RemoteCacheLayer` is the last place a large
   artifact sits in memory: `put(hash, body: ArrayBuffer | Uint8Array)`
   gets the on-disk artifact via `Bun.file().bytes()`, and `get` returns
   an `ArrayBuffer` that ingest writes to its temp. Widening both to a
   `Blob` (a `BunFile` is one; bytes wrap in one) would let uploads
   stream from disk and downloads land in the temp directly — but
   `@vzn/vx-reapi` must digest the whole body before it can upload, so
   the plugin side needs a streaming digest and a chunked `writeBlob`
   first. A breaking seam change for plugin authors; do it with the
   plugins guide, the stub layers in the tests and `vx-reapi` in one
   commit, and measure a 150 MiB round trip through the stub before
   and after. Not started. Assessed 2026-09-04: the win is gated by the PLUGIN
   side — `@vzn/vx-reapi`'s wire zstd-compresses the whole body in
   memory and retries a wedged upload from it, so a core-side Blob alone
   measures nothing; streaming needs a two-pass digest and a chunked
   compressed upload through the adaptive-downgrade path. Do it when a
   real workspace uploads > 100 MiB artifacts, not before.
3. DONE 2026-09-09 as item 88 → `@vzn/vx-turbo` (history) — zero-migration adoption as a plugin on the `project` stage.
4. DONE 2026-09-10 as item 77 (history) — one core per process; the shipped binary serves its own façade to every `@vzn/vx` import.
5. DONE 2026-09-11 as item 148 — the watch e2e flake was the arm
   instant on the wrong clock; the macOS intermittent extra cycle stays
   recorded under item 130.
6. **Re-measure the warm run after each day's work** — the hot path is
   the product. `bun packages/vx-bench/run.ts 100 5` and `1000 5`; an interleaved
   A/B against an immutable worktree settles any gap
   (`scratchpad/ab.ts`-style: alternate arms, min and median of N).
   REFUTED 2026-09-10 (afternoon), recorded so nobody re-runs it: a
   synchronous restore for small artifacts. The restore path makes
   ~8 `node:fs/promises` round trips per one-file artifact (exists,
   read, realpath, mkdir, write, chmod, utimes, rename), and a
   `restore: exists / rows / extract` span set (kept) showed the
   extract as the whole cost; the sync form measured 2× faster ALONE
   (sequential in-process restore of a 40-byte `dist/out.js`, median
   1.25 → 0.62 ms against 0.52 for the bare syscalls) and 30% SLOWER
   in the run (compiled binaries, three interleaved rounds on the
   1,000-project bench: `warm, restore` 1,176 / 1,110 / 1,218 ms →
   1,539 / 1,506 / 1,493), because four workers overlap their round
   trips and a blocking one stalls the other three. The lead left:
   `restore: rows` re-selects the output rows the batched probe
   already loaded (21 ms per 1,000, ~2%); threading `hit.outputRows`
   through needs a contract change for a row nobody sees.
   Closing figures for 2026-09-10, evening (the same container,
   `run.ts` medians of 5, after items 81–82): source form 100 projects
   123 ms warm / 181 restore / 369 cold; 1,000 projects 240 / 1,163 /
   2,519 — against the afternoon's 115 / 197 / 408 and 265 / 1,381 /
   2,988: the restore row −16% and the cold row −16% at 1,000, which
   is the restore lane and the save lane on the headline bench, and
   the warm row within the box's jitter (nothing touched it).
   Closing figures for 2026-09-10, afternoon (the same container,
   `run.ts` medians of 5, after items 70–80): source form 100
   projects 115 ms warm / 197 restore / 408 cold; 1,000 projects 265 /
   1,381 / 2,988 — the 1,000 warm read high against the morning's
   229, so it was settled as the A/B the box needs: main before this
   session (264f01a) against the head, BOTH as compiled binaries
   through `VX_BIN`, three interleaved rounds — warm no-restore
   246 / 251 / 235 vs 250 / 212 / 201 ms, restore 1,510 / 1,297 /
   1,186 vs 1,241 / 1,230 / 1,308, cold 3,423 / 3,128 / 3,432 vs
   3,465 / 3,180 / 3,157. A tie or a win in every column; the lone
   265 was the box. (Items 70, 71 and 77 moved surfaces this bench
   does not exercise — a sandboxed gate, the first warm run after a
   cold one, a plugin-bearing binary — and each carries its own A/B.)
   Closing figures for 2026-09-10, morning (the same container, `run.ts`
   medians of 5, after the three package moves and the CI work): 100
   projects 118 ms warm / 182 restore / 394 cold; 1,000 projects 229 /
   1,206 / 2,758. No core warm-path change landed today — the moves
   ran nothing on `vx run` — and the figures sit on yesterday's within
   the box's jitter.
   Closing figures for 2026-09-09 on a noisy 4-core Linux container
   (late, after the improvement loop's 25 items): head vs main
   (c0b20ca), 1000 projects, both orders, min 296/304 and 302/295 ms,
   20 reps 310/313 — within run-to-run jitter, no `VX_TIMING` stage
   moved (loop item 25). Every warm-path step was A/B'd at its commit.
   (not the owner's box — compare against 2026-09-04 only by ratio):
   `run.ts` medians before the day's perf commit, 100 projects 109 ms
   warm / 180 ms restore, 1000 projects 281 / 1337; the commit's A/B is
   in the review entry. LEADS from the profile, not taken: (a) each
   `vx.config.ts` is stat'ed twice on the warm path — `findConfigFile`
   in discovery and again for its identity in the config load;
   threading the discovery stat into `hashFiles` saves ~1,000 stats.
   REFUTED on the cheaper half (2026-09-09): making discovery's stat
   synchronous ties (interleaved, 8 reps: min 57.6 vs 62.5 ms, median
   68 vs 67) because the async stats overlap the package.json reads.
   TAKEN another way the same day: on Linux each async stat is a
   thread-pool round trip and a `.mjs` config pays four of them per
   project, so one readdir per project dir replaces them there (12 ms
   against 43 at the last name, a tie at the first; the macOS stat loop
   stays, measured the winner there on 2026-09-03). Discover projects
   65–79 → 29–34 ms; whole process interleaved both orders, 10 reps:
   min 318 → 304 and 328 → 292 ms, median 368 → 325 and 358 → 320;
   (b) TAKEN 2026-09-09: the hit path's `output dirs` + `output stat`
   are ~2 stats per task and inherent to the proof, but they were
   thread-pool round trips; synchronous, the run graph stage halved
   (review entry); (c) TAKEN 2026-09-09: `record history` was ~10 ms
   on an empty table and 57–79 ms at 166k rows because of the
   (project, task) index; dropped (review entry). Remaining on the
   profile after both: discovery's async stat (42 ms native self time
   at 1,000 projects, the one lead (a) above leaves), and the history
   reader's slice scan for plugin users (~1 ms per 1,000 rows); after
   the readdir change, discovery's remaining cost is the manifest reads
   themselves. Closing figures for 2026-09-04 (load 5.7, best of 5): 1000
   projects 159 ms warm / 538 ms with restore, 100 projects 66 ms /
   104 ms — the sandbox and CI work touched nothing the warm path
   runs. Closing figures
   for 2026-09-03, after wave 6 and the discovery change, best of 5:
   1000 projects 193 ms (table says 204, measured before discovery
   changed), 100 projects 81 ms, on a box that had run the gate all day.
   Floors on the 1000-project bench (in-process, 2026-09-03): discover
   20 ms, load configs 21–23, git enumeration 21–47 exposed (the walk's
   own noise), classify + probe 23, run graph 19–21, record history
   11; total 151–184. What is left is the git walk (~60 ms, exposed by
   whatever it fails to overlap), 1,000 task hashes (11 ms), 1,000 file
   and directory stats (18 ms), 1,000 manifest reads (10 ms) and the
   batched inserts (4 ms after `runs_hash` went). The next real win is
   structural (not needing a walk), not another stage shave; fsmonitor,
   untracked cache and `-unormal` are refuted (see Shipped).
   COLD floors (same bench, cache wiped, `VX_TIMING=1` — the miss path
   carries spans since 2026-09-03): 2.06 s wall for 1,000 `echo` tasks at
   concurrency 10, i.e. ~20 ms per task-slot: execute 13.8 ms, save 3.6,
   resolve outputs 1.4, clean 0.6, task hash 0.01; cold config load 340
   ms (1,000 evaluations, no eval cache yet). Of the 13.8, the shell IS
   the floor on macOS: bare `sh -c 'echo built'` costs 9.2 ms per slot
   at 10 concurrent against 2.5 for `/bin/echo` spawned directly
   (stable over three rounds; `runCommand` adds 0.2 over the bare
   spawn). LEAD, not taken: spawning a shell-free command (`tsc -b`,
   `vitest run`) directly would save ~7 ms per task-slot on macOS and
   ~0 on Linux (dash starts in ~1 ms), against the principle that the
   shell is the API — PATH order, builtins, `command not found` → 127,
   scripts without a shebang all have to read identically. The headline
   shape's tasks use `&&`, so its rows would not move. Decide with the
   owner. The save's 3.8 ms splits (spans `save: *`): pack 1.25, write
   temp 0.63, rename 0.55, scan 0.46, index tx 0.17. Two trims measured
   as not worth their code (< 1 ms per task together, ~0.15% of the
   cold row): a synchronous compress for tiny buffers, and indexing a
   locally built artifact from its plan instead of re-scanning it.
   `vx watch` start on the same bench: the initial run plus a sweep of
   all 1,000 configs (repeat loads through the worker) — the sweep is
   35 ms, no visible pause.

   Closing figures for 2026-09-10, night (the same container, source
   form, medians of 5, after items 83–90 — the lockfile plugins, CI on
   vx tasks, the empty `build`, `@vzn/vx-infer`; none touched the hot
   path): 100 projects 126 ms warm / 205 restore / 427 cold; 1,000
   projects 244 / 1,006 / 2,567 — against the evening's 123 / 181 /
   369 and 240 / 1,163 / 2,519: the 1,000-project restore row −14%
   (the save-lane and restore-lane changes of the evening under a
   quieter box), every other row within its own spread.

   Closing figures for 2026-09-11, evening (the same container, source
   form, medians of 5, after items 131–148 — the migrate merge, the Nx
   mapper fixes, the real-repo benches and the watch arm instant; none
   touched `vx run`): 100 projects 120 ms warm / 171 restore / 396 cold;
   1,000 projects 247 / 870 / 2,810 — against the night's 126 / 205 /
   427 and 244 / 1,006 / 2,567: the warm rows tie, the 1,000-project
   restore row reads −14% and the cold row +9% with no commit on either
   lane. Both moved together with the box: the cold reps climbed
   monotonically through the run (2,639 → 3,171) while the restore reps
   held (841–907), so the spread is the container's, not the diff's; an
   A/B was not run because there is no candidate commit to put on the
   other arm.

7. **First-run DX follow-ups (candidates, from the 2026-09-04
   walkthrough).** (a) DONE 2026-09-09: `--summarize` task rows carry
   `noCache: true` for a task with no `cache` block (present only when
   true; documented in `docs/cli.md` § --summarize). (b) DONE 2026-09-04: `init` no longer makes `lint` wait for `build`
   (`test` / `typecheck` still do, the Turbo starter's convention). (c) CLOSED 2026-09-10 (measured on the watch-loop harness, pinned in `tests/watch-loop.test.ts`): an uncached task that writes into its project costs exactly one extra execution per edit and nothing after the initial run — the task's write and a user's edit during the run are the same FS event, so without the task's write set the loop cannot drop one and keep the other; the price of an undeclared output is one cycle, the fix is to declare it. Was: watch still pays one redundant cycle on a task's first undeclared write (the bytes are unknown until seen);
   hashing what the cycle wrote before re-arming would zero it — only
   if a real workspace shows the cycle mattering. (d) DONE 2026-09-04: a filter set that matches nothing is one
   error line naming the patterns and the nearest project name.
8. **Improvement-loop candidates (2026-09-09, in order).** (a) DONE as
   item 16 (`orchestrator/miss-save.ts`, behind the differential pin;
   the hit path followed as item 63, `hit-restore.ts`). (b) DONE 2026-09-10: `vx cache prune --max-size 10` is refused
   with the unit it wanted (`10M, 10G`); `10B` still passes, and
   `parseSize` keeps its bare-bytes contract for the computed
   `--memory` budgets. The zero guard speaks first for every zero
   spelling, as its pins require. (c) Anything else that reads config
   files raw: only `vx lock` remains, on purpose (it freezes the
   file's own evaluation). Grep for `loadProjectConfig(` before
   adding a fourth consumer of the staged load. (d) `logger.ts` (716)
   and `framed-output.ts` (528) are the last large files; split only
   if a concern separates as cleanly as the three splits today did
   (assessed 2026-09-09: neither does — one renderer, one formatter).
   (e) Discovery is the largest fixed cost a warm run pays before any
   task: `listProjects` reads 19–28 ms for 1000 packages (2026-09-09,
   isolated). The manifest reads are 3–5 ms of it (async `Bun.file`
   wins over `readFileSync` 3.4 vs 6.3 ms, re-measured — the comment
   in workspace.ts stands); the rest is the member glob, the config
   probe and the loops. A memo keyed on each member directory's stat
   would skip the reads on a warm run, but a directory mtime does not
   move when a file INSIDE it is rewritten in place, so the key would
   have to be the manifest's own stat — one stat per package, which is
   most of the cost already. Do it only with a measured design.
   Measured 2026-09-10 on the pre-warmed 1,000-project copy, min of
   seven, all in flight: today's per-package I/O (readdir + manifest
   read + `JSON.parse`) is 8.6 ms; the memo's key (a stat of the
   directory — entries added or removed — and a stat of the manifest)
   is 3.3 ms async, 2.8 ms sync. But the memo must hand plugins and the
   package graph the whole manifest, so it stores the parsed JSON and
   parses it back — the `JSON.parse` share stays — and reads 1,000
   rows from SQLite (~1 ms). Net ≈ 3–4 ms of a 230 ms run for a second
   staleness surface (directory mtimes across platforms). REFUTED as
   not worth it; revisit only if discovery's share grows.
   (f) DONE 2026-09-10 as item 75: `--cache-dir` on `vx why`, `vx
last`, `vx info` and `vx cache prune`, through one parser and one
   resolver. Was: a `vx run` flag only, leaving the reading verbs on
   the default directory.
   (g) `vx why` names a plugin `key` part but shows its digests
   (`plugin tool/node-major a2d9… → e893…`), because `entry_inputs`
   rows reduce every value to a digest — right for env values, which
   can be secrets, but a plugin's own material (`node-major: 22`) is
   what its author wants to read. Assessed 2026-09-09: a new column
   means a SCHEMA_VERSION bump, and a bump DROPS every table — every
   user's cache and history — for a nicety; storing the raw value in
   the `hash` column for `plugin` rows needs no bump but persists
   whatever a plugin returned (a secret, if a plugin ever folds one).
   Neither is worth it today; revisit when a plugin's part is the
   thing people debug.
   (h) DONE as item 58 (the weighted deal). Was: shard balance
   (measured 2026-09-10, after item 45): `bun test
--shard` splits by file count, so shard 5 carries `output-memory`
   (a 4 s rate measurement that spawns RSS probes) plus `task-timeout`
   and runs 18 s wall while the others run 5–13 s — the critical path
   when the shards run in parallel. Giving the memory probe its own
   task (every shard adds it to `--path-ignore-patterns`; one task
   runs the file alone) would cut the path to ~13 s. Nine config
   edits and a CLAUDE.md line for ~5 s; do it when the next slow file
   lands in the same shard, not before. Refuted alongside: pre-bundling
   the CLI for the ~130 end-to-end spawns. One `bun bin.ts --version`
   costs 45–47 ms (bun's own start is 4 ms); a `bun build
--target=bun` bundle of the same entry costs 83–90 ms, slower, as
   the flag-less compile was in item 32, and the `--bytecode` form's
   ~17 ms gain would buy ~2 s of suite for a build step in every test
   run. The spawns stay on source.

9. Superseded by 14 (items 70–80 landed as PRs #269–#271, 2026-09-10).
10. Superseded by 14 (items 81–95 landed as PRs #272–#273, 2026-09-10).
11. Superseded by 14 (the survey and parity rounds, items 96–111, 2026-09-10).
12. Superseded by 14 (items 102–112 landed as PRs #275–#279, 2026-09-10).
13. DONE 2026-09-10 as item 120 — `vx watch` watches the projects a cycle can run.
14. **Handoff after item 153 (2026-09-11, night).** PRs #302–#315
    carried the day: the adoption packages merged into
    `@vzn/vx-migrate` (`turbo()`, `turboCache()`, `nxCache()`, the
    CLI), `@vzn/vx-prune` gone, the Turbo build sets and wide sets
    benched, then the Nx round — query, strapi, novu, router, refine,
    five repos, every one on the repo's own worker count with the
    task sets proven identical by `--graph` against `--dry=json` —
    and what the round taught core and the mapper: `--mjs` output
    (145), one output path per cached task at migration time (146),
    run-commands' cwd and placeholders (147), the watch arm instant on
    the mtime clock (148), a workspace peer as an order edge unless it
    closes a cycle (149, the one core graph change of the day, A/B'd
    a tie), Nx 23's per-user cache pinned by the harness (150), a
    hidden output directory as its subtree glob (151), and the
    real-repo no-op profiled to its floors (153). Open: Next 16 above
    (overlapping outputs, with its rewrite catch), Next 1 and 2 as
    before. The box: four cores, a 13.3 GiB cgroup, no sandbox (the
    gate runs as `scratchpad/gate-manual.sh`), Node 22.22; a chain of
    benches survives a turn boundary only under `setsid` from a plain
    shell, and every `pkill -f` pattern must not appear in its own
    command line. Never end with "what next?".

14a. **Handoff after item 130 (2026-09-10, late night).** PR #293
merged the landing page's first delivery (a layer over the old
page); the owner asked for a full redesign, and PR #294 carries it
(item 125, the film) with the loop that followed: the `project`
stage's context names every package core discovered (126, the
Turbo plugin's second discovery gone, −12 ms per 1,000), one Turbo
mapping per run so a watch cycle sees a script edit (127),
`vx watch` on a `vx.workspace.*` edit (128), the mapping indexed by
name (129, a tie at the run level, recorded as one), and a package
added or removed under a running watch (130, the glob's directory
watched, the set re-armed). Every one is pinned with a
differential; the piecewise gate ran here (this container cannot
host the sandbox) and CI was green on every head it had run by
the time of writing. Method that paid tonight: read one arm of a
feature for the file it cannot see (the workspace config, the
package directory, a plugin's memo), probe it end to end in the
scratchpad, then pin. What is still no event under `vx watch`, by
choice and in the docs: a root `turbo.json` edit (no seam names a
plugin's root files — a second consumer makes it one), a package
added under a glob of another shape than `<dir>/*`, and the
watcher shape when a new package declares the first
`workspaceFiles` input. Refuted on the way: `vx why` and `vx show`
on a config-less package whose task a `project` plugin gave it —
`why` reads the run's history and explains the key with the
changed input, `show` lists the task as "from plugins" (probed in
the scratchpad, 2026-09-10; nothing to pin, the read verbs never
load the config `why` would need). Learned on PR #295's red:
`oxfmt --check <file>` passes what `oxfmt --check .` rejects (a
code span wrapped across an indented line), so the gate's format
check is the directory scan from the package, never a named file
(CLAUDE.md). Refuted 2026-09-11: shipping plugins prebuilt to
save the transpile on import — on the compiled binary the
`workspace config` stage reads 9–12 ms with no plugin and 12–14
with `turbo()` imported from source, ~2 ms for a build step in
every plugin package. Left: the zero-migration
stage's remaining 20 ms per 1,000 (the overlay probes, two clones
per fill, a re-validation per plugin) if a workspace that size
ever runs without configs. Never end with "what next?".

15. DONE 2026-09-11 as items 142–144, 150 and 152 — five Nx repos
    (query, strapi, novu, router, refine), the owner's 3–5. Was: **More Nx repos.** The five Turbo build sets, the two wide sets
    (item 141) and four Nx repos (items 142–144, 150) are in.
    Both gaps from the first Nx repos (item 142) are closed: `.mjs`
    output is item 145, two targets on one output path item 146. Then the harness on more
    Nx repos (owner: 3–5 popular ones; only
    `nx:run-commands`, `nx:run-script`, a plain `command` and
    `nx:noop` targets are supported, anything else is out): the
    remaining candidate was storybook (483 targets inheriting a plain
    `command`; its placeholders and root cwd map since item 147): its
    install does not fit this box — the fetch step filled the 6 GB
    left on the disk with the yarn cache alone (ENOSPC, 2026-09-11) —
    so it waits for a bench host with room; redwood is dropped — its
    `build` declares no outputs, so Nx's cache replays the log and a
    restore arm restores nothing under either tool (REPOS.md). Parity
    is the task graph as above.

16. **Two cached tasks on one output path, when one depends on the
    other.** Two of the five Nx repos have it: strapi's `build:types`
    and refine's `types` write `dist/**/*.d.ts` into the `dist` their
    package's `build` fills, and both declare `dist` as the output of
    both targets; Nx caches both, vx leaves the dependent one uncached
    (item 146 resolves the overlap at migration time). What blocks it
    is the clean: vx removes a task's declared outputs before it runs
    and before a restore, so a `types` miss under a `build` hit would
    delete the `dist` that `types` reads. A design that admits it:
    when B's outputs overlap A's and B depends on A, B's own output
    set is the files its run ADDED or CHANGED (a snapshot of the
    overlap before B runs, diffed after — size + mtime, the proof the
    hit path already trusts), B's clean removes only that set, and B's
    artifact holds only that set; the restore order follows the edge.
    Cost: one stat walk of the overlap per B miss, none on a hit. The
    catch, seen while writing this: refine's `types` ADDS nothing —
    `build` is `tsup && node ../shared/generate-declarations.js` and
    `types` is the second half again, so it REWRITES `build`'s `.d.ts`
    files with the same bytes and new mtimes. Under the design above
    B's own set is empty (same bytes) but A's proof is size + mtime,
    so the next no-op finds A's outputs moved and restores them — a
    restore where there was nothing to restore, every run. Either the
    proof compares content for files a downstream task touched (a hash
    per overlapped file, the cost the proof avoids by design), or a
    rewrite-in-place stays refused and only additions are admitted.
    strapi's `build:types` (tsc into the `dist` rollup filled) is the
    addition case; refine's is the rewrite. Not started; do it if a
    third repo shows the addition shape, with the design note first
    (`docs/design/`), and leave the rewrite refused.

## Decisions (this arc)

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
