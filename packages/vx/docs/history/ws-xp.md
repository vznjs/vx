# Workstream XP — cross-platform (2026-10-07)

- **XP-10.** `vx prune` on a CRLF checkout dropped every blank line
  between yarn.lock entries: a `\r` line read as a top-level key, so
  the pruned file was a rewrite, not a cut. A whitespace-only line is
  never a key now. Row in `packages/vx-lockfile/tests/prune-lockfile.test.ts`:
  "a CRLF checkout keeps the blank lines between entries".
Paths, line endings, shells, file-system quirks, Linux/macOS
differences, binaries and install across platforms.

- **XP-1.** On musl (Alpine) the npm launcher picked the glibc binary,
  whose execve fails ENOENT on a file that exists:
  `vx: failed to launch (spawn … ENOENT)`. A Linux host without the glibc
  loader now counts as having no prebuilt binary, so Bun runs the source
  when present and otherwise the error names musl. Rows:
  `npm-launcher.test.ts` › "without glibc (musl)".
