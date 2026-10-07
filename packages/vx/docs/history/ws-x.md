# Workstream X — the improvement loop (2026-10-06)

The owner's ask: keep improving vx until they return, one small PR at a
time (bugs, correctness, simplification, the plugin seams).

- **X-1.** A `graph` hook's edit to a task's `config` was not checked:
  `config.exec = { comand: … }` ran an empty command that failed with
  exit 1 and no reason, while the design (rule 2) says core re-validates
  `graph` like `project`. Each node's config is now validated after
  each graph plugin, and the refusal names the plugin and the field.
  Row: `plugin-pipeline.test.ts` › "a task config a plugin breaks is
  refused, naming the plugin and the field".
- **X-2.** A command ending in a newline (a template literal's closing
  line) ran the args after `--` as a command of their own:
  `--watch: not found`, exit 127. They now go on the last line, after
  trailing blanks are dropped, unless an odd run of backslashes ends the
  command. Rows: `runner.test.ts` › `withForwardArgs`.
- **X-3.** With `packages/**` listing `packages/inner` (its own
  `workspaces: ['sub']`) and `packages/inner/sub`, a run from `sub`
  resolved to `inner` while one from `inner` resolved to the outer root:
  two roots, two caches, and `sub`'s `^` edges into the outer workspace
  dropped from its key. An outer root that lists both the claimer and
  the member now owns it. Rows: `workspace-nested-root.test.ts`.
- **X-4.** Every path under any `node_modules` left the input set, so a
  committed fixture (`tests/fixtures/node_modules/dep/index.js` under
  `tests/**`) never entered the key and an edit to it replayed the old
  output. The enumeration now drops an UNTRACKED file there (an install,
  ignored or not) and keys a tracked one; `--affected` reads the same
  rule. Rows: `inputs-resolution.test.ts` › "node_modules: untracked is
  an install, tracked is a source", `affected.test.ts`.
- **X-5.** An output directory that is a symlink to another directory in
  the same project (`public -> static`, `outputs.files: ['public/**']`)
  had the clean before every run and restore delete the tracked
  `static/*` through it: containment only asked that the real directory
  be inside the project. The clean now removes nothing whose directory
  is reached through a link; the save still follows one
  (turborepo#13042). Superseded by X-88: a link inside the project is
  cleaned through; one out of it is still never deleted through. Row:
  `inputs-resolution.test.ts` › "a recorded row is never removed through
  a link that leaves the project (X-5)".
- **X-6.** A config with two syntax errors (`export default {{`)
  reached the user as an `AggregateError` stack with no position, and
  `vx watch` leaked the internal `?vx-held=` query. The first error is
  now reported like a single one, `file:line:col: message`. Row:
  `project-loader.test.ts` › "two syntax errors name the first one".
- **X-7.** A file `dist` where a restored entry needs a directory was
  reported as "a directory standing where the entry holds a file", with
  the code doubled (`EEXIST: EEXIST:`). The message now names the case
  the code means, once. Row: `artifact-roundtrip.test.ts` › "names a
  STRAY on disk as such".
- **X-8.** `--affected` judged a changed root path against
  `workspaceFiles` with its own copy of the key's matcher, which lacked
  `ALWAYS_IGNORE` and the task's own `outputs.workspaceFiles`: a change
  to either selected a project whose key it leaves unchanged. The copy
  (`workspaceGlobsMatch`) is gone; selection asks `declaresInput`. Row:
  `affected.test.ts` › "reads a glob as the key does".
- **X-9.** With no `project` plugin a package with no vx config was
  never loaded, so it never got the default `build` and a dependant
  that bundles its source (`dependsOn: ['^build']`) replayed stale
  output after an edit to it, while `--affected` selected the
  dependant. A loaded project's closure now loads such a package as
  `{ tasks: {} }`; `'all'` seeds stay the config-bearing ones, and
  `vx show <it>` marks `(no vx config)` above its default build. Row:
  `configless-default-build.test.ts`.
- **X-10.** `--affected --filter other` ran only what the diff reached:
  the projects were a union, but the run then kept only reached tasks,
  so `other` was dropped with exit 0 ("no affected project declares
  …" when nothing changed in scope). The other includes' projects now
  pass as `RunOptions.selectedOutright` and keep their tasks; an
  exclude still removes them. Row: `affected-base-notes.test.ts` › "a
  `--filter` beside --affected adds its projects".
- **X-11.** An executor that resolved `exitCode: NaN` (or `1.5`, `-1`)
  passed the result check, printed `failed (exit NaN)` and failed the
  run history's write. The check now wants a non-negative integer
  exit code and a non-negative finite duration. Row: `executor.test.ts`
  › "an exitCode or durationMs that is a number but no count".
- **X-12.** Args after `--` were appended to a heredoc's terminator
  (`X FWD`), so the heredoc never closed and the args never reached the
  command, exit 0. They now go on the last line that is a command, past
  heredoc bodies (`<<X`, `<<-'X'`). Rows: `runner.test.ts` ›
  `withForwardArgs` heredoc rows.
- **X-13.** `vx run //#build` with no root project hinted a member's task
  ("did you mean ui#build?"); it now says `//` is Turbo's root package
  and the workspace root is no project here; `*#lint` hinted `ui#lint`
  too, and now says to use `--filter '*'`. And `--filter --dry` took
  `--dry` as the pattern; a value opening with `--` is refused as a
  missing value. Rows: `root-project.test.ts` › "//#task with no root
  project says so rather than hinting a member", `cli.test.ts` ›
  "rejects missing flag value".
- **X-14.** `vx run build -- --watch` where `build` is a group ran its
  dependencies without the args and passed: a group takes none and the
  args reached nothing. A request whose tasks are all groups is now
  refused, naming them. Row: `forward-args-group.test.ts`.
- **X-15.** A `graph` hook that set a node's `deps` to `null` (or a node
  to `null`) was refused as "null is not an object (evaluating
  'n.config')". Each plugin's edit is now checked for shape first:
  "plugin 'p' failed in graph: a#build's deps is null, not an array of
  task ids". Row: `plugin-pipeline.test.ts` › "a graph hook that nulls
  deps or a node is refused naming the task".
