# Versioning and support (2026-09-23, roadmap 3.1–3.4)

This page says what a vx release may change, and what it may not. It
takes effect at 1.0. Until then, releases are 0.x and a minor may
break anything, but every break is listed under "Breaking" in the
release notes (`history/release-0.1.0-notes.md` is the model).

## The contract

From 1.0, these surfaces follow semver. A patch fixes them, a minor
adds to them, and only a major removes or changes one.

| Surface                                                                                                                                                                | Defined by                                                                                                                                                                              |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The config schema: every field `vx.config.ts` and `vx.workspace.ts` accept, and what each means                                                                        | `src/workspace/config-schema.ts`, `docs/schema.md`; recorded in `tests/contract/config-schema.json`                                                                                     |
| The plugin API: the hooks in `PLUGIN_HOOKS`, `definePlugin`, `CacheLayer` / `RemoteCacheLayer`, `TaskExecutor`, and the telemetry records (`TELEMETRY_SCHEMA_VERSION`) | `src/orchestrator/plugin.ts`, `src/cache/layer.ts`, `src/cache/layered-cache.ts`, `src/exec/executor.ts`, `src/orchestrator/telemetry.ts`; recorded in `tests/contract/package-api.txt` |
| The package's exports                                                                                                                                                  | `src/index.ts`; names pinned by `package-boundaries.unsafe.test.ts`, shapes by `tests/contract/package-api.txt`                                                                         |
| The CLI: verbs, flags, exit codes, and the machine-readable outputs (`--dry=json`, `--graph`, `--summarize`, `vx mcp`'s tools)                                         | `docs/cli.md`                                                                                                                                                                           |
| Task-glob semantics: which paths a pattern selects (item 667 made `[` literal; that reading is now part of the contract)                                               | `docs/schema.md`, `docs/caching.md`                                                                                                                                                     |

## What 1.0 freezes, exactly

The table above names the surfaces. This section lists what is in them,
and `tests/contract-versioning-doc.test.ts` checks every list here
against the code, in both directions, so the page cannot promise a field
the schema dropped or leave out one it gained.

### Config fields

Each object level of a config and the fields it accepts. A field's type,
the values it takes and each refusal's exact words are recorded in
`tests/contract/config-schema.json`, and what each field means is in
`schema.md`. `<name>` is a key the author picks.

`vx.workspace.ts`:

| Level            | Fields                                                            |
| ---------------- | ----------------------------------------------------------------- |
| (top)            | `cacheDir`, `cacheRetention`, `concurrency`, `plugins`, `timeout` |
| `cacheRetention` | `maxSize`, `olderThan`                                            |

`vx.config.ts`:

| Level                              | Fields                                                                                                    |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------- |
| (top)                              | `tasks`                                                                                                   |
| `tasks.<name>`                     | `cache`, `dependsOn`, `description`, `exec`                                                               |
| `tasks.<name>.exec`                | `command`, `env`, `persistent`, `remote`, `retries`, `sandbox`, `timeout`                                 |
| `tasks.<name>.exec.env`            | `define`, `passThrough`                                                                                   |
| `tasks.<name>.exec.persistent`     | `readyWhen`                                                                                               |
| `tasks.<name>.exec.sandbox`        | `allow`, `deny`, `ignore`, `weakerNetworkIsolation`, `weakerWhenNested`                                   |
| `tasks.<name>.exec.sandbox.allow`  | `gitConfig`, `localBinding`, `machLookup`, `network`, `pty`, `read`, `systemInfo`, `unixSockets`, `write` |
| `tasks.<name>.exec.sandbox.deny`   | `network`                                                                                                 |
| `tasks.<name>.exec.sandbox.ignore` | `gitConfig`, `localBinding`, `machLookup`, `network`, `pty`, `read`, `systemInfo`, `unixSockets`, `write` |
| `tasks.<name>.cache`               | `inputs`, `outputs`                                                                                       |
| `tasks.<name>.cache.inputs`        | `env`, `files`, `runtime`, `tasks`, `workspaceFiles`, `workspaceRuntime`                                  |
| `tasks.<name>.cache.outputs`       | `files`, `workspaceFiles`                                                                                 |

Keyed by name: `tasks`, `tasks.<name>.exec.env.define`.

`sandbox.ignore` names `pty` and `gitConfig` only to refuse them ("a
flag, not something to ignore"). The record holds that refusal too.

### The plugin API

- **Hooks**, in pipeline order: `config`, `project`, `graph`, `key`,
  `fingerprint`, `schedule`, `admit`, `executor`, `cache`, `telemetry`,
  `setup`, `commands`, `teardown`. A plugin is
  `definePlugin(import.meta, hooks)`, and its name is its package's.
- **Telemetry records**, schema version 3. The kinds are `run.start`,
  `task.start`, `task.log`, `task.end` and `run.end`; each record
  carries the version as `v`.
- **Types.** Every type `@vzn/vx` exports is frozen with every type it
  names, whether that one is exported or not. `VxPlugin` and its hook
  contexts, `CacheLayer`, `RemoteCacheLayer`, `TaskExecutor`,
  `ExecuteRequest` / `ExecuteResult`, `TelemetrySink` and
  `TelemetryRecord` are the ones a plugin implements or receives. The
  full text is `tests/contract/package-api.txt`.

### The CLI

The verbs, flags, exit codes and machine-readable outputs in `docs/cli.md`.

## How the contract is held

A surface is frozen only if a change to it fails a test. Each pin
records the surface as the code produces it, in a committed file, so a
change is a reviewed diff of that file and never a side effect.

- **The config schema.** `tests/contract-config-schema.test.ts`
  discovers every level and field the validator accepts (by injecting
  an unknown key at each level of a valid seed config and reading the
  refusal's `allowed:` list), probes each field with a fixed set of
  values, and compares every outcome, acceptance or exact refusal text,
  with `tests/contract/config-schema.json`. The same file holds each
  level's field list to its exported interface in `src/config.ts`
  through the type checker, so the TypeScript surface and the runtime
  surface cannot drift apart. A deliberate change regenerates the
  record with `VX_UPDATE_CONTRACT=1` (the command is in the test's
  header) and names the change in the release notes.
- **The plugin API and the package's exports.**
  `tests/contract-package-api.test.ts` reads, from the source, every
  declaration `src/index.ts` exports and every type those name,
  transitively (followed through imports and re-exports, so an internal
  type a plugin meets in a signature is held too): a type in full, a
  function to its signature, a class to its public members, comments
  dropped. With the runtime values of the exported constants
  (`PLUGIN_HOOKS`, `TASK_STATUSES`, `TELEMETRY_SCHEMA_VERSION`, …) it is
  compared with `tests/contract/package-api.txt`. A second row holds
  `VxPlugin`'s members to `PLUGIN_HOOKS`. The façade snapshot in
  `package-boundaries.unsafe.test.ts` still pins the export names;
  this pins their shapes. Regenerate the same way.

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

The removal is held in code. `REMOVED_FIELDS` in `config-schema.ts`
maps each level's field set to the fields it once took, each with the
version that removed it and what to use instead. The unknown-field check
consults it before it calls a key unknown, so a removed field gets a
refusal of its own:

```text
vx.config.ts: tasks.build.exec has field "resources", which vx 0.0.19 removed — use
`@vzn/vx-schedule-history`, which learns each task's reservation from its run history
(declare one by hand with its `reservations: { 'pkg#task': { cpus, memory } }`)
```

An entry stays for good, since a config written against an old release
meets it whenever it upgrades. `tests/contract-removed-fields.test.ts`
holds that example word for word and every entry to the same shape (out
of its level's accepted fields, a semver `removedIn`, a replacement).

No field is deprecated today, so step 1's warning has no code yet. The
first deprecation builds it beside `REMOVED_FIELDS`, with a row that
it prints once per run.

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
