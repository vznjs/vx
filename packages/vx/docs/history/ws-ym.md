# Workstream YM — Nx/Turbo parity (2026-10-07)

- **YM-2.** A native Nx migration wrote `nx-exec` / `nx-env` lines and
  installed `@vzn/vx` alone, so after `bunx @vzn/vx-migrate` every
  executor target failed `nx-exec: not found` (nartc/mapper's lint). It
  now installs `@vzn/vx-migrate` when a written task runs either bin.
  Rows: `adopt.test.ts` › "installs @vzn/vx-migrate when a written task
  runs nx-exec, not when none does".
