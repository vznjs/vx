# Workstream P2 — the Nx migrator (`bunx @vzn/vx-migrate` on an Nx repo → native vx config)

## Items

- **P2-1** The migrator writes an executor target as the command its
  executor runs (`src/nx/nx-native.ts`: `@nx/jest:jest`,
  `@nx/vitest:test` / `@nx/vite:test`, `@nx/vite:build`,
  `@nx/eslint:lint`, `@nx/js:tsc`, `@nx/playwright:playwright`, and their
  `@nrwl/` names), from where Nx ran the tool and with the schema
  defaults Nx applies; what the executor did besides (a type-check, a
  `package.json` or `assets` in the output) is a TODO. Any other executor
  is a placeholder that fails naming it and its options, one TODO per
  executor. It wrote an `nx-exec` line, so a migrated repo still needed
  Nx installed to run. `nx()` keeps `nx-exec`.
- **P2-2** The migrator writes `@nx/vite:dev-server` as `vite` and
  `@nx/vite:preview-server` as `vite preview` on the `buildTarget`'s config
  file, mode and output dir (a configuration's own `buildTarget` read in
  that configuration), and `@nx/storybook:storybook` / `:build` as
  `storybook dev` (on Nx's port 9009) / `storybook build` from the
  workspace root. Each was a failing placeholder.
- **P2-3** The migrator writes `@nx/next:build` as `next build` with
  `NX_NEXT_OUTPUT_PATH` set, `@nx/next:server` as `next dev` / `next
start` (in the build output) with Nx's port and `PORT`, and
  `@nx/cypress:cypress` as `cypress run` / `open` from the workspace root
  on the config file's directory; the dev server Nx started first, and
  the files `next build` did not write, are TODOs. Each was a failing
  placeholder.
- **P2-4** An executor the migrator has no command for, from a plugin
  that ships `convert-to-inferred` (`@nx/webpack`, `@nx/rollup`, …),
  names that generator in its TODO: those executors feed their options
  to the project's config function, so no flag line reproduces them, and
  Nx's generator moves them into the config.
- **P2-5** The migrator writes `@nx/esbuild:esbuild` (bundled, its
  default) as esbuild's own CLI from the workspace root: one build per
  format, `--packages=external` for the npm dependencies Nx externalizes
  without `thirdParty`, the output emptied first; the type-check, the
  `package.json` and assets Nx added are TODOs. It was a failing
  placeholder.
- **P2-6** The migrator writes `@nx/js:node` as `node` on its build
  target's output file, named as Nx's `getFileToRun` names it, with Nx's
  default inspector; and `@nx/js:node` is a server executor, so a graph
  with no `continuous` (an Nx older than that field) no longer makes it
  an ordinary task that never ends, in `nx()` or a migration.
- **P2-7** The migrator writes `@nx/js:swc` as swc's own CLI from the
  project dir, as Nx's `getSwcCmd` builds it: the `sourceRoot` (else
  `src`, else the project) into the output, the project's `.swcrc`, the
  output emptied first; the type-check, `package.json` and assets are
  TODOs. It was a failing placeholder.
- **P2-8** A migration no longer writes `nx-release-publish`
  (`@nx/js:release-publish`, which Nx adds to every package) as a
  failing placeholder per package: the report has one note naming the
  package manager's own `publish`. `nx()` still runs it.
- **P2-9** A migrated command that still runs Nx (`nx run b:build`,
  `npx nx test`, `nx exec -- tsc`) carries a TODO naming what to write
  instead: it works only while Nx is installed, and it passed the
  report clean.
- **P2-10** An Nx migration's report says what `vx.workspace.ts` still
  holds, as the Turbo one does (the helper is now shared): the `nx()`
  `vx init` declared, which keeps reading nx.json and filling tasks, and
  a lockfile with no `@vzn/vx-lockfile` plugin, where a bump re-runs
  every task that Nx re-ran per project.
- **P2-11** An Nx output that resolves outside the workspace (an old
  generator's `reportsDirectory: "../../coverage/libs/util"`, read from
  the workspace root as Nx 23 reads it) is dropped with a TODO: it was
  written as `workspaceFiles: ['../../…']`, and vx refused to load the
  migrated config (and an `nx()` run). Found by a hand-written graph
  fixture in the explicit-executor style.
