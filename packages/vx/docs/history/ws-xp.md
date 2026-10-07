# Workstream XP — cross-platform (2026-10-07)

Paths, line endings, shells, file-system quirks, Linux/macOS
differences, binaries and install across platforms.

- **XP-1.** On musl (Alpine) the npm launcher picked the glibc binary,
  whose execve fails ENOENT on a file that exists:
  `vx: failed to launch (spawn … ENOENT)`. A Linux host without the glibc
  loader now counts as having no prebuilt binary, so Bun runs the source
  when present and otherwise the error names musl. Rows:
  `npm-launcher.test.ts` › "without glibc (musl)".
- **XP-10.** `vx prune` on a CRLF checkout dropped every blank line
  between yarn.lock entries: a `\r` line read as a top-level key, so
  the pruned file was a rewrite, not a cut. A whitespace-only line is
  never a key now. Row in `packages/vx-lockfile/tests/prune-lockfile.test.ts`:
  "a CRLF checkout keeps the blank lines between entries".
- **XP-20.** `vx watch` compared a cache dir named through a symlink (`VX_CACHE_DIR`, macOS `/var`) with the real paths watchers report, so cache writes ran cycles; the ignore now realpaths it. Row: watch-rules "a cache dir named through a symlink is still the cache (XP-20)".
- **XP-30.** `vx init`: a root script's `cd packages/my\ app` (escaped
  space or paren) was not read as a cd into the member, so the root kept a
  task that runs the member's work. Row: `init.test.ts` "a cd into a
  member whose dir holds a backslash-escaped space runs the members".
- **XP-40.** turbo() escapes a brace in a package dir it writes into a glob (climbed inputs, root dependency trees): `r{x,y}` matched `rx`, `ry`, never itself. Rows: "a climbed glob escapes the package dir it keeps…", "key every task on a dependency whose dir name holds a brace".
- **XP-50.** macOS `ps` under a comma locale (`0:01,50`) read no time, so off-Linux sampling saw no tree; `proc-sample.unsafe.test.ts` "reads ps's time column, macOS hundredths (either decimal point) and days included".
- **XP-60.** `--affected` matched git's NFC paths against project dirs as
  discovered; a macOS dir stored NFD selected nothing. Both sides compare
  NFC. Row: `affected-unicode.test.ts`.
- **XP-70.** On macOS a project dir stored NFD got no slice of git's NFC
  listing and spawned `git ls-files` per task. The enumeration matches the
  dir as NFC; key paths stay git's spelling. Row: `git-enum-unicode.test.ts`.
