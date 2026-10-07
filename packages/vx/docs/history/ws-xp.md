# Workstream XP — cross-platform (2026-10-07)

- **XP-50.** macOS `ps` under a comma locale (`0:01,50`) read no time, so off-Linux sampling saw no tree; `proc-sample.unsafe.test.ts` "reads ps's time column, macOS hundredths (either decimal point) and days included".
Paths, line endings, shells, file-system quirks, Linux/macOS
differences, binaries and install across platforms.

- **XP-1.** On musl (Alpine) the npm launcher picked the glibc binary,
  whose execve fails ENOENT on a file that exists:
  `vx: failed to launch (spawn … ENOENT)`. A Linux host without the glibc
  loader now counts as having no prebuilt binary, so Bun runs the source
  when present and otherwise the error names musl. Rows:
  `npm-launcher.test.ts` › "without glibc (musl)".
