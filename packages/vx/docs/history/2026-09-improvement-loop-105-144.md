# Shipped, 2026-09 — improvement-loop items 105–144

The record `docs/STATUS.md` carried until 2026-09-16, moved here whole
so the handoff stays readable. Nothing below is current state: STATUS
holds direction, what is in flight and what is next; this file holds
what shipped and the numbers behind it. Items 1–64 are in
`2026-09-review-arc.md`, items 65–104 in
`2026-09-improvement-loop-65-104.md`, items 145–202 in
`2026-09-improvement-loop-145-202.md`, items 203–242 in
`2026-09-improvement-loop-203-242.md`; items 243–281 in
`2026-09-improvement-loop-243-281.md`, items 282–305 in
`2026-09-improvement-loop-282-305.md`, items 306–332 in
`2026-09-improvement-loop-306-332.md`; items 333–352 in
`2026-09-improvement-loop-333-352.md`; items 353–372 in
`2026-09-improvement-loop-353-372.md`; items 373–392 in
`2026-09-improvement-loop-373-392.md`; items 393–412 in
`2026-09-improvement-loop-393-412.md`; items 413–432 in
`2026-09-improvement-loop-413-432.md`; items 433 onward continue in
`docs/STATUS.md`.

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