- **P2-12** A migration's sync-generator notes no longer say "run `nx
sync`", advice for a repo leaving Nx: they say to keep what the
  generators wrote (the TypeScript one's tsconfig `references`) by hand.
  `nx()` keeps `nx sync`. Found by a hand-written graph fixture of
  inferred plugin targets.
- **P2-13** Five hand-written Nx graphs in the shapes real repos have
  (plugin-inferred targets, explicit executors, continuous and atomized
  targets with a root project, per-project named inputs and filesets,
  run-commands variants) are
  test fixtures: `tests/nx-shape-fixtures.test.ts` migrates each through
  the CLI and loads every written config. They found P2-11 and P2-12.
- **P2-14** Three more shapes join them: configurations with
  `{options.outputPath}` outputs, `nx:run-script` and implicit
  dependencies; every input kind (runtime, workspace filesets, another
  project's named input, `projects: "*"`); `{projectRoot}` /
  `{projectName}` interpolation and a script that calls nx. Rows now pin
  commands, outputs and dependsOn, not only task names. All three
  migrated correctly.
- **P2-15** An Nx project no workspace glob lists (an integrated repo's
  `project.json` library) got a `vx.config.ts` core never found: it
  discovers a project only by a listed `package.json`. The migration now
  writes a `package.json` (`name`, `private`) where there is none and
  one note naming the directories to add to `workspaces` or
  `pnpm-workspace.yaml`.
- **P2-16** One Nx edge spelled two ways (`ui:gen` and
  `{ projects: ["ui"], target: "gen" }`) was listed twice in the written
  `dependsOn`; `mapNxDeps` now returns each edge once.
- **P2-17** An integrated repo (a root project, `project.json` projects
  in no workspace glob, an Angular builder) joins the shape fixtures: the
  row follows P2-15's note and asserts core then finds every project.
- **P2-18** `@nx/js:verdaccio` (the `local-registry` target Nx's
  `setup-verdaccio` writes) migrates to the registry it forks:
  `verdaccio --config … --listen localhost:4873` from the workspace root,
  a server, its storage cleared under `clear`; the npm and yarn registry
  Nx set while it ran is a TODO. Read from the executor in Nx 23.2.1.
- **P2-19** `repeated-runs.unsafe.test.ts` compared the open descriptor
  count exactly between run 5 and run 20, and failed CI on #2455 at
  18 → 17: a descriptor still closing at run 5. The claim is no growth,
  so descriptors may fall, never rise; listeners still hold exactly. A
  per-run descriptor leak and an added listener both still fail it.
- **P2-20** Nx 15–16's `@nrwl/workspace:run-commands` / `run-script`
  (and `@nx/workspace:`), which an older graph keeps as written, are the
  `nx:` executors they re-exported: the migration wrote each as a
  failing placeholder, and `nx()` ran them through `nx-exec`.
- **P2-21** A named input neither nx.json nor the project defines (an
  nx.json `extends` preset not installed where the snapshot is read)
  wrote an empty input list: a cached task keyed on its config alone, a
  stale hit after every source edit. It now keys the whole project
  (`**/*`), its dependency twin too, with the todo kept.
- **P2-22** An Nx `implicitDependencies: ["!a"]` drops a manifest edge
  from the graph, often to break a cycle; vx's `^build` follows the
  manifest, so the migrated configs brought the cycle back and core
  refused the run. Where a manifest reaches a project the Nx graph does
  not, the `^target` is the explicit edges Nx draws.
- **P2-23** A configuration task's name can be another target's: `vite`'s
  `build` configuration is `vite:build`, which an inferred target with
  `buildTargetName: "vite:build"` names. The written object kept the last
  key, and the real build became `vite --x`, uncached. The target keeps
  its name, as Nx resolves `a:vite:build` to it; the configuration is a
  todo, and an edge to it reaches its base task.
- **P2-24** `@nx/js:node` and `@nx/vite:preview-server` built their
  `buildTarget` before running, and the migration said so in a TODO: the
  written `serve` ran `node dist/apps/api/main.cjs` with no edge to the
  build, a failure on a clean checkout. A translator now hands back the
  specs its executor ran first, and each is a `dependsOn` edge, its
  configuration resolved as Nx resolves it; the watch-mode rebuild stays
  a TODO, and a build target the graph lacks keeps the old one.
- **P2-25** `@nx/cypress:cypress` started its `devServerTarget` before
  testing; the migrated e2e task now depends on that server task, by the
  channel P2-24 added. The URL Nx passed as `baseUrl` stays a TODO
  unless the options set one; `skipServe` starts nothing.
- **P2-27** The shape fixtures now plan every written task through core's
  `planRun` (git-initialised fixture roots), so a config that loads but
  that core refuses to plan fails its row: a mutant keeping a `^codegen`
  no project declares passed the load-only check and fails the plan. A
  tenth shape pins P2-22 and P2-23 end to end (a manifest cycle Nx
  breaks with `!a`, a configuration named like another target).
- **P2-26** `@nx/angular:package` and `ng-packagr-lite`, the Angular
  library builds in an Nx repo, were failing placeholders. They migrate
  to the ng-packagr line Nx ran (`ng-packagr -p … -c …` from the
  workspace root), read from the executors in Nx 23.2.1; Nx's tsconfig
  path remapping for buildable libraries and its stylesheet processor
  are TODOs.
- **P2-28** `@nx/js:node` on a build target with no output options (a
  Nest app's inferred `webpack-cli build`, the Nx 20+ default) was a
  failing placeholder with no build edge. It now runs the file Nx's
  `getFileToRun` names: the target's first `outputs` entry, glob
  stripped, then `main.js`, else `dist/<projectRoot>/main.js`; a build
  target with no options still resolves by its executor, so the edge is
  written.
- **P2-29** The migrate guide says what P2-24, P2-25 and P2-28 write:
  a server task depends on the build its executor ran first, and a
  Cypress task on its dev server.
- **P2-30** The Nx guide, walked end to end: every step's command and
  transcript is already held to a run by `try-it.unsafe.test.ts` (init,
  the `next:` build through `nx()`, the migrator's report, the written
  config, the native end state). The one step that differed from the
  Turborepo list was missing: review the `TODO(vx-migrate)` comments,
  where an untranslated executor's placeholder fails until written.
- **P2-31** A target with neither an executor nor a command (the
  TypeScript plugin's `build-deps`, before Nx's normalization) wrote a
  failing placeholder. The graph parse applies Nx's own rule: `nx:noop`
  with dependencies, dropped without. An eleventh shape fixture is the
  `@nx/js/typescript` plugin as Nx 23.2.1 infers it (include globs and
  exclusions, a `.d.ts` dependency fileset, a `{,.map}` output, a
  `.tsbuildinfo` output); a run restores exactly the declared outputs.
- **P2-32** `@nx/web:file-server`, the `serve-static` the vite and
  webpack plugins infer, was a failing placeholder. It is `http-server`
  on the build's output with Nx's flags (`spa` copies `index.html` to
  `404.html` and proxies misses back), its build an edge. A bare
  `buildTarget: "build"` resolved to nothing; specs now resolve as Nx's
  `parseTargetString` does, the current project's target.
- **P2-33** A twelfth shape fixture: `@nx/jest/plugin` with
  `ciTargetName` as Nx 23.2.1 infers it (a `jest.preset.js` input,
  coverage under the workspace root, `test-ci` a cached `nx:noop` over
  one `test-ci--<spec>` target per file). It migrates and plans; each
  spec task shares `test`'s coverage dir, so it runs uncached with the
  TODO that says so.
- **P2-37** Nx 15–16's `@nrwl/node:node` and `@nx/node:node`, wrappers
  over the js node executor, were failing placeholders; they map to
  `@nx/js:node`. Its output file reads an `@nrwl/js:tsc` / `swc` build
  as the `@nx/` one (tsc writes under the main's dir either way).

## Leads for other streams

- Core (`exec`): a migrated Nx target with `.env` files still runs under
  `nx-env` from `@vzn/vx-migrate`; a task-level env-file field in core
  would let the migrator write native config with no wrapper.
