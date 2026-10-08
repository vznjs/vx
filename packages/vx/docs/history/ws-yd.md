# Workstream YD — Nx/Turbo parity (2026-10-07)

- **YD-2.** Nx's `--projects` matches an entry by name, then by project
  root; `-p 'apps/*'` matched nothing. A filter name holding a `/`
  outside a scope that names no project now reads as `./<pattern>`.
  Rows: `filter.test.ts` › "a name holding a `/` outside a scope that
  names no project is a directory".
- **YD-4.** Nx's `--projects` / `--exclude` labels `directory:<d>` and
  `name:<n>` matched nothing. The aliases now emit `./<d>` and `<n>`.
  Rows: `foreign-flags.test.ts` › "an alias parses exactly as its vx
  spelling".
- **YD-3.** The parity table called Turbo's `--no-cache` the same as
  vx's. Turbo's still reads (its help: `--cache=local:r,remote:r`);
  vx's reads nothing. The row and parity.md now say so. Docs only.
- **YD-1.** Turbo's `--force` / `--summarize` and Nx's boolean flags
  take `=true` / `=false`. `--skip-nx-cache=false` forced every task,
  `--nx-bail=false` stopped on the first failure, `--summarize=true`
  wrote the summary to a file named `true`. A `bool` row now reads
  `=false` as left out, `=true` as bare. Rows:
  `foreign-flags.test.ts` › "a boolean flag with =false is left out, with =true is bare".
