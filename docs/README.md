# Documentation

`@vzn/vx` is reorganized around a **modular pipeline**. Each module owns one concern; the CLI composes them into a pipeline.

```
workspace  →  config  →  graph  →  runner  →  …
```

Every module exports an interface (`types.ts`) and a default implementation. Users can replace any layer by writing a custom implementation against the same interface.

## Per-module docs

Each module has a `README.md` in `src/<module>/` describing the contract, defaults, and replacement points:

- [`src/workspace/`](../src/workspace/README.md) — discover projects on disk
- [`src/config/`](../src/config/README.md) — load + validate `vx.config.ts`
- [`src/graph/`](../src/graph/README.md) — build the task DAG
- [`src/cli/`](../src/cli/README.md) — argv parser + subcommand dispatcher

## Running it

```bash
# Print the graph of tasks that would run for `build`:
bun src/bin.ts graph build

# As JSON or Graphviz DOT:
bun src/bin.ts graph build --json
bun src/bin.ts graph build --dot | dot -Tsvg > graph.svg
```

## Tests

Unit tests live under `tests/<module>/` mirroring `src/<module>/`. End-to-end tests live under `tests/e2e/`.

```bash
bun test                  # full suite (unit + e2e)
bun test tests/graph/     # one module
bun test tests/e2e/       # end-to-end only
```

## Benchmarks

Every module has a `*.bench.ts`. Run them directly with Bun:

```bash
bun src/graph/build.bench.ts
bun src/workspace/discover.bench.ts
bun src/config/load.bench.ts
```

## Format & lint

```bash
bun x oxfmt .                            # format
bun x oxfmt --check .                    # check only (CI)
bun x oxlint --type-aware --type-check   # lint
```