- **X-16.** `--filter one --filter '!one'` refused with "no projects
  matched filter(s): one, !one", which reads as a typo of `one`. It now
  says the exclusion took back every match. Row: `cli.test.ts` › "an
  exclusion that takes back every match says so".
- **X-17.** With `.vx/cache` deleted, `vx cache prune` and `vx info`
  read no index and so no store: "0 entries" while every entry in
  `~/.vx/<id>/cache` stayed restorable. And the zero-policy refusal told
  the user to delete the cache directory, which leaves the store. Both
  now open the store a run would; the refusal names the store. Row:
  `shared-store.test.ts` › "prune and info reach the store with the
  index deleted".
- **X-18.** `vx why build` from inside `packages/a` refused "ran in 2
  projects" where `vx run build` there picks `a#build`; it now picks the
  cwd's project too. `vx why a#build --run zzz` said run zzz "has no
  row" for the task; it now says no run is recorded under that id. A
  config change's verdict read "config config". Row:
  `why-verdict.test.ts` › "names a config change once, scopes a bare
  name to the cwd, refuses an unknown run".
- **X-19.** A plugin key that names no hook (`excutor`, `setUp`) was
  never called and never said: tasks ran here with the plugin's executor
  unheard. The workspace schema now refuses it, hinting the nearest
  hook. Row: `config-schema-refusals.test.ts` › "a key that names no
  hook is refused, the nearest hinted".
- **X-20.** A plugin package whose `package.json` did not parse reached
  the user as `vx: SyntaxError: …` and a stack, naming no file;
  `definePlugin` now refuses it naming the file. Row:
  `plugin-name.test.ts` › "refuses a module with no package above it, and
  a package with no name".
- **X-21.** A plugin verb named `--version`, `--help` or `''` loaded
  cleanly and could never run: core reads a flag first, and an empty
  word is no verb. The workspace schema now refuses it. Row:
  `config-schema-refusals.test.ts` › "a verb no command line reaches is
  refused".
- **X-22.** `cacheDir: '   '` made a directory named three spaces at the
  workspace root, hidden by the cache's own `.gitignore`, and a
  `cache.inputs.runtime` probe of whitespace ran as a no-op that folded
  nothing into the key. Both are refused. Row:
  `config-schema-refusals.test.ts` › "a cacheDir or runtime probe of
  spaces is refused".
