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
- **P2-18** `@nx/js:verdaccio` (the `local-registry` target Nx's
  `setup-verdaccio` writes) migrates to the registry it forks:
  `verdaccio --config … --listen localhost:4873` from the workspace root,
  a server, its storage cleared under `clear`; the npm and yarn registry
  Nx set while it ran is a TODO. Read from the executor in Nx 23.2.1.
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

## Leads for other streams

- Core (`exec`): a migrated Nx target with `.env` files still runs under
  `nx-env` from `@vzn/vx-migrate`; a task-level env-file field in core
  would let the migrator write native config with no wrapper.
