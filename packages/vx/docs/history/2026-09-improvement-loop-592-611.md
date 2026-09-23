# Shipped, 2026-09 — improvement-loop items 592–611

The record `docs/STATUS.md` carried until 2026-09-23, moved here whole
when the loop reached twenty entries (item 612; 612 itself opens the next loop). A PREFIX,
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
`2026-09-improvement-loop-573-591.md`; items 612 onward continue in
`docs/STATUS.md`.

592.  DONE (2026-09-22, the simplification 590 and 591 invited, and the
      trim the loop reached twenty at). `turbo()` and `nx()` carried the
      same skeleton — the per-run mapping memo keyed on `ctx.projects`,
      the warn-once, the fill-never-overwrite loop — twice; it is
      `src/adoption-plugin.ts` now (`adoptionPlugin(import.meta, mapRun)`)
      and each plugin is the one call that says how its mapping is made.
      The turbo and nx suites pass unchanged (122). The real-tree dogfood
      of the EXECUTOR path was tried and dropped: nrwl/nx-examples needs
      yarn 4 and the proxy's policy refuses repo.yarnpkg.com (403),
      `create-nx-workspace` generates but its npm install dies on npm's
      `edgesOut` null read; the live suite against Nx 22 (`@nx/js:tsc`
      through `nx-exec`, in CI since 590) stands as the proof. Items
      573–591 moved to `docs/history/2026-09-improvement-loop-573-591.md`
      and handoffs 14aq–14au to the next-log file in this commit.

593.  DONE (2026-09-22, the number 14av owed and the defect it found).
      `nx()` at 1,000 projects on the bench workspace (real Nx 22,
      `@nx/js:tsc`): the export runs once, 1.73 s with the daemon off;
      after it the whole `load configs` stage reads 61 ms against ~24 ms
      for evaluated configs — the 2,001 stats and the mapping are ~37 ms,
      the turbo mapping's size (42 ms, 2026-09-10). The defect: an Nx
      output outside the project dir (`dist/<project>` at the root, the
      DEFAULT `@nx/js:tsc` layout) was a todo, so all 1,000 `build`
      targets cached with no outputs and a hit restored NOTHING under a
      green run. It is a `workspaceFiles` output now; proven on the bench
      by `rm -rf dist` then a hit that brings `dist/packages/p1` back,
      and pinned in `migrate.test.ts`. Also: with the plugin loaded by
      path there is no `node_modules/.bin/nx-exec` and every executor
      task died `not found` (exit 127) — the plugin warns once naming
      the devDependency; row in `nx.test.ts`. The real `@nx/js:tsc`
      executor ran through the plugin end to end here (1.5 s miss,
      0.2 s hit), which is the executor-path dogfood 592 could not get
      from a cloned tree.

594.  DONE (2026-09-22, the persona walk of the Nx guide 14av asked for,
      read as an Nx user would). Five gaps in `migrate/from-nx.md`: no
      install line before the workspace file (the plugin's bin is what
      runs executors, so `@vzn/vx-migrate` is a devDependency, not a
      transitive read); a table row that said a configuration suffix is
      dropped, written before configurations were tasks (590); no word
      that a root `dist/<project>` output is `workspaceFiles` (593); "no
      Node" claimed while an `nx-exec` line exists; no
      `nx run app:build:production` row. One was a mapper improvement:
      a `project:target:configuration` edge reaches the configuration's
      own task now (`pkg-b#tool:ci`), the default configuration's edge
      the base task, and only a configuration the target does not
      declare falls back with a todo naming it — the colon-fixture rows
      in `migrate.test.ts` cover all three.

595.  DONE (2026-09-22, the Turbo guide walked the way the Nx one was,
      594). Smaller findings, the guide being the older and better-worn
      one: the install line sat after the workspace file it is needed
      for; the "generated" `test` sample showed a narrowed input list the
      mapper never writes (no `inputs` is `**/*`, Turbo's default, and
      the sample says so now); "no `commands` array" is an Nx notion, so
      the one-command bullet says what a Turbo user needs instead — the
      script body with its `pre` / `post` hooks folded in; and
      `--continue` and `--output-logs` had no command rows. No mapper
      change; the pins on that page (its key table, the `--continue`
      semantics) still hold.

596.  DONE (2026-09-22, a pointer 590 made stale). `vx init` on an Nx
      workspace named one way to use it, the migration; the turbo.json
      note has named both since 2026-09-09. It names `plugins: [nx()]`
      too now, and the init suite's Nx rows pin the mention beside the
      note (both ways, as the Turbo row is pinned).

