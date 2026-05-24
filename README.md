# @vzn/vx

A monorepo task runner for pnpm/Bun workspaces. Bun-only (≥ 1.3). **Pre-alpha — under active rebuild.**

`vx` is a content-addressed cache + task scheduler for monorepos. Authors write per-project `vx.config.ts` files; the CLI discovers projects, builds a task graph from declared `dependsOn`, and executes tasks respecting topological order.

The project is currently being rebuilt around a **modular pipeline** architecture. Each module (`workspace`, `config`, `graph`, `runner`, …) owns one concern and exports a replaceable interface.

## Status

Shipped:

- `vx graph [tasks...]` — print the task graph that would run, in text / JSON / DOT.
- Workspace discovery (pnpm-workspace.yaml / package.json workspaces / single-package).
- Config loading + validation (`vx.config.{ts,mts,js,mjs}`).
- Graph construction (same-project + cross-project `dependsOn`, cycle detection, topo sort).

Coming:

- `vx run [tasks...]` — execute tasks in topo order via the upcoming runner module.
- `^name` workspace-dep edges (requires the `package-graph` module).
- Cache, watch, sandbox — re-introduced as standalone modules.

## Quick look

```ts
// vx.config.ts
import { defineProject } from '@vzn/vx'

export default defineProject({
  tasks: {
    build: { exec: { command: 'tsc' }, dependsOn: ['compile'] },
    compile: { exec: { command: 'bun build src/index.ts' } },
    test: { exec: { command: 'bun test' }, dependsOn: ['build'] },
  },
})
```

```bash
$ bun src/bin.ts graph build
solo#compile  — bun build src/index.ts
solo#build    — tsc  <- solo#compile
```

## Try it

```bash
bun install
bun src/bin.ts graph build --help
```

## Architecture

See [`docs/README.md`](docs/README.md). Each module under `src/` has its own README describing its contract.

## License

[MIT](LICENSE).
