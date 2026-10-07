# Workstream YB — Nx/Turbo parity (2026-10-07)

- **YB-1.** fix: opencode's `build: { dependsOn: [] }` with `test` → `^build`: Turbo stops `^build` at a script-less dependency (a no-op node), core walked past it to the builds below, so `vx run test` ran and keyed builds Turbo never waits on. Such a dependency gets a key-only node with its own edges. Rows: `turbo-caret-stop.test.ts` › "stops `^build` there, as Turbo does, and keys its files".
