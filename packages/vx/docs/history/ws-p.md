# Workstream P — Nx adoption (`nx()`, `nxCache()`, `nx-exec`, the Nx migrator)

## Items

- **P-1** `nx()`: `{ input, projects: "dependencies" }` is `^input` and
  `projects: "self"` the own input, as Nx 23's
  `splitInputsIntoSelfAndDependencies` still reads them; taken as project
  names, each was a todo and its input dropped (a dependency or own edit
  re-keyed nothing).
- **P-2** `nx()`: a `dependsOn` string splits as Nx 23's
  `splitTargetFromNodes` does: this project's own target first, then the
  named project's whole `target:with:colons` (`ui:build:esm` is ui's
  `build:esm`, not `build` in configuration `esm`, which reached the
  wrong task or dropped the edge).
- **P-3** `nx()`: an output's dotted `{options.outputPath.base}` walks the
  options, as Nx's `interpolate` does; read as one key it was no output,
  so nx-examples' cached `@nx/angular:application` builds restored
  nothing on a hit.
- **P-4** `nx()`: a grouped target's `.env` files are named by the group
  member that carries `nonAtomizedTarget` and that parent, as Nx's
  `getOwnerTargetForTask` names them: cypress's atomized
  `e2e-ci--<spec>` loads `.env.e2e-ci` and `.env.e2e`. vx named them by
  the task's own name, so it loaded `.env.e2e-ci--<spec>`, which Nx never
  does, and missed `.env.e2e-ci`.
- **P-11** `vx-migrate --from nx`: nx.json's `parallel`, `defaultBase`
  and `maxCacheSize`, which `nx()` applies live, are each a note naming
  the `vx.workspace.ts` field to add. The written workspace file holds
  none of them, so nx-examples' `parallel: 1` ran on every core once
  migrated, without a word.
- **P-5** `nx()`: every task gets `NX_TASK_TARGET_PROJECT`,
  `NX_TASK_TARGET_TARGET` and `NX_TASK_TARGET_CONFIGURATION`, as Nx's
  `getNxEnvVariablesForTask` sets them. A package script's
  `nx exec -- <cmd>` found them unset and booted Nx's task runner, which
  ran the target and its dependencies a second time.
- **P-6** `nx()`: a `{ fileset, includeIgnored: true }` input (Nx 23:
  hashed from disk, gitignored or missing) is read by a workspace-root
  probe when it names one path, and is a todo when it is a glob. Mapped
  as a plain glob, a gitignored literal failed the task before it ran.
- **P-7** `nx()`: a `dependsOn` entry's `options: "forward"`, which Nx's
  `createTaskOverrides` turns into the dependency's overrides, is a todo
  when the target has options to forward. It was dropped without a word,
  and the dependency ran with its own options.
- **P-9** `nx()`: a `dependsOn` string's part after `project:` is one
  target name, as Nx's `readProjectAndTargetFromTargetString` joins it:
  `ui:build:ci` names target `build:ci` and is no edge where ui lacks it.
  vx read the last segment as a configuration and drew an edge to that
  configuration's task (or to `build`, with a todo) that Nx never draws.
- **P-14** test: `nx-exec-live` holds P-5's `NX_TASK_TARGET_*` to what
  `nx run` hands the task, a configuration's included (Nx 22 and 23.2,
  12/12 each; fails with the define undone). The live suite also passes
  whole on Nx 23.2.1, which CI does not run (it pins `nx@22`).

## Notes

- Running a cloned repo's own `nx` binary is refused by this session's
  permission policy, so Nx is the oracle by its source
  (`node_modules/nx/dist`), not its CLI.

## Leads for other streams

- `tests/npm-pack.unsafe.test.ts` failed once in a full gate
  (`JSON Parse error` on `npm pack --dry-run --json` output) and passed
  on the re-run and alone (2026-10-02, npm 10.9.4).
- Core's `MigrationPlan` (`workspace/migration.ts`) has no field for the
  workspace file's settings, so a migrator can only name them in a note
  (P-11); `turbo`'s `concurrency` / `cacheMaxSize` / `TURBO_SCM_BASE` are
  in the same place. A `workspace` field on the plan would let both write
  them.
