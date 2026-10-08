# Workstream YG — Nx/Turbo parity (2026-10-07)

- **YG-3.** `turboCache()` read an upload's `403` as a refused token and turned reads off too; turborepo-remote-cache under `READ_ONLY` (or a JWT without the write scope) answers exactly that, so every task after the first upload missed (probed against turborepo-remote-cache 2.14.3). An upload's `403` now turns off uploads alone, as `nxCache()` does. Rows: tests/turbo-cache-sweep.test.ts › "an upload's 403 turns off uploads alone, said once; reads go on".
