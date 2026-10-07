# Workstream YJ — Nx/Turbo parity: Lerna (2026-10-07)

- **YJ-1.** A Lerna repo mapped through Nx's graph had no task order: `lerna run x` hands Nx `^x` (and drops other edges) when nx.json has no `targetDefaults` and no package with `x` has an `nx` key, and the graph holds none of it. The mapper now applies it beside a `lerna.json`; `nx()` re-maps when one appears. Rows: packages/vx-migrate/tests/nx-lerna-order.test.ts › "orders each target after its dependencies’ under lerna.json", "nx() re-maps when lerna.json appears".
