# Workstream YD — Nx/Turbo parity (2026-10-07)

- **YD-3.** The parity table called Turbo's `--no-cache` the same as
  vx's. Turbo's still reads (its help: `--cache=local:r,remote:r`);
  vx's reads nothing. The row and parity.md now say so. Docs only.
- **YD-1.** Turbo's `--force` / `--summarize` and Nx's boolean flags
  take `=true` / `=false`. `--skip-nx-cache=false` forced every task,
  `--nx-bail=false` stopped on the first failure, `--summarize=true`
  wrote the summary to a file named `true`. A `bool` row now reads
  `=false` as left out, `=true` as bare. Rows:
  `foreign-flags.test.ts` › "a boolean flag with =false is left out, with =true is bare".