- **X-23.** A server `vx run` held in the foreground that exited
  non-zero failed the run, the summary and the report, but the history,
  written before the wait, said `ok` and `success`, and the flaky list
  read it. Such a run's history is now written after the wait. Row:
  `keep-alive.test.ts` › "a server exiting 1 tears the other down and vx
  exits 1".
- **X-24.** A persistent task whose readiness timeout fired reported
  `exit 1`, a code nothing exited with; an ordinary timeout reports the
  kill's 143. It now waits for the server's death and reports its code
  (143, or 137 after the grace). Row: `persistent-ready-timeout.test.ts`
  › "never-matching readyWhen + timeout → run fails fast, child is
  killed".
- **X-25.** `--report` on a Ctrl-C'd run said `failed`, called a task the
  stop reached before it ran `aborted`, and left the killed task's time out
  of its total, while the terminal said `aborted` / `not run`. Now the
  heading is `interrupted`, the status is `aborted` or `not run`, the header
  ends `not counted: 1 aborted, 1 not run`, and the total holds the aborted
  task's time. Row: `run-report.test.ts` › "renders an interrupted run,
  byte for byte".
- **X-26.** One broken config zeroed every other project's
  plugin-given tasks in `vx info`: the fallback count skipped config-less
  projects and loaded configs without the `project` stage. A config with
  two syntax errors read `2 errors building …`, not the line `vx run`
  stops on, since the repeat load's worker did not unwrap the
  AggregateError. The fallback now runs `loadProjects` per project, and
  the worker reports the first error. Row: `info-syntax-error.test.ts` ›
  "counts the other projects as vx run does and names the error vx run
  stops on".
- **X-27.** A second `vx init` said the root it had mapped was left out
  because "its scripts run the workspace", and its `kept` list omitted
  the root's config: a root with a config never maps (D-45), so it fell
  to the not-mapped note. Such a root is now listed as kept, with no
  note when its scripts would map, and the note's reason is judged on
  its own scripts. Row: `init.test.ts` › "a second vx init keeps the
  root it mapped, with no note on it (X-27)".
- **X-28.** `vx init --plugin <seam> --mjs` ignored `--mjs`, wrote a
  `.ts` plugin, and told a workspace with `vx.workspace.mjs` to declare
  it in `vx.workspace.ts`. The templates are TypeScript, so `--mjs` with
  `--plugin` is now refused, and the hint names the workspace file a run
  reads. Row: `init.test.ts` › "names the workspace file that exists and
  refuses --mjs (X-28)".
- **X-29.** `vx last --list 1.5`, `--list abc` and `--list 2 extra`
  each said "a run id and --list do not combine": the space form took
  only a bare integer as its count. It now takes any next argument that
  is no flag and no run id (eight hex digits at least), so a bad count
  is refused as one, and a word beside `--list` no run id could be is an
  unexpected argument. Row: `last.test.ts` › "--list takes a bad count
  as its count, and an extra word is unexpected (X-29)".
- **X-30.** A project output under a top-level `workspace-outputs/`
  saved fine, but the artifact index read it back as a workspace
  output, so every hit was a "corrupt artifact", dropped and run again.
  The name is the artifact's namespace for `outputs.workspaceFiles`; a
  project output glob under it is now refused at load. Row:
  `config-schema-refusals.test.ts` › "an output glob under the reserved
  workspace-outputs/ is refused (X-30)".
- **X-31.** A `!` input entry subtracts wherever it sits, so
  `['src/**', '!src/gen/**', 'src/gen/keep.ts']` never keyed `keep.ts`
  and an edit to it replayed the old output under a green run. Such a
  literal is now refused at load, in `files` and `workspaceFiles`;
  `turbo()` and `nx()` drop it (dead in Turbo and Nx too), so an
  unchanged repo still runs. Rows: `config-schema-refusals.test.ts` ›
  "a literal input a negation takes back (X-31)",
  `vx-migrate/tests/taken-back-literal.test.ts`.
- **X-32.** An additive task that removed a file its upstream wrote (a
  bundler deleting its intermediate) saved only what it added, so every
  warm hit left the removed file: the upstream's restore put it back and
  the dependant's rows never took it away. Now a run that removed a file
  it found saves nothing and runs again. Row:
  `overlapping-outputs.test.ts` › "its removal is never undone by a hit:
  the dependant saves nothing and re-runs".
