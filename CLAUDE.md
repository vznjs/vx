# `@vzn/vx` — project memory for Claude

Pre-alpha. **Currently one module only: `project`.** Every other concern (workspace discovery, task graph, runner, cli, …) is intentionally out of scope until we've nailed it.

## Rules

1. **One module at a time.** Don't introduce a second module until the current one is settled — interface, implementation, tests, benches, docs all done and reviewed.
2. **Don't add features that haven't been asked for.** Empty config means empty. No defineProject helper, no schema validation, no cache fields.
3. **Stop and ask** before bigger changes. Small, reversible edits are fine to ship; structural changes need user sign-off.
4. **`src/` is production code only.** Tests and benches live under `tests/` as `*.test.ts` / `*.bench.ts`. Shared helpers live in `tests/_testkit/` and `tests/_harness.ts`.

## Stack

| Concern | Tool                                        |
| ------- | ------------------------------------------- |
| Runtime | Bun ≥ 1.3                                   |
| Schema  | `zod` (v4)                                  |
| Tests   | `bun test` (imports from `bun:test`)        |
| Benches | `mitata` via `tests/_harness.ts`            |
| Lint    | `oxlint --type-aware --type-check`          |
| Format  | `oxfmt`                                     |
| Build   | None. TypeScript source ships as the entry. |

## Layout

```
src/
  index.ts                # re-exports from project + workspace
  project/index.ts        # whole module in one file: schema + load + validate + define
  workspace/index.ts      # whole module in one file: schema + load + validate + define + findRoot

tests/
  _harness.ts             # mitata wrapper
  _testkit/fixtures.ts    # tmp-dir builder
  project.test.ts
  project.bench.ts
  workspace.test.ts
  workspace.bench.ts

.github/workflows/ci.yml  # install → format-check → lint → test
package.json              # devDeps only
tsconfig.json
.oxlintrc.json
.oxfmtrc.json
README.md
LICENSE
```

## Status

| Module    | Shipped | Surface                                                                                                                                                                                                                                                                                                                    |
| --------- | :-----: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| project   |   ✅    | Single file. `Project` (type, inferred from an internal zod schema). `loadProject(dir)` imports `vx.config.*` and validates implicitly. `validateProject(input)` parses any value through the schema. `defineProject(p)` identity for inference.                                                                           |
| workspace |   ✅    | Single file. `Workspace` (type, inferred from an internal zod schema). `loadWorkspace(root)` imports `vx.workspace.*` and validates implicitly. `validateWorkspace(input)` parses through schema. `defineWorkspace(w)` identity. `findWorkspaceRoot(start)` via `pkg-types`. The only function returning an absolute path. |

25 tests pass. Format + lint clean.

## Operating directive

You own this. The user is restoring discipline after a few rushed iterations. Until they say otherwise:

- Do not add a runner, a CLI, a graph module, an inventory module, a sandbox, a cache, or any other module.
- Do not add validation, default helpers, or schema features to `config`.
- When you think something should be added, propose it and wait.
