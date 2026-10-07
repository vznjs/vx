# Workstream YC — Nx/Turbo parity (2026-10-07)

- **YC-5.** core: a root whose `pnpm-workspace.yaml` holds settings and no `packages:` (ngrx, once vx-migrate wrote its projects' package.json) got "there is no pnpm-workspace.yaml … add `workspaces` to package.json". `unreachedHint` now names the yaml and its `packages` entry there. Rows: tests/init.test.ts › "beside a pnpm-workspace.yaml with no packages, names that file".
