# `src/*.ts` — the package root

## `src/index.ts` — public package surface

### Purpose

The single entry point for `import x from '@vzn/vx'`. Everything in
this file is the public API; everything else under `src/` is
internal. This is the **cross-package contract**: the plugin packages
(`@vzn/vx-reapi`, `@vzn/vx-otel`, `@vzn/vx-ci`,
`@vzn/vx-migrate`, `@vzn/vx-lockfile`, `@vzn/vx-history`) and
any third-party plugin import everything they need from here via the
bare `'@vzn/vx'` specifier — never a deep `src/...` path
(`tests/package-boundaries.unsafe.test.ts` pins it). The runtime symbol
set (60 names) is pinned by the same test; widening it is a deliberate
snapshot update. A seam with no consumer leaves the façade — the graph
primitives, the hashing seam, the event bus wire form and the
run-history readers went on 2026-09-10 — and is re-added, shaped by its
use, when one appears.

### Public surface (by group)

The table names every export: the values column is the runtime symbol
set, the types column every `export type`, and
`tests/module-shape-drift.test.ts` holds both columns to the file. Each
export's declaration and doc comment are in [the API reference](../api.md),
generated from the source.

| Group            | Values                                                                                                                                                                                                                                                                               | Types                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Version + errors | `VERSION`, `UserError`, `isUserError`                                                                                                                                                                                                                                                | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Schema           | `defineProject`, `defineWorkspace`, `PLUGIN_HOOKS`, `PLATFORMS`                                                                                                                                                                                                                      | `WorkspaceConfig`, `Platform`, `RunSettings`, `CacheSettings`, `LockSettings`, `WatchSettings`, `Duration`, `ProjectConfig`, `TaskConfig`, `ExecConfig`, `ExecEnv`, `InputsConfig`, `TaskOutputs`, `InputStability`, `SandboxConfig`, `SandboxGrants`, `SandboxDenials`, `PluginHook`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Engine           | `run`, `planRun`, `prepareRun`, `splitTaskId`, `taskDefinitions`, `criticalPath`, `outputsOverlap`, `isLiteralPattern`, `normalizeGlob`, `localHistory`, `currentBranch`                                                                                                             | `RunOptions`, `RunSummary`, `CacheFlags`, `CachePolicy`, `Logger`, `OutputView`, `PreparedRun`, `AffectedChanges`, `RunPlan`, `PlannedTask`, `TaskView`, `OutcomeView`, `OutputContext`, `TaskNode`, `TaskOutcome`, `SucceededOutcome`, `FailedOutcome`, `AbortedOutcome`, `SkippedOutcome`, `OutcomeTiming`, `OutcomeUsage`, `OutcomeCache`, `OutcomeSandbox`, `SandboxFix`, `OutcomeAttempts`, `OutcomePlacement`, `InputChanges`, `TaskStatus`, `HistoryProvider`, `HistoryTable`, `LocalHistory`, `LocalHistoryOptions`, `MeasureForecast`, `TaskHistory`, `TaskResources`, `CiContext`, `GitContext`, `HostContext`, `WorkspaceIdentity`, `WorkspaceInputs`, `WorkspaceOutputs`                                                                                                                                                                                                                                                                                                                                                        |
| Machine          | `machineParallelism`, `machineMemoryBytes`, `hostPlatform`                                                                                                                                                                                                                           | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Cache            | `Cache`, `CorruptArtifactError`, `restorableOutput`, `outputDirPrefixes`, `branchCacheScope`, `mergeBaseWith`                                                                                                                                                                        | `ArtifactInfo`, `CacheLayer`, `PluginCache`, `RemoteCacheLayer`, `RemoteOpenContext`, `RunRecord`, `InvocationRecord`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Workspace        | `findWorkspaceRoot`, `PROJECT_CONFIG_FILENAMES`, `loadProjectConfig`, `loadResolvedProjects`                                                                                                                                                                                         | `ProjectMeta`, `ProjectEntry`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Migration        | `applyMigration`, `isStarterConfig`, `PERSISTENT_TODO`, `pruneOrphanPersistentNotes`, `quoteTsLiteral`, `taskNameProblem`                                                                                                                                                            | `ApplyMigrationArgs`, `MigrationFormat`, `MigrationMember`, `GeneratedProject`, `GeneratedTask`, `MigrationPlan`, `RawExpr`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Output           | `ui`                                                                                                                                                                                                                                                                                 | `ui.Block`, `ui.Inline`, `ui.FieldRow`, `ui.NoticeParts`, `ui.Tone`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Plugin API       | `definePlugin`, `lockfileClaim`, `reachDigests`, `refuseUnknownOptions`, `executorFallback`, `withForwardArgs`, `localFloor`, `isSecretUnavailable`, `secretNamed`, `packageManagerPath`, `answerRuntime`, `sandboxRequestFor`, `sweepPlaceholders`, `sampleTrees`, `BoundedCapture` | `VxPlugin`, `PluginHooks`, `PluginOrigin`, `SandboxRequest`, `PluginOptionKinds`, the hook contexts (`WorkspaceHookContext`, `ConfigContext`, `DiscoverContext`, `ProjectHookContext`, `GraphHookContext`, `KeyHookContext`, `FingerprintContext`, `ScheduleHookContext`, `AdmitContext`, `CacheContext`, `CacheFacts`, `LentAccess`, `ExecutorContext`, `CommandContext`, `PluginSetupContext`), `BranchFacts`, `RunReport`, `RunReportTask`, `PluginHookName`, `PluginHookHandlers`, `RunStartInfo`, `Measure`, `DiscoveredProject`, `FingerprintClaim`, `FingerprintChange`, `FingerprintDigests`, `LockedFile`, `PluginCommand`, `LockfileClaimHooks`, `LockfileClaimOptions`, `ReachGraph`, `TaskExecutor`, `ExecuteRequest`, `ExecuteResult`, `ExecuteSandbox`, `MachineReport`, `WorkerAdvice`, `ResolvedSandboxConfig`, `TaskPlacement`, `LocalFloor`, `PluginSecrets`, `SecretRequest`, `SecretUnavailable`, `SecretUnavailableReason`, `ServerSpec`, `TaskArtifacts`, `ArtifactTask`, `ArtifactRun`, `CapturedChunk`, `TreeUsage` |
| Telemetry        | `TELEMETRY_SCHEMA_VERSION`, `isPassStatus`, `isCacheHit`, `TaskLogBuffer`, `LOG_WIRE_VERSION`, `exitSignal`                                                                                                                                                                          | `TelemetrySink`, `TelemetryContext`, `TelemetryRecord`, `RunSummaryRecord`, `RunContextRecord`, `TaskTelemetry`, `CacheSource`, `TaskLogBundle`, `TaskLogEntry`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

