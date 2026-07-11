# `src/cli/upgrade.ts` — self-update

## Purpose

`vx upgrade [tag]` downloads the release asset for this os/arch and
atomically renames it over the current executable.

## Invariants

- Compiled-binary detection keys off `Bun.main` / `process.argv[1]`
  (`/$bunfs/…`), NOT `import.meta.path` — under `--minify --bytecode`
  the latter reports the original source path (the 2026-06-15 bug).
- Running from source refuses with a git-pull hint.
- `isBunfsPath(p)` exported for tests.