597.  DONE (2026-09-22, a speed-up with no config, no env and nothing
      in a key). `nx-exec` enables Node's on-disk compile cache in its
      own process before `nx` loads (`module.enableCompileCache`,
      22.1+, a no-op below; the default dir under `os.tmpdir()`); Nx's
      module graph is ~150 ms of every executed task's ~220 ms floor.
      Fair A/B on the bench workspace, the same bin with the cache
      disabled through `NODE_DISABLE_COMPILE_CACHE=1` against enabled,
      interleaved min-of-15 on a `run-commands` noop: 243 → 214 ms min,
      272 → 233 median. The fake and live suites pass unchanged. Also:
      the parity map gained the `nx run app:build:production` row
      (594's configuration tasks), pinned to `nx.test.ts`.

598.  DONE (2026-09-23, the last three pages a reader with an Nx repo
      lands on that named only `turbo()`: the introduction's package
      list, the plugins guide's consumers paragraph and the
      add-to-existing page's "running alongside" section, which now
      offers the whole-repo path through `turbo()` or `nx()` before
      the package-at-a-time one). Handoff 14aw.

599.  DONE (2026-09-23, the `vx watch` walk 14aw asked for, on the
      bench workspace with real Nx 22, daemon off). `vx watch noop
--filter @bench/p0`, then a `project.json` edit that changes the
      target's command: the cycle fires on the file ("@bench/p0
      project.json; re-running"), the plugin's stat rule sees it newer
      than the snapshot and re-exports the graph inside that cycle, and
      the NEW command runs — 1.3 s from the edit to its effect, Nx's own
      daemon-less export of the 1,000-project tree being most of it.
      One thing the walk taught the probe, not the code: an
      `nx:run-commands` target runs from the workspace root, as Nx runs
      it and the mapper's `cd` preserves, so a relative path in the
      command lands there. No change; the README's `nx()` section says
      what a cycle costs.

600.  DONE (2026-09-23, the read-only verbs walked on the `nx()`
      workspace: `vx info`, `vx show <project>`, `vx why`). Nothing off:
      info names the plugin and its stage, show prints the `nx-exec`
      lines with the folded default configuration, `**/*` inputs and
      the `workspaceFiles` output, `why` asks for a recorded run as it
      should. One thing a reader will meet and the README now says: Nx
      injects an `nx-release-publish` target into every project with a
      `package.json`, so it is one `nx-exec` task per package here too
      (3,000 tasks for 1,000 projects in `vx info`), run only when
      asked.

601.  DONE (2026-09-23, a stage the timing table mislabelled). A dry
      run's plan — every task's hash, the cache lookups, the history
      p50s — had no mark of its own, so it was booked under `close`,
      the next one: 105–117 ms of "closing a cache" at 1,000 projects,
      against 1–3 ms in a real run, which is what the read-only walk
      (600) turned up. `planRun` marks `plan` now; the same dry table
      reads plan 116 ms, close 0.4 ms. `timing.md` lists the stage and
      `timing-dry.test.ts` pins the row. The plan's cost itself is the
      real run's classify-and-probe cost, 0.08 ms of hashing per task
      plus one index lookup, and stays.

602.  DONE (2026-09-23, noise a plugin user reads on every run). The
      readiness note a persistent task carries — "add `readyWhen` to
      gate dependents" — is moot for a task nothing depends on, and
      refine printed it for 375 `dev` and `start` targets a run, none
      anyone's dependency. Both mappers now run `persistent-note.ts`
      last, over the whole mapping (a dependent may sit in another
      package): the note stays only on a persistent task some
      `dependsOn` names (`x`, `^x`, `pkg#x`). Rows in the turbo, nx and
      migrate suites, each with the dependent as its control; the
      migration's clean count moved with it (a dependent-less server is
      clean). On refine the run prints nothing now but the tasks.

603.  DONE (2026-09-23, the migration path on the real Nx 22 install,
      which only fixtures had exercised since `nx-exec` lines replaced
      the placeholders in 590). `bunx @vzn/vx-migrate --from nx` on the
      bench workspace reads Nx 22's own cache-file shape, writes one
      `vx.config.ts` per package with the `nx-exec @nx/js:tsc …` line
      and the `workspaceFiles` output, and with the plugin's workspace
      file moved aside — core's floor alone — `vx run build --filter
@bench/p1` compiles through the written config (1.3 s, real tsc)
      and the next run restores `dist/packages/p1` from the cache. No
      change; the record that both adoption paths run the same
      executor line end to end.

604.  DONE (2026-09-23, a mode the index carried since the package's
      first commit). `packages/vx-migrate/src/bin.ts` — the `vx-migrate`
      bin — was 100644 in git while core's `bin.ts` and the new
      `nx-exec.cjs` were 100755: npm sets the bit on install, so a
      published bin works, but the shim `bun link` or a workspace
      install writes would have failed with EACCES. Fixed in the index,
      and a repo-wide law pins it: `tests/bins-executable.unsafe.test.ts`
      finds every `bin` a package.json declares and requires mode
      100755 and a shebang — red on the old mode, green after, both
      shown.

605.  DONE (2026-09-23, the Turbo twin of 603, on a fresh shallow clone
      of withastro/astro with nothing installed). `bunx @vzn/vx-migrate
