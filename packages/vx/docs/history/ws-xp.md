# Workstream XP — cross-platform (2026-10-07)

- **XP-20.** `vx watch` compared a cache dir named through a symlink (`VX_CACHE_DIR`, macOS `/var`) with the real paths watchers report, so cache writes ran cycles; the ignore now realpaths it. Row: watch-rules "a cache dir named through a symlink is still the cache (XP-20)".
Paths, line endings, shells, file-system quirks, Linux/macOS
differences, binaries and install across platforms.

- **XP-1.** On musl (Alpine) the npm launcher picked the glibc binary,
  whose execve fails ENOENT on a file that exists:
  `vx: failed to launch (spawn … ENOENT)`. A Linux host without the glibc
  loader now counts as having no prebuilt binary, so Bun runs the source
  when present and otherwise the error names musl. Rows:
  `npm-launcher.test.ts` › "without glibc (musl)".