- **X-33.** An additive task's own set was judged by size and mtime, so a
  rewrite of its upstream's file to bytes of the same length with the
  mtime stamped back was not its own, and every warm hit left the
  upstream's restored bytes. Its comment called that the hit path's proof,
  which item 886 had already widened. Now the stamp is size, mtime, inode
  and ctime, as `isOutputsCurrent` checks. Row:
  `overlapping-outputs.test.ts` › "the rewrite is the dependant's own, so a
  warm run leaves its bytes".
- **X-34.** A task whose `cache.inputs.runtime` probe read an upstream's
  output, with a key that folded no key of that upstream (`tasks: []`),
  was classed stable: its key was taken up front, before the upstream
  wrote, and the run's probe memo served that answer again to the
  re-check, so seeds A, B, B, A replayed B on the fourth run. Item 750
  had pinned that as the contract. Now such a task
  (`probesAfterWrites`) takes no key up front, is never restore-tier,
  and its probes run for it alone after its upstream finished; a probe
  whose key folds the writer keeps the shared answer. Row:
  `in-run-writes.test.ts` › "seeds A, B, B, A build A, B, B, A: a
  project probe waits for the upstream".
- **X-35.** `CACHE_VERSION` `vx-cache-v40`. X-32, X-33 and X-34 each
  fixed a run that stored wrong bytes under a key that does not change:
  an additive task's entry that a hit replayed over a file the task had
  removed, one that missed a same-size rewrite, and a runtime probe
  answered before its upstream wrote. Entries saved before them could
  replay that output, so every cached task misses once and re-saves.
- **X-36.** `VxPlugin.cache`'s doc said the first plugin cache wins; every
  contributed layer is kept and chained in declaration order (a lookup
  walks them until one hits, a save reaches each), as `ChainedCache`
  does. Doc only.
- **X-37.** `vx watch <task> --affected` judged every cycle against the
  diff it read at start, so an edit to an input the startup diff left
  out never ran the task. Now only the initial run reads the diff; a
  later cycle runs the requested task across the scope fixed at start
  and the cache keys decide. Row: `watch-affected.test.ts` › "an edit
  after the start runs the task the startup diff left out (X-37)".
- **X-38.** `vx watch` took its watched projects from the bare tasks'
  scope alone, so `vx watch lib#build` watched every project and
  `vx watch test other#test` run in `lib` never heard an edit in
  `other`. The scope is now the bare tasks' scope plus each `pkg#task`'s
  project, and only those when every task is anchored; the empty-scope
  refusal waits for the initial run, so an unknown `pkg` still gets its
  "did you mean". Rows: `watch-anchored-scope.test.ts` (X-38).
- **X-39.** With only `pkg#task` names, `--filter typo`,
  `--filter '[badref]'` and `--affected=badref` were never resolved, so
  the typo ran in silence; beside a bare task the same flags refused the
  run. The filters are now resolved first, refused alike, and their
  scope dropped as before. Row: `task-selection.test.ts` › "only
  pkg#task args still refuse %p as a bare task beside them does (X-39)".
- **X-40.** `--affected` seeded every uncached task of a project that
  owned a changed root `workspaceFiles` glob, so a `shared/` edit that
  re-keyed `app#build` alone also ran `app#lint`, which reads nothing
  there. An uncached task now seeds only when a changed path lies in its
  project or the project is reached whole. Row:
  `affected-workspace-files.test.ts` › "a root file one task reads does
  not seed its project's uncached task (X-40)".
- **X-41.** With `-- args`, a frame's `$ <command>` line showed the
  config's bare command though the task ran with the args, in `vx run`
  and every `vx watch` cycle. The logger now gets the run's
  `forwardArgs` and a requested task's line renders them shell-quoted
  through `withForwardArgs`, as they ran; a dependency's line has none.
  Row: `forward-args-frame.test.ts` › "the requested task's frame shows
  the args it ran with (X-41)".
- **X-42.** `vx watch` on a root project watched its whole tree, so an
  edit inside a nested project the root's key leaves out ran a cycle.
  Both arms now drop a path inside a configured project nested under a
  watched one (`makeFence`), save that project's own config, which
  moves the boundary; a config-less package fences no key and stays an
  edit. Rows: `watch-nested-boundary.test.ts` (X-42).
