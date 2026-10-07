# Workstream WD — watch, dev servers, persistent tasks (2026-10-07)

- **WD-14.** `vx watch` re-read the watched set after a config edit, but
  not after an edit to a module the config imports from inside its own
  project: a `workspaceFiles` input added in `./inputs.mjs` ran one cycle,
  and the root file it named was ignored until a restart. Now that import
  counts as the config. Row: `tests/watch-loop-members.test.ts` › "a module
  the config imports from inside its project reshapes the set like the config".
