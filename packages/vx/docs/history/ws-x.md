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