- **X-43.** A user's edit to a git-ignored file counts under a project
  with an uncached task (item 947), and that test was a plain directory
  prefix: an ignored file inside a configured project nested under such
  a root ran the root's cycle. The judgement now applies the X-42 fence.
  Row: `watch-judge-fence.test.ts` (X-43).
- **X-44.** `vx reset`, cli.md's zero-bound note and the migrate guide's
  `nx reset` row said to remove the cache directory to drop the whole
  cache, but entries live in the shared store (`~/.vx/<id>/cache`), so
  a reader who did so kept every hit. All three now say "delete the
  cache store `vx info` names", as the prune refusal does. Row:
  `nx-reset-hint.unsafe.test.ts` › "vx reset says it exactly; the guide
  row and cli.md say the same" (X-44).
- **X-45.** `vx last` printed the run's command and its "re-run what
  failed:" line with the args joined bare, so `-- "a b" 'c;echo X'`
  pasted back as three args and a second command. `vx run` now records
  each arg through `shellQuote`, which leaves a `#` past a word's first
  character bare (`app#build`); the secret mask also matches a value's
  `'\''` spelling, or a quoted value holding a `'` was stored plain.
  `vx watch` joined its args bare until X-49.
  Rows: `last.test.ts` › "the replayed command and its re-run line keep
  the args shell-quoted (X-45)", `invocation-secret-mask.test.ts`,
  `runner.test.ts` › `shellQuote` (X-45).
- **X-46.** `vx why` blamed `--no-cache / --force` for a re-run on an
  unchanged key whose previous run's cache save had failed, under a
  recorded `lR,lW` policy that shows neither flag. No row records a
  failed save, so the note reads its trace: a previous run that executed
  and succeeded with no entry holding the key says its save failed or a
  prune took it, or that its policy wrote no cache; past that, a
  recorded read policy says vx cannot name the cause, and only a run
  with no recorded policy names the flags. Row: `metrics.test.ts` ›
  "names why an unchanged key re-executed, from the evidence the index
  holds" (X-46).
- **X-47.** `vx show <task>`'s block claims every field the run reads
  but left out `exec.interactive` and `exec.env.secret`, so a task that
  holds the terminal or masks a non-secret-named variable showed
  neither. It now prints `env.secret` after `env.define` and
  `interactive: yes` / `no` after `persistent`. Row:
  `show-exec-fields.test.ts` (X-47).
- **X-48.** `vx show` listed a config-less package that a configured
  one depends on as `(no vx config)` and left it out of
  `vx show build`, while a run loads it for the dependant's `^build`
  and gives it the default `build` (and `vx show <it>` printed that
  build). `vx show` now loads each seed's package closure as a run
  does, and the list reads `1 task (no vx config; default build)`.
  Rows: `show-default-build.test.ts` (X-48).
- **X-49.** `vx watch` recorded its command with the args joined bare,
  so `vx last` showed `$ vx watch build --filter a*`, which a shell globs
  when pasted. It now records each arg through `shellQuote`, as `vx run`
  does (X-45). Row: `watch-loop.test.ts` › "the recorded command keeps
  its args shell-quoted, as `vx run` records them" (X-49).
- **X-50.** After a run of only group tasks (the default `build` of a
  config-less package), `vx why <it>` said "nothing has run here yet
  (vx run <it>, then vx why)": false, and the advice re-ran the group
  to the same answer, since a group records no task row. With an
  invocation recorded and no task row it now says no recorded run
  executed a task and to ask about one the group depends on. Row:
  `why.test.ts` › "vx why after a run of only a group (X-50)".
- **X-51.** Two tasks' output globs that overlap without either being a
  subtree holding the other's prefix went through: `dist/**/*.js` beside
  `dist/sth/**`, `dist/*.js` beside `dist/**/*.js`, `**/*.d.ts` beside
  `dist/**`, so each task's clean deleted the other's files under a green
  run. `outputsOverlap` now also builds a path under the deeper literal
  prefix ending in either glob's last segment, wildcards filled, and a
  path both match proves the overlap (M, 2026-10-07: two tasks never
  share an output). Only globs as written take part: a literal's `/**`
  twin met `dist/**/*.js` at a path no one can write. The path index
  pairs globs whose prefixes nest. Rows: `output-collision.test.ts` ›
  "refuses two globs a path both match …", "allows two globs no built
  path joins …" (X-51).