Core reads no package manager's members: `@vzn/vx-migrate` does, for
an adoption (2026-10-14). `PROJECT_CONFIG_FILENAMES` is the names a
project config may take, in the order the loader prefers them.

### Conventions

- **Types are exported with `export type`** so a downstream
  TypeScript project can import them without paying any runtime cost.
- **Everything routes through module contracts** — `index.ts` imports
  only from each module's `index.ts` (boundary-test rule 2).
- **Widening is deliberate.** Adding an export means updating the
  package-boundaries snapshot; that friction is the point. A helper
  goes on the façade on a demonstrated need — a plugin package that
  rolled its own copy (`isPassStatus`,
  `TaskLogBuffer`, `exitSignal`, `withForwardArgs` each got here that way).

### Versioning

`VERSION` is `package.json`'s `version`, imported as JSON (Bun inlines
it under `bun build --compile`), so the banner cannot drift from the
manifest. The tree says `0.0.0`; a release (`npm.yml`, on a published
GitHub release or by hand) stamps the tag's version into the manifest
before compiling the binaries and publishing, so only a published build
carries a real number.

### Tests

`tests/package-boundaries.unsafe.test.ts` pins the export snapshot and the
cross-package import law; `tests/module-shape-drift.test.ts` holds the
table above to the file. `tests/config.test.ts` imports the schema
helpers; `tests/orchestrator.test.ts` imports `run`.

