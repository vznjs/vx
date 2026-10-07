# Workstream XP — cross-platform (2026-10-07)

- **XP-30.** `vx init`: a root script's `cd packages/my\ app` (escaped
  space or paren) was not read as a cd into the member, so the root kept a
  task that runs the member's work. Row: `init.test.ts` "a cd into a
  member whose dir holds a backslash-escaped space runs the members".
Paths, line endings, shells, file-system quirks, Linux/macOS
differences, binaries and install across platforms.

- **XP-1.** On musl (Alpine) the npm launcher picked the glibc binary,
  whose execve fails ENOENT on a file that exists:
  `vx: failed to launch (spawn … ENOENT)`. A Linux host without the glibc
  loader now counts as having no prebuilt binary, so Bun runs the source
  when present and otherwise the error names musl. Rows:
  `npm-launcher.test.ts` › "without glibc (musl)".
