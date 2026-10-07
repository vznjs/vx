# Workstream YJ — Nx/Turbo parity: Lerna (2026-10-07)

- **YJ-3.** A Lerna repo on pnpm links no `nx` into `node_modules/.bin` (only Lerna's dependency has one), so `nx()` and `vx-migrate` failed with "no node_modules/.bin/nx". The graph export now falls back to the `nx` Lerna resolves. Rows: packages/vx-migrate/tests/nx-export-lerna.test.ts › "exports with the nx Lerna depends on when the root links none".
