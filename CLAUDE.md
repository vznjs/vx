# `@vzn/vx` — project memory for Claude

Pre-alpha. **Currently one module only: `project`.** Every other concern (workspace discovery, task graph, runner, cli, …) is intentionally out of scope until we've nailed it.

## Rules

1. **One module at a time.** Don't introduce a second module until the current one is settled — interface, implementation, tests, benches, docs all done and reviewed.
2. **Don't add features that haven't been asked for.** Empty config means empty. No defineProject helper, no schema validation, no cache fields.
3. **Stop and ask** before bigger changes. Small, reversible edits are fine to ship; structural changes need user sign-off.
4. **`src/` is production code only.** Tests under `tests/`, benches under `bench/`, helpers under `tests/_testkit/` or `bench/_harness.ts`.

## Stack

| Concern | Tool                                        |
| ------- | ------------------------------------------- |
| Runtime | Bun ≥ 1.3                                   |
| Schema  | `zod` (v4)                                  |
| Tests   | `bun test` (imports from `bun:test`)        |
| Benches | `mitata` via `bench/_harness.ts`            |
| Lint    | `oxlint --type-aware --type-check`          |
| Format  | `oxfmt`                                     |
| Build   | None. TypeScript source ships as the entry. |

## Layout

```
src/
  index.ts                # re-exports from project
  project/
    schema.ts             # ProjectSchema (zod) + Project (inferred)
    load.ts               # loadProject(dir) — finds vx.config.* in dir, imports + ProjectSchema.parse()
    define.ts             # defineProject(p) — identity, for type inference
    index.ts
    README.md

tests/
  _testkit/fixtures.ts    # tmp-dir builder shared by tests + benches
  project/
    load.test.ts
    define.test.ts

bench/
  _harness.ts             # mitata wrapper
  project/load.bench.ts

.github/workflows/ci.yml  # install → format-check → lint → test
package.json              # devDeps only
tsconfig.json
.oxlintrc.json
.oxfmtrc.json
README.md
LICENSE
```

## Status

| Module  | Shipped | Surface                                                                                                                                                                                    |
| ------- | :-----: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| project |   ✅    | `ProjectSchema` (zod, strict + empty) → `Project` (inferred). `loadProject(dir)` discovers vx.config.{ts,mts,js,mjs} and parses through schema. `defineProject(p)` identity for inference. |

10 tests pass. Format + lint clean.

## Operating directive

You own this. The user is restoring discipline after a few rushed iterations. Until they say otherwise:

- Do not add a runner, a CLI, a graph module, an inventory module, a sandbox, a cache, or any other module.
- Do not add validation, default helpers, or schema features to `config`.
- When you think something should be added, propose it and wait.
