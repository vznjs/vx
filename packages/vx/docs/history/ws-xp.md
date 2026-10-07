# Workstream XP — cross-platform (2026-10-07)

- **XP-10.** `vx prune` on a CRLF checkout dropped every blank line
  between yarn.lock entries: a `\r` line read as a top-level key, so
  the pruned file was a rewrite, not a cut. A whitespace-only line is
  never a key now. Row in `packages/vx-lockfile/tests/prune-lockfile.test.ts`:
  "a CRLF checkout keeps the blank lines between entries".
