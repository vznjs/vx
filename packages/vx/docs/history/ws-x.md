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
  (turborepo#13042). Row: `inputs-resolution.test.ts` › "a clean never
  deletes through a symlinked output dir".
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
