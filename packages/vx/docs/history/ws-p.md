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
- **P-10** `nx()`: a `{ input, projects }` list is matched as Nx's
  `findMatchingProjects` matches it (`*` patterns, `tag:`, `!`
  exclusions). Looked up as literal names, a `tag:` or pattern entry was
  a todo and its input left the key.

## Notes

- Running a cloned repo's own `nx` binary is refused by this session's
  permission policy, so Nx is the oracle by its source
  (`node_modules/nx/dist`), not its CLI.

## Leads for other streams

- `tests/npm-pack.unsafe.test.ts` failed once in a full gate
  (`JSON Parse error` on `npm pack --dry-run --json` output) and passed
  on the re-run and alone (2026-10-02, npm 10.9.4).