- **X-52.** Outside a git work tree `--affected` said "a shallow
  clone? Fetch history", and `--affected=<ref>` or `[<ref>]` printed
  `git rev-parse failed (exit 128)`; a repository with no commit yet got
  the shallow-clone line too. Once a base fails, vx now asks git whether
  there is a work tree and a commit, and says `vx requires git: … not
inside a git work tree` (one helper, `notAWorkTree`, shared with the
  input enumeration) or that there is no commit yet. A base that resolves
  spawns nothing more. Rows: `affected-base-notes.test.ts` › "outside a
  git work tree …", "a repository with no commit yet …" (X-52).
- **X-53.** Two tasks whose declared outputs overlap were allowed when a
  `dependsOn` edge ordered them (item 588's additive shape): correct, but
  each run of the dependant paid a stamp, a diff and a clean by rows. A
  workspace rule now refuses it, `rules: { exclusiveOutputs }` in
  `vx.workspace.ts`, on unless set to `false` (M, 2026-10-07: one path,
  one task; a rule that only buys speed is configurable, on by default).
  The refusal names the rule; off, the additive path runs as before. A
  pair with no edge is refused either way. `@vzn/vx-migrate` maps for
  the default: an edge-ordered task on a kept task's outputs now runs
  uncached with a todo. Rows: `output-collision.test.ts` ›
  "rules.exclusiveOutputs refuses an overlap WITH an edge (X-53)",
  `overlapping-outputs.test.ts` › "a run refuses the edge-ordered pair
  before any task runs (X-53)", `contract/config-schema.json` (the
  field's values and refusals) (X-53).
- **X-54.** A cached task whose input globs could match another task's
  declared outputs had a preliminary key: it was not probed, prefetched
  or restored ahead of the schedule and was keyed again once the producer
  ran (M, 2026-10-07: hash ahead of time, not as a waterfall). A
  workspace rule now refuses it, `rules: { upfrontKeys }`, on unless set
  to `false`: `inputs.files` against the same project's `outputs.files`,
  `inputs.workspaceFiles` against every `outputs.workspaceFiles` and
  every other project's `outputs.files` from the root. The fix it names
  is a `!` entry; the stability gate now leaves out an output the
  reader's own `!` entries take back whole, so `['**/*', '!dist/**']`
  beside a `dist/**` build is keyed up front. The gate stays, since the
  rule refuses only proven overlaps. Keys still wait on undeclared
  writes (`undeclaredWriteReach`, `commandWriteReach`), any upstream
  `outputs.workspaceFiles` (`dependsOnSiblingOutputs`'s
  `hasWsOutputUpstream`), runtime probes after a writer
  (`probesAfterWrites`), and a root-anchored output landing under a
  project-relative `inputs.files`, which the rule does not check. This
  repo's `vx` and `vx-docs` configs gain `!` entries for their gitignored
  outputs (keys unchanged). `@vzn/vx-migrate` writes the `!` entries,
  and a literal input another task writes runs uncached with a todo.
  Rows: `input-overlap.test.ts`, `stable-keys.test.ts` › "an output its
  own `!` inputs take back whole …", `local-shortcircuit.test.ts` ›
  "under rules.upfrontKeys a reader that takes the output back is
  restore-tier (X-54)", `contract/config-schema.json` (X-54).
- **X-55.** A task whose input entry its own outputs took back whole
  (a formatter declaring `src/**` as both) had its sources deleted by the
  pre-run output clean, a misleading "matched no files" warning, and a
  key that read nothing. The graph check now refuses it whatever the
  rules, naming the entry and saying an in-place rewriter declares no
  outputs. Rows: `input-overlap.test.ts` › "a task whose own outputs take
  back an input entry whole is always refused".
- **X-56.** `vx lock`'s refusal of a config that evaluated to a secret
  ended with a hint naming `$API_TOKEN` whatever variable leaked. It now
  names the first leaked variable. Row: `lock-secret.test.ts` › "the
  hint names the variable that leaked, not a fixed one".
- **X-57.** The key's and the output clean's fence held only the
  config-bearing projects, while `--affected` gives a changed path to
  the deepest project dir, config or not. A root `build` over `**`
  folded a config-less member's files, so its edit moved the root's key
  and `--affected` did not select the root (a CI gate went green past
  it); a root `outputs.files: ['**/*.js']` cleaned the member's tracked
  source. The fence (`prepare.ts`, the playground's planner and the
  watch loop's `makeFence`) is now every workspace project: a
  config-less package keys its own files under its default `build`
  (X-9), so a parent reaches them only through `dependsOn`, as for any
  project. A sandboxed root task's read of such a member is walled the
  same way. Keys move only for a parent whose globs covered one; the
  old key folded those files, so the new one differs and misses: no
  `CACHE_VERSION` bump. Supersedes the 2026-09 stance that a bare
  manifest under a project is part of it. Rows:
  `configless-fence.test.ts`, `watch-nested-boundary.test.ts` › "a
  nested project's config stays an edit; a config-less package's file
  is none (X-57)".
- **X-58.** With `rules.exclusiveOutputs` off, a task whose
  `outputs.workspaceFiles` overlapped a project task it already depended
  on, but with an entry outside that project, was refused with "or make
  one depend on the other". The refusal now names the entry outside the
  project. Row: `output-collision.test.ts` › "ordered, but with an entry
  outside the project, names that entry, not a missing edge".
- **X-59.** A persistent task pulled in only as a dependency booted on
  every run, and its cached dependants waited for it to be ready: a fully
  cached `vx run b#e2e` over `a#dev` (`sleep 2; echo READY`) took ~2.2 s
  and logged a boot per run. The scheduler now holds such a server
  dormant when nobody requested it and every dependant is a restore-tier
  hit; a demoted dependant starts it, otherwise it settles unspawned with
  no outcome once they finish. The fixture's warm run: 2150–2201 ms →
  156–187 ms (4 runs per arm), one boot in four runs instead of four. A
  same-project dependant still waits: the server's undeclared write
  reach keeps its key preliminary, and exempting it is a stale-hit
  question left open. Rows: `scheduler.test.ts` › "a persistent task
  only restore-tier hits depend on", `persistent.test.ts` › "a server
  only cached dependants pulled in is not started …".
- **X-60.** A script `vx init` folded with its `pre`/`post` hooks took
  forwarded `--` args as the function's positional parameters: under
  `vx run test -- foo bar` the body's `$1` was `foo` and its `$*` printed
  the args twice, and the hooks saw them too, where npm appends them to
  the script as text and no part sees `$1`. The fold now quotes them into
  a variable, clears the positional parameters, and evals the body with
  them appended. Row: `migration.test.ts` › "appends the args as text, as
  npm does: no part sees them as $1 (hunt 8)".
- **X-61.** A write grant for a directory not yet made was judged as a
  file, so its bind was its parent: in a single-package workspace
  `write: ['dist/']` (or `'dist/**'`) was refused for making `.git`
  writable, the message recommending `"dist/"` itself, and a nested
  project's `'../../coverage/'` the same. The outputs are now made before
  the walls judge the binds, and a refused grant's placeholders are taken
  back. Rows: `sandbox-request.test.ts` › "a directory grant not yet made
  is judged as the directory it names", "a refused file grant leaves no
  placeholder behind".
- **X-62.** A file added under a task's input glob while its command ran
  was read by the command and folded by nothing: the re-check before a
  save looked only at the files the key folded, so the output was saved
  under the old key and replayed as a green hit once the file was gone
  (`vx watch` too, through the same save). The save now also looks for
  an added input (`addedInput`): the listing's directories a glob
  reaches are `lstat`ed, one whose ctime moved since the listing is
  read, and a new matching name or unlisted directory is asked of
  `git ls-files`; a literal input absent from the key and present now
  is asked too. The entry is withheld with the changed-after-key line
  naming the file. Blind to a file added inside a directory that held
  no listed file and was not itself created mid-run. Cost on a forced
  1,000-task save run: `miss: recheck inputs` summed 28–37 ms → 59–65
  ms (~30 µs a save, no git spawn); warm run unchanged (min 1055 →
  979 ms, A/A 915, 15 rounds, noisy box). Rows: `inputs-moved.test.ts`
  › "an input file added during the run" (three rows and a control).
- **X-63.** A missing file under a write grant was counted as a
  violation, where one under a read grant is not: with
  `write: ['dist/']`, `cp src/in.txt dist/out.txt` failed on
  `openat(dist/out.txt) = -1 ENOENT`, since GNU cp opens its destination
  before creating it (tsc probes its buildinfo the same way). The strace pass now skips a
  miss under a mounted write grant too. Rows:
  `sandbox-runtime.unsafe.test.ts` › "a missing file under a write grant
  is no violation", "skips a miss under a write grant, and reports a
  sibling sharing its name prefix", "a miss under a write grant the
  sandbox could not mount is reported".
- **X-64.** `vx run all --verbosity 1` (a group task) printed
  `a#all success 0ms` in the per-task table, which the footer and
  `--report` leave out, and the table printed below the footer. The run
  now prints it (`RunOptions.summaryTable`, `formatOutcomeTable`) just
  above the footer, groups left out. Row: `cli.test.ts` › "--verbosity
  1: the table lists no group and prints above the footer".
- **X-65.** An output whose name holds a backslash (`dist/back\slash`,
  legal on Linux and macOS) never cached: the save scans its own
  artifact with the restore's name checks, and `assertSafeName` refused
  a backslash as a Windows separator, so every run printed
  `cache save failed`. vx runs on Linux and macOS only (Windows through
  WSL), where a backslash is a name character, so the refusal is gone
  and such a name lands literally inside the anchor. No `CACHE_VERSION` bump: no artifact
  with one was ever stored. Rows: `archive-security.test.ts` › "a
  backslash lands as a literal name inside the anchor",
  `artifact-roundtrip.test.ts` › "a space, a quote, a backslash and a
  non-ASCII name round-trip …" (now a hit, no save failure).
- **X-66.** `--affected` selected over the graph as configs declare it,
  before the `graph` stage ran: an edge a plugin added (`tool#build` onto
  `lib#build`) or an input it gave (`workspaceFiles`) moved a task's key,
  and the task was left out of the run. With a `graph` plugin the CLI now
  takes every project as a candidate once anything changed, and
  `prepareRun` runs the hooks before the selection, which prunes the
  final graph to the kept requests' closure (plus what a hook added or
  marked requested). A `workspaceFiles` match is asked of every node.
  Warm `vx run build test --affected` on 300 projects with no graph
  plugin, min of 30: 156 → 161 ms, tenth best 202 → 194 (noise). Rows:
  `affected-dependents.test.ts` › "--affected follows the graph a
  `graph` plugin leaves" (four).
- **X-67.** A Windows task glob loaded with only a "matched no files"
  warning: under `inputs.files: ['src\\**']`, `'C:\\src\\**'` or
  `'C:/src/**'` an edit to `src/` replayed the old output. A backslash
  separator or a drive in any task glob list (`inputs` / `outputs`,
  `files` / `workspaceFiles`, a brace arm included) is now refused at
  load with the forward-slash spelling to write; a backslash before a
  bracket, a brace, a `!` or a backslash stays an escape. Rows:
  `config-schema-refusals.test.ts` › "a backslash separator or a drive
  letter in a task glob".
- **X-88.** An output directory linked inside its project
  (`dist -> real-out`, `outputs.files: ['dist/**']`) was skipped by the
  clean (X-5) but followed by the save, so the entry for one key held
  the files another key's run left, and a hit for `one` left `two.js`
  beside `one.js`. The clean now follows a link whose target is inside
  the project, so the target is the output and each entry holds only its
  own run's files; one resolving outside the project refuses the task,
  naming the link (it used to save an empty entry under a warning, M-61),
  and nothing is deleted through it. No `CACHE_VERSION` bump: no key or
  stored layout moved; an entry saved for this shape since X-5 may still
  hold another run's files until evicted. Rows: `output-shape.test.ts` ›
  "each entry holds only its own run's files, and a hit leaves no other
  entry's (X-88)", `inputs-resolution.test.ts` › "a clean follows a
  symlinked output dir that points INSIDE the project", "a symlinked
  output dir that leaves the project is refused by name …",
  `cache-declaration-warnings.test.ts` › "an output directory linked out
  of the project refuses the task by name (M-61, X-88)".
- **X-89.** `CACHE_VERSION` `vx-cache-v41`. X-88 fixed a run that stored
  another key's files in an entry whose output directory is a link
  inside its project; entries saved before it could replay them, so
  every cached task misses once and re-saves.
