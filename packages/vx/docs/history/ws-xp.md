# Workstream XP — cross-platform (2026-10-07)

- **XP-40.** turbo() escapes a brace in a package dir it writes into a glob (climbed inputs, root dependency trees): `r{x,y}` matched `rx`, `ry`, never itself. Rows: "a climbed glob escapes the package dir it keeps…", "key every task on a dependency whose dir name holds a brace".
Paths, line endings, shells, file-system quirks, Linux/macOS
differences, binaries and install across platforms.

- **XP-1.** On musl (Alpine) the npm launcher picked the glibc binary,
  whose execve fails ENOENT on a file that exists:
  `vx: failed to launch (spawn … ENOENT)`. A Linux host without the glibc
  loader now counts as having no prebuilt binary, so Bun runs the source
  when present and otherwise the error names musl. Rows:
  `npm-launcher.test.ts` › "without glibc (musl)".
