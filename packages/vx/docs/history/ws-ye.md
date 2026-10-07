# Workstream YE — Nx/Turbo parity (2026-10-07)

- **YE-1.** Nx `-p '!b,a'` means every project but b (Nx 21.6 `findMatchingProjects` prepends `*` when the first pattern excludes); vx selected only a. The alias now prepends `--filter '*'` to a list that opens with `!`. Rows: tests/foreign-flags.test.ts › "an alias parses exactly as its vx spelling".
