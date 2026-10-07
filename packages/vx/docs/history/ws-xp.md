# Workstream XP — cross-platform (2026-10-07)

Paths, line endings, shells, file-system quirks, Linux/macOS
differences, binaries and install across platforms.

- **XP-1.** On musl (Alpine) the npm launcher picked the glibc binary,
  whose execve fails ENOENT on a file that exists:
  `vx: failed to launch (spawn … ENOENT)`. A Linux host without the glibc
  loader now counts as having no prebuilt binary, so Bun runs the source
  when present and otherwise the error names musl. Rows:
  `npm-launcher.test.ts` › "without glibc (musl)".
- **XP-60.** `--affected` matched git's NFC paths against project dirs as
  discovered; a macOS dir stored NFD selected nothing. Both sides compare
  NFC. Row: `affected-unicode.test.ts`.
