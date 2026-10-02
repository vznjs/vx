# Workstream P — Nx adoption (`nx()`, `nxCache()`, `nx-exec`, the Nx migrator)

## Items

- **P-1** `nx()`: `{ input, projects: "dependencies" }` is `^input` and
  `projects: "self"` the own input, as Nx 23's
  `splitInputsIntoSelfAndDependencies` still reads them; taken as project
  names, each was a todo and its input dropped (a dependency or own edit
  re-keyed nothing).
- **P-5** `nx()`: every task gets `NX_TASK_TARGET_PROJECT`,
  `NX_TASK_TARGET_TARGET` and `NX_TASK_TARGET_CONFIGURATION`, as Nx's
  `getNxEnvVariablesForTask` sets them. A package script's
  `nx exec -- <cmd>` found them unset and booted Nx's task runner, which
  ran the target and its dependencies a second time.

## Notes

- Running a cloned repo's own `nx` binary is refused by this session's
  permission policy, so Nx is the oracle by its source
  (`node_modules/nx/dist`), not its CLI.

## Leads for other streams

- `tests/npm-pack.unsafe.test.ts` failed once in a full gate
  (`JSON Parse error` on `npm pack --dry-run --json` output) and passed
  on the re-run and alone (2026-10-02, npm 10.9.4).
