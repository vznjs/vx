# Workstream YA — Nx/Turbo parity (2026-10-07)

- **YA-3.** A Vite Task user's `vp run` flags were unknown to `vx run`. Aliases: `-r` / `--recursive` → `--all`, `-w` / `--workspace-root` → `--filter //`, `--concurrency-limit` → `--concurrency`, `--ignore-depends-on` → `--exclude-dependencies`, `--fail-if-no-match` → nothing (vx already fails); `--log` and `--last-details` refused with the vx way. Rows: tests/foreign-flags.test.ts › every table entry.
