# `src/cli/upgrade.ts` — self-update

## Purpose

`vx upgrade [tag]` asks the GitHub release API for this os/arch's asset
and the SHA-256 digest the API publishes for it, downloads the asset,
verifies the digest, and atomically renames it over the current
executable. A mismatch — a cut transfer, a swapped asset — replaces
nothing (item 233).

## Invariants

- Compiled-binary detection keys off `Bun.main` / `process.argv[1]`
  (`/$bunfs/…`), NOT `import.meta.path` — under `--minify --bytecode`
  the latter reports the original source path (the 2026-06-15 bug).
- Running from source refuses with a git-pull hint; an npm-installed
  binary (the launcher runs `…/node_modules/@vzn/vx-<os>-<arch>/vx`,
  a compiled binary that passes the bunfs check) refuses with the npm
  command — npm owns that file, and the next install would put the
  version it knows back (`npmOwnedBinary`, item 234).
- `isBunfsPath(p)`, `releaseAsset(release, name)` and
  `replaceBinary(dest, url, sha256)` exported for tests; the tests stub
  `fetch`, and the compiled path against a real release stays manual
  (proven 2026-09-16 with a scratch binary: `0.0.0 → latest`, verified,
  replaced, `--version` reported the release).
- A release without the asset, or an asset the API publishes no digest
  for, is refused before any download: an upgrade that cannot be
  verified is not attempted.