## `src/bin.ts` — binary entry point

### Purpose

The shebang script invoked when the user runs `vx`. Forwards
`process.argv` to `cli.run`, prints errors with the right level of
detail, and sets the right exit code.

### Behavior

A lone `--version` (or `version`) is answered from `version.ts` before
anything else loads: the dispatcher and the util barrel were 20 ms of
its 28 (#1961). Otherwise `main()` imports the dispatcher, forwards
`process.argv.slice(2)` to it (`cli/index.ts`'s `run`) and sets `process.exitCode` to the code it returns, then lets
the event loop drain — nothing calls `process.exit` or `stdout.end`.
Bun drops what a pipe has not yet taken when `process.exit` follows a
large write (300 KB written then exit delivered 64 KiB; `vx history
--format json` on a 300-project workspace was cut mid-string,
2026-09-15), and on 1.3.11 `stdout.end`'s callback fired early too
(2 MiB written, 214 KB delivered, 2026-09-20); draining does not depend
on when a runtime calls a pipe flushed. A thrown error is printed and
`exitCode` is 1: a `UserError` (`isUserError`,
so a plugin's own class of that name counts) as its message alone,
prefixed `vx:` unless the message already names the verb (`vx why: …`);
a file-system refusal (`isFsRefusal`) as its message plus the hint that
names the knob; anything else with its stack, since an internal bug
must stay debuggable. Both streams get an `error` listener before any
of that: a reader that leaves (`vx run build | head -1`) turns every
later write into EPIPE, and an unheard `error` event killed a green
run with a stack and exit 1 (2026-09-16); with the listener the run
finishes, saves, releases its lock and exits with its own verdict.
A loop that drains before the verb settles (a plugin hook whose promise
never resolves) is a failure: a `beforeExit` listener says so on stderr
and sets exit 1 (item 921). The wrapper is an explicit `async main()`
because `bun build --compile` refuses top-level await.

Before any verb runs, bin.ts registers the **core alias**
(`cli/core-alias.ts`): a Bun virtual module for the exact specifiers
`@vzn/vx` and `@vzn/vx/config`, served lazily from this process's own
façade and config module. Every plugin
package, workspace file and project config that imports `@vzn/vx`
then gets the running core — one module state per process, and in the
compiled binary no second copy of core transpiled from `node_modules`
(a plugin package's import: 20–25 → 2–3 ms; a live-evaluated config's:
22 → 2 ms; a workspace file with no `@vzn/vx` installed at all loads).
`tests/core-alias.test.ts` pins it differentially against a fake
`node_modules/@vzn/vx`.

`vx` is shipped two ways:

1. **As a Bun-runnable script** — `bin: "src/bin.ts"` in `package.json`,
   shebang `#!/usr/bin/env -S bun --no-env-file --no-install`. Bun runs the
   TypeScript directly.
2. **As a standalone binary** — `bun build --compile
--no-compile-autoload-dotenv --compile-autoload-package-json --minify
--bytecode --target=bun-<target> src/bin.ts --outfile dist/vx-<target>`.
   The cross-target binaries are published on each GitHub release.

Both switches keep Bun from loading `.env`, `.env.local` and
`.env.<NODE_ENV>` from the working directory into vx's own environment,
where every `passThrough` and essential variable and every `VX_*` switch
is read: a task saw a value no shell had set (item 1089). Running the
source as `bun src/bin.ts`, as this repository's own gate does, is not
the shebang, and Bun loads a `.env` there.

`--compile-autoload-package-json` makes the binary read an on-disk
package's `package.json` when it resolves one. Without it a compiled
Bun resolves a package only by its root `index.*`, ignoring `main` and
`exports`: a config importing `@vzn/vx-reapi` failed on
`cannot find '@grpc/grpc-js'` (`main: build/src/index.js`), though
`bun src/bin.ts` loaded it (#1891). `scripts/check-binary.ts` holds it.

`--no-install` keeps Bun from auto-installing a bare import no
`node_modules` provides: a helper a config imports fetched the package
from the registry and ran it (L-22). The loader now refuses a static
bare import in the config and in each file it imports before evaluation;
the flag still covers what no scan sees, a computed `import()`. The npm launcher's source fallback passes
both flags; a compiled binary never auto-installs. `bun src/bin.ts` is
not the shebang here either.

### What this does NOT do

- **Doesn't parse argv** past the lone `--version` it answers. That's
  `cli/index.ts` (dispatcher) and `cli/<sub>.ts` (per-subcommand
  parsers).
- **Doesn't import the orchestrator directly.** The CLI does. This
  keeps `bin.ts` tiny and lets tests import `cli/index.ts` without going
  through a process boundary.

### Tests

No unit file: the end-to-end suites spawn `src/bin.ts` as the real
CLI (`tests/cli.test.ts` and the dozens that drive a fixture through
it), the piped-stdout flush and the EPIPE listener each have their pin
there, and `bun src/bin.ts run <task>` is how CI invokes vx.

## `src/config.ts` — the public schema

The single source of truth for what users can write in `vx.config.ts`.
Pure types + two identity helpers; no runtime logic.

### Purpose

Defines every interface the rest of the codebase consumes:
`ProjectConfig`, `TaskConfig`, `ExecConfig`, `ExecEnv`,
`PersistentConfig`, `SandboxConfig` (with its `SandboxGrants`,
`SandboxDenials` and `SandboxIgnore`), `InputsConfig`, `TaskOutputs`, `InputStability`,
`WorkspaceConfig` — and the plugin contract a workspace file declares:
`Plugin`, the `PLUGIN_HOOKS` list every table and host reads (with
`PluginHook` and the function-valued subset `PLUGIN_FUNCTION_HOOKS`),
and `PLUGIN_PACKAGE`, the symbol `definePlugin` stamps a plugin's
package name under.

Exports two helpers — `defineProject` and `defineWorkspace` — that
exist purely so TypeScript can narrow the user's literal types via the
generic parameter. A config that imports them at runtime gets the
running core's own copy — bin.ts aliases the `@vzn/vx` specifier to
its façade (cli/core-alias.ts), so the compiled binary no longer loads
a second core for an identity function (22 → 2 ms per live-evaluated
config, measured 2026-09-10). The scaffolds still write the type-only
`satisfies` form, which types the same with nothing to resolve.

### Public surface

```ts
// Types
export interface ProjectConfig
export interface WorkspaceConfig // { run, cache, inputs, outputs, lock, watch, plugins }
export interface RunSettings // `run`: concurrency, schedule, timeout, retries, rules …
export interface CacheSettings // `cache`: dir, retention, policy, scope, download
export interface WorkspaceInputs // `inputs`: stability
export interface WorkspaceOutputs // `outputs`: clean
export interface LockSettings // `lock`: reviewFiles
export interface WatchSettings // `watch`: poll
export interface WorkspaceRules // `run.rules`: graph checks, each on unless false (X-53); `dependencies`, checked by `vx lock`
export interface DependencyRule // { from, allow?, deny? }: selectors `tag:<tag>` or a project name, `*` a wildcard
export type Duration // '500ms', '30s', '10m', '12h', '30d': every duration carries its unit
export interface TaskConfig
export interface ExecConfig
export interface ExecEnv
export interface PersistentConfig
export interface SandboxConfig
export interface SandboxGrants
export interface SandboxDenials
export interface SandboxIgnore
export interface InputsConfig
export interface TaskOutputs
export interface InputStability

// The plugin contract
export interface Plugin
export const PLUGIN_PACKAGE: unique symbol
export const PLATFORMS: readonly Platform[] // what `exec.platforms` may name: linux-x64, linux-arm64, darwin-x64, darwin-arm64
export type Platform
export const PLUGIN_HOOKS: readonly PluginHook[] // every hook name, in pipeline order
export type PluginHook
export const PLUGIN_FUNCTION_HOOKS: readonly PluginHook[] // the hooks that are functions (not `commands` or `fingerprint`, which are objects)

// Helpers (identity functions)
export function defineProject<const T extends ProjectConfig>(config: T & DependsOnTyped<T>): T
export function defineWorkspace<T extends WorkspaceConfig>(config: T & Known<T, WorkspaceConfig>): T
```

`defineProject`'s parameter is `T` intersected with a mapped type over
`T['tasks']` that types each task's `dependsOn` entries against the
project's own task names (`'build'`, `'^build'`, a `pkg#task`), so a
typo in a same-project dependency is a type error at the call site;
`const T` keeps the literal types. The same intersection types every
key the schema does not declare as `never`, at the top, on each task,
and in its `exec`, `exec.env`, `exec.persistent`, `exec.sandbox` (and
its `allow`, `deny`, `ignore`, D-156), `cache`, `inputs` and
`outputs`: a
generic argument skips TypeScript's excess-property check, so a
Turbo-shaped `outputs` on a task or a `cwd` in `exec` type-checked and
failed only when vx loaded the config (D-69). `defineWorkspace` does
the same for its keys, `inputs.stability`'s and `rules`': a lone unknown key failed
TypeScript's weak-type check, but a typo beside a known one
(`{ plugins, concurency }`, D-70; `rules: { exclusiveOutput }`,
D-155) type-checked.

`TaskConfig.dependsOn` is `readonly string[]` (Turbo/Nx
micro-syntax — see [`schema.md`](../schema.md)).
`InputsConfig.tasks` is the same shape with `*` / `^*` / `!` filter
extras.

See [`../schema.md`](../schema.md) for the full reference of every
field's meaning.

### Why an identity helper

```ts
export function defineProject<const T extends ProjectConfig>(config: T & DependsOnTyped<T>): T {
  return config as T
}
```

Two reasons:

1. **Type inference.** When a user writes `defineProject({ tasks: {...} })`,
   the generic `const T extends ProjectConfig` lets TypeScript infer the
   _literal_ types of nested fields (so task names autocomplete, union
   types narrow correctly, and `dependsOn` is checked against them).
2. **Forward compat.** If we ever need to do runtime validation or
   transformation on the config, `defineProject` is the place; user
   code already calls through it.

The function body is a one-liner today and that's by design.

### Invariants

- The exported types and helpers are the **only** public contract.
- The types and `config-schema.ts` name the same keys at every level
  (workspace, project, task, `exec`, `exec.env`,
  `exec.persistent`, `exec.sandbox` and its `allow` / `deny` /
  `ignore`, `cache`, `inputs`, `outputs`):
  `tests/config-types-schema.test.ts` holds each list to the type with
  the type-checker and to the validator by its own refusal (D-71). With
  undeclared keys typed `never` (D-69, D-70), a drift either way is a
  config that loads but does not type-check, or the reverse.
  Internal modules import them; user code imports them via `@vzn/vx`.
- No field is optional in the schema if it's required for correctness.
  When `cache` is provided, `inputs.files` and
  `outputs.files` are required by the type system (not just at
  runtime).
- The types are JSON-serializable. No `Function` fields, no
  `Date` objects. This is what makes the task-config digest —
  `xxh3hex(JSON.stringify(hashableConfig(config)))` in
  `task-hash.ts` — well-defined. A config that is plain JavaScript
  can still hold anything, so the loader enforces it at runtime on
  every path (item 701, `workspace/json-data.ts`, config-schema.md).

### Replacing this module

You wouldn't, normally — the schema is the user-facing API. Changes
here are breaking.

If you're forking the project, the things you might want to change:

- **Add a new top-level field.** Update `TaskConfig`, the validator
  (`workspace/config-schema.ts`), the key (`orchestrator/task-hash.ts`:
  `hashableConfig` strips placement-only fields) and the consumer in
  `execute-task.ts`; bump `CACHE_VERSION` if the field affects caching.
- **Drop a field.** Mark deprecated in JSDoc for a release, then
  remove. Bump `CACHE_VERSION`.
- **Tighten a field's type.** Same considerations as add, but check
  every consumer module.

### Tests

`tests/config.test.ts` covers identity behavior + generic type
preservation. Type-level correctness is enforced by
`oxlint --type-aware --type-check` in the gate across all consumers
(there is no build).

## `src/settings.ts` — every vx setting, once

### Purpose

The one list of run-wide settings. A setting's path is its
`.vx/workspace` key (`run.concurrency`); its variable
(`VX_RUN_CONCURRENCY`) and flag (`--concurrency`) derive from that path. The CLI parsers, the
workspace validator, `vx info`'s `settings` fact and the settings tables
in `schema.md` and `cli.md` all read it, so a setting cannot exist in
one and be missing in another (`tests/settings.test.ts`).

### Public surface

```ts
export const SETTINGS: readonly Setting[]
export const SETTING_GROUPS: readonly ['run', 'cache', 'watch']
export function setting(path: string): Setting
export function kindHint(kind: SettingKind): string
export function atPath(config: unknown, path: string): unknown
export function runRules(workspace: unknown): { exclusiveOutputs?: boolean }
export function envName(path: string): string
export function parseSettingValue(kind: SettingKind, raw: unknown): unknown
export function settingRefusal(path: string, where: string, raw: unknown, got?: string): string
export function settingEnv(path: string, env?: NodeJS.ProcessEnv): unknown
export function checkSettingsEnv(env?: NodeJS.ProcessEnv, args?: readonly string[]): void
export function resolveSetting(
  path: string,
  workspace: unknown,
  flag?: unknown,
  env?: NodeJS.ProcessEnv,
): { value: unknown; source: SettingSource }
```

### Rules

- Precedence: flag, then variable, then `.vx/workspace`, then the
  default. A task's `exec.timeout` / `exec.retries` beats all of them.
- No aliases: until 1.0 an old variable is ignored and an old flag is
  an unknown flag.
- A setting with `config: false` is read before `.vx/workspace` loads,
  so it has a variable and maybe a flag, no key.
- The CLI checks every set variable up front (`checkSettingsEnv`), so a
  deep reader may fall back on a bad value instead of throwing. A
  variable whose flag the command line holds is skipped: the flag beats it.

`src/orchestrator/run-settings.ts` fills a run's options from this
list once, before any task (`withRunSettings`).

## `src/version.ts` — the VERSION constant

### Purpose

A one-export leaf holding the package version string. Extracted from
`index.ts` so that `cli` and `orchestrator` (which print the version
in banners/`--version`) don't import the public façade — that import
formed a cycle (`index → orchestrator → index`) that only worked via
ESM live-binding hoisting.

### Public surface

```ts
export const VERSION: string
```

`index.ts` re-exports it, so the public package name is unchanged.

The single source of truth is `package.json`: the file imports it
(`pkg.version`), Bun resolves the JSON import natively and inlines it
under `bun build --compile`, so a release bump can never drift from
what `--version` and the footer print.

### Replacing this module

A version from anywhere else (a build stamp, a git describe) is this
one import to change; every reader takes `VERSION`.

## `src/handoff.ts` — the workspace root, and the hand-off to its vx

### Purpose

The workspace root is the directory holding the nearest `.vx/workspace.*`
from the working directory up to the git top-level, or up to `/` outside
git (2026-10-13: "Workspace file is the ultimate", "never go out
of git root"). Nothing else decides it. `findWorkspaceRoot` (workspace
module) and the hand-off both ask `workspaceFile`, once per run.

A global vx runs the project's own `@vzn/vx` when one exists
(2026-10-13): the root's `node_modules/@vzn/vx`, through its
`node_modules/.bin/vx`. This module is the compiled binary's half;
`npm-launcher.sh` does the same walk in the shell for an npm install and
`exec`s. `bin.ts` calls it before anything else loads.

### Public surface

```ts
// `vx upgrade -g`: moves only the global, so bin.ts hands nothing off
export function upgradesOnlyItself(argv: readonly string[]): boolean
// the root's own vx to run instead, or null: handed off already, not a
// standalone compiled binary (source; an npm install, whose launcher
// walked), no workspace, itself, or owned by another user than `uid`
export async function localVx(
  cwd: string,
  execPath: string,
  compiled: boolean,
  uid?: number,
): Promise<string | null>
// run it with this process's stdio and arguments, pass on a signal sent to
// this vx alone (from its first instant: the handlers precede the spawn),
// exit with its code; die of the SIGINT, SIGTERM or SIGHUP it
// died of (another signal: 128 + signo), so a script running vx stops too
export async function handOff(bin: string, args: readonly string[]): Promise<never>
// the git top-level holding `dir` (a `.git` dir, or a worktree's `.git` file;
// a submodule's goes on to its superproject), null outside git; once per dir
export function gitTop(dir: string): Promise<string | null>
// the nearest .vx/workspace.* from `dir` up to the git top-level (or `/`
// outside git), null when none; once per directory walked. Any entry by
// a name marks the root; the first that is a file wins, else the first
export function workspaceFile(dir: string): Promise<string | null>
// the entry workspaceFile found is no file (a broken link, a directory):
// findWorkspaceRoot refuses it by name
export function workspaceFileBroken(file: string): boolean
// vx wrote a workspace config (`vx init`): forget what the walks learned
export function workspaceFileWritten(): void
// the six paths from the root, in lookup order (ts mts js mjs cts cjs)
export const WORKSPACE_CONFIG_FILENAMES: string[]
// the root a found `.vx/workspace.*` marks: the directory holding its `.vx`
export function workspaceRootOf(file: string): string
export function vxPath(): string // the compiled binary, else the source entry
```

### Invariants

- One hop: the child gets `VX_HANDED_OFF` (this vx's path), and a vx that
  sees it never walks. `vx --version` and the doctor (`vxPath`,
  `handedOffFrom`) report it.
- Never to itself: the launcher compares with `-ef` (a pnpm symlink is
  the same package); the binary compares realpaths.
- Never to another user's: the launcher tests `-O`, the binary the
  real file's uid. A `node_modules` planted above your checkout would
  otherwise run as you.
- The hand-off and `findWorkspaceRoot` find the same root:
  `workspaceFile` learns it once per run for both, and the workspace
  config loader reads the file it found with no second probe
  (principle 9; `tests/load-reads.test.ts`). The one write vx makes to
  it, `vx init`'s, clears what was learned, so the lock init runs next
  loads the plugins just written (`tests/init.test.ts`, "ends with the lock").
- The walk is a stat of `.vx/workspace.ts` per level, then, without
  it, one listing of `.vx` (`Bun.Glob`: a level with none is one failed
  open, where a stat per name was six) and a stat of the names it holds, no read but a `.git` file's first line, no import
  of `node:fs`. Any entry by a name stops it, a broken link or a
  directory too, as `findProjectConfigs` counts one a nested workspace
  and `npm-launcher.sh` tests `-e` or `-L`: `tests/handoff.test.ts` holds
  the shapes (a local install, none, the global itself, a pnpm symlink,
  a submodule, a worktree) for both halves, and
  `tests/workspace-root-file.test.ts` the root.
- The vx that hands off waits out the run beside its tasks, so it hides
  its env first (`util/hide-env`), as every verb does; it never reaches
  the verb that would (`tests/hide-env.unsafe.test.ts`).
