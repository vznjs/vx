# Versioning and support (2026-09-23, roadmap 3.1–3.4)

This page says what a vx release may change, and what it may not. It
takes effect at 1.0. Until then, releases are 0.x and a minor may
break anything, but every break is listed under "Breaking" in the
release notes (`history/release-0.1.0-notes.md` is the model).

## The contract

From 1.0, these surfaces follow semver. A patch fixes them, a minor
adds to them, and only a major removes or changes one.

| Surface                                                                                                                                                                | Defined by                                                                           |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| The config schema: every field `vx.config.ts` and `vx.workspace.ts` accept, and what each means                                                                        | `src/workspace/config-schema.ts`, `docs/schema.md`                                   |
| The plugin API: the hooks in `PLUGIN_HOOKS`, `definePlugin`, `CacheLayer` / `RemoteCacheLayer`, `TaskExecutor`, and the telemetry records (`TELEMETRY_SCHEMA_VERSION`) | `src/config.ts`, `src/cache/layer.ts`, `src/orchestrator/telemetry.ts`               |
| The package's exports                                                                                                                                                  | `src/index.ts`, pinned by the façade snapshot in `package-boundaries.unsafe.test.ts` |
| The CLI: verbs, flags, exit codes, and the machine-readable outputs (`--dry=json`, `--graph`, `--summarize`, `vx mcp`'s tools)                                         | `docs/cli.md`                                                                        |
| Task-glob semantics: which paths a pattern selects (item 667 made `[` literal; that reading is now part of the contract)                                               | `docs/schema.md`, `docs/caching.md`                                                  |

## Not the contract

These may change in any release.

- The terminal output: status lines, colours, wording, layout. Scripts
  should read `--summarize` or `--dry=json` instead.
- Anything not exported from `@vzn/vx`: the modules under `src/` are
  internal.
- The cache's on-disk format and its keys. A `CACHE_VERSION` bump is
  allowed in a minor, because replaying stale bytes is worse than a
  cold run. It is never silent: it goes in the release notes, and the
  first run after the upgrade says `cache format changed: vA → vB`
  (item 671). A `SCHEMA_VERSION` reset says `cache index reset`.
- Performance, including the scheduler's ordering. A regression is a
  bug, but it is not a break.

## Deprecation

A contract surface is removed in three steps:

1. **A minor deprecates it.** The surface keeps working and warns once
   per run, naming what replaces it. A config field's warning comes from
   `config-schema.ts`; a flag's comes from the CLI's parser.
2. **At least one more minor ships with the warning.**
3. **The next major removes it.** When a removed field is used, the
   refusal names the replacement and the version that removed it.

A fix for a stale hit or wrong bytes ships in a patch, even when it
changes what a glob or a key means (item 667 did both). Its release
notes say what changed.

## Plugins

Every first-party plugin publishes at the core's version, in one release
train, with `peerDependencies['@vzn/vx'] = ^<version>` (item 656).
Plugin authors code against the contract above and nothing else.

## Runtime and platforms

- **Bun.** The floor is `engines.bun` in `packages/vx/package.json`.
  Raising it is a minor, and the release notes announce it. The gate
  refuses a Bun below the floor (`check.bun`, item 575). Standalone
  binaries embed their runtime, so the floor only applies to `bunx` and
  `bun add` installs.
- **Tier 1:** Linux and macOS. CI runs every commit on Linux x64
  (`ubuntu-latest`) and macOS arm64 (`macos-latest`); release binaries
  are built for x64 and arm64 on both, and the other two pairs are
  covered by those builds, not by a test run.
- **Windows:** WSL only, since POSIX shell is the task API. There is no
  native build, and a Windows-only bug is out of scope unless it also
  reproduces under WSL.

## When this takes effect

The owner tags 1.0 once roadmap milestone 3 is done and the soak (3.5)
is clean. Until then, this page is the plan. When 1.0 is tagged, the
README's status section changes from "Pre-alpha" to point here.