--from turbo --dry` reads turbo.json and 562 workspace packages
      (the integrations' test fixtures are packages too, as Turbo sees
      them) and reports the known gaps — the negated `!vendor/**`
      output, `build:ci` sharing `dist/**/*` with `build` and running
      uncached with the edge hint from 588; the write lands 115
      configs and the workspace file, and `vx run build --all --dry`
      plans 249 tasks through them with no install and no plugin.
      Nothing off; the clone was restored after. No change.

606.  DONE (2026-09-23, a simplification with no behaviour in it). The
      Nx mapper's `buildTask` was a 300-line body carrying four concerns
      — input expansion with its named-input recursion, output mapping
      with the `{options.x}` and workspace-root rules, edge mapping with
      the colon and configuration rules, and the task's assembly. The
      first three are `nx-inputs.ts`, `nx-outputs.ts` and `nx-deps.ts`
      now, each a pure function over the target's field with the todos
      it owns, and `buildTask` is the assembly alone (about 90 lines;
      `nx-map.ts` 737 → 527). The migrate, nx and shared-outputs suites
      pass unchanged, which is the proof a move needs.

607.  DONE (2026-09-23, three rules the night taught, in CLAUDE.md's
      "learned the hard way" list so the next session does not relearn
      them): a new timing mark is pinned in source order and as a bare
      list item (601 cost two gate runs); an `nx:run-commands` target
      runs from the workspace root, so a probe looking under the
      package dir finds nothing (599 cost one); a bin's mode lives in
      the index, `git update-index --chmod=+x`, and the law of 604
      holds it.

608.  DONE (2026-09-23, the mapping profiled and one hoist). A CPU
      profile of `mapNxWorkspace` at 1,000 projects put `path.relative`
      and its wrapper first: `buildTask` recomputed the project's
      relative dir and read its scripts per task AND per configuration
      variant, 3,000 times for 1,000 projects. Once per project now. In
      isolation the warm mapping halves, 30.5 → 15 ms per call
      (min-of-3 in one process, the 1.8 MB snapshot parsed once in
      7 ms); at the stage level the interleaved A/B on this box reads
      old 59.7 ms against new 57.4 ms min-of-6 — a tie by the box's
      own rule (nothing under ~6 % resolves here), because the stage's
      cost is the 2,001 stats, the parse, the first cold call and
      3,000 `structuredClone`s as much as the mapping. Kept for the
      isolation number and the simpler shape; the README's "about
      37 ms" stands.

609.  DONE (2026-09-23, the clone the per-process memo left behind).
      The adoption skeleton copied every mapped task with
      `structuredClone` before handing it to the stage — "the mapping
      outlives one run", the comment said, which stopped being true
      when the memo went per run on 2026-09-10 — and 3,000 clones cost
      10 ms per run at 1,000 projects, measured directly (three reps:
      12.8, 10.2, 9.8 ms), more than the mapping hoist of 608 bought.
      Core only reads a stage-given task after validating it
      (`validateProjectConfig` writes nothing back; the one
      `normalizeGlob` feeds a predicate), and a run's mapping is its
      own, so the object goes in as it is now. The turbo and nx suites
      pass, the watch-shape row (a script edited between two runs in
      one process is the second run's command) included.
610.  DONE (2026-09-23, the profile that closes the plugin-cost arc).
      `bun --cpu-prof` on `vx run noop --all --dry` at 1,000 `nx()`
      projects, warm. The first profile's top frames were `lstat` under
      `isInputOnDisk` — an artefact: the scratch workspace was not
      git-tracked, so every file was "untracked" and stat'd. With the
      tree committed the same run samples 232 ms with no core hot spot:
      the widest frames are the plugin's mapping, `sort`, `resolveFiles`
      (cache/inputs.ts) and `JSON.parse`, each a few percent. Stage
      rows: load configs 55.8–72.6 ms, git enumeration 8.3–14.5 ms, plan
      54.4–73.1 ms. For scale: the same workspace under `turbo()` reads
      44.7–56.4 ms at the stage and a plain configless load is
      0.7–1.3 ms. Nothing here is a warm-path item; the README's stage
      number is refreshed to what 608 and 609 left (about 30 ms over
      evaluated configs). Rule kept: a profile of a scratch tree is a
      profile of the untracked case unless the tree is in git.
611.  DONE (2026-09-23, the exports nobody imports). A sweep of every
      `export` in the plugin packages against every other file: 21
      symbols were used only inside the file that exported them (the
      `export` keyword goes — `readVarintAt`, `strAttr`, the Nx and
      Turbo mapper's row types, the adoption skeleton's mapping shape)
      and one was used nowhere — `encodePathList` in `@vzn/vx-otel`,
      whose comment promised output paths as JSON when the task
      attribute has carried only `deferred` since the outputs went
      deferred (a comment claiming a guarantee the code lacks). Core
      had none. REFUTED alongside, for the per-task Nx cost: `nx-exec`
      spends 125 ms of its 218 ms floor loading Nx, and 65 of those are
      Nx's `analytics` module (208 modules) plus 27 its daemon client,
      neither used by an executor run — but the executor resolver
      (`getExecutorInformation`) needs `project-graph/plugins`, 310
      modules and 81 ms by itself, so a path around `runExecutor` would
      load the same graph (112 against 128 ms, measured); and Nx's
      `native` addon rules out a Node startup snapshot. The floor is
      Nx's own.
