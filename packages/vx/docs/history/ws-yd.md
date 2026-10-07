# Workstream YD — Nx/Turbo parity (2026-10-07)

- **YD-4.** Nx's `--projects` / `--exclude` labels `directory:<d>` and
  `name:<n>` matched nothing. The aliases now emit `./<d>` and `<n>`.
  Rows: `foreign-flags.test.ts` › "an alias parses exactly as its vx
  spelling".
