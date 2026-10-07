# Workstream YD — Nx/Turbo parity (2026-10-07)

- **YD-2.** Nx's `--projects` matches an entry by name, then by project
  root; `-p 'apps/*'` matched nothing. A filter name holding a `/`
  outside a scope that names no project now reads as `./<pattern>`.
  Rows: `filter.test.ts` › "a name holding a `/` outside a scope that
  names no project is a directory".
