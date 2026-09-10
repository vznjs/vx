# @vzn/vx-migrate

Adopt [`@vzn/vx`](https://github.com/vznjs/vx) from Turborepo or Nx: one `vx.config.ts` per workspace package from your `turbo.json` or an exported Nx project graph, plus the workspace file every run needs. Runs without a workspace file, so it is the first command, not the second.

```bash
bunx @vzn/vx-migrate           # auto-detect: turbo.json, or .nx/workspace-data/project-graph.json
bunx @vzn/vx-migrate --dry     # print the generated files + the report instead of writing
bunx @vzn/vx-migrate --force   # overwrite existing vx.config.* / vx-preset.ts
bunx @vzn/vx-migrate --from nx # disambiguate when both runners are checked in
```

`package.json` scripts are core's own `vx init`. What this package writes reads exactly like what `vx init` writes: both hand a plan to core's migration seam (`applyMigration` from `@vzn/vx`), which renders, refuses to overwrite without `--force`, writes and reports. Anything a source cannot say becomes a `TODO(vx-migrate)` comment, never a silent wrong value.

## Turbo

Reads the root pipeline (`tasks` in Turbo 2, `pipeline` in Turbo 1), per-package `turbo.json` `extends` overlays and each package's scripts, through the same mapper `@vzn/vx-turbo` runs live — so a repo reads the same whether you migrate it or run it as it is. Turbo's global fields (`globalDependencies`, `globalEnv`, `globalPassThroughEnv`) become a generated root `vx-preset.ts` each config imports and spreads: TypeScript composition replaces global config.

| Turborepo                           | vx                                                                                     |
| ----------------------------------- | -------------------------------------------------------------------------------------- |
| `dependsOn`                         | `dependsOn`, same micro-syntax (`$TURBO_ROOT$` deps are a TODO)                        |
| `inputs`                            | `cache.inputs.files` (`$TURBO_DEFAULT$` → `**/*`; `$TURBO_ROOT$/x` → `workspaceFiles`) |
| `outputs`                           | `cache.outputs.files` (a negated output is a TODO)                                     |
| `env`                               | `cache.inputs.env` **and** `exec.env.passThrough` (child envs are isolated)            |
| `passThroughEnv`                    | `exec.env.passThrough`                                                                 |
| `cache: false` / `persistent: true` | no `cache` block; `exec.persistent: {}` with a TODO to set `readyWhen`                 |

## Nx

Reads the **resolved** project graph only (`.nx/workspace-data/project-graph.json`; export one with `nx graph --file=.nx/workspace-data/project-graph.json`). Targets Nx plugins infer at runtime are frozen as the snapshot saw them. `nx:run-commands` joins its commands; the well-known executors (`@nx/js:tsc`, `@nx/vite:*`, `@nx/jest:jest`, …) become the command they would have run; anything else is a placeholder with a TODO. Named inputs expand from `nx.json` when readable. The graph's dependency edges are ignored — vx derives package edges from `package.json` — except for one report line counting edges with no manifest counterpart.

## History

`vx migrate` was a core verb until 2026-09-10; it moved here so core reads no other runner's format. Typing `vx migrate` prints the pointer to this package.
