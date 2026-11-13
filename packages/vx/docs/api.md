# API reference

Every export of `@vzn/vx`, generated from `src/index.ts` by
`tests/api-reference.test.ts`: the declaration (comments dropped, a
function to its signature, a class to its public members) and the doc
comment above it. [The public surface](modules/index.md#srcindexts--public-package-surface) groups the
same names by what they are for; the plugins guide shows them in use.

## `AbortedOutcome`

type · `src/graph/outcome.ts`

A shutdown (SIGINT/SIGTERM) stopped it, or stopped the run before it
began: it never finished on its own terms. `exitCode` is the signal's,
which the run's history keeps.

```ts
export interface AbortedOutcome
  extends StartedOutcome, None<FailureFacts>, BlockFacts, None<PlatformFacts> {
  status: 'aborted'
  serverExit?: number
}
```

## `AdmitContext`

type · `src/orchestrator/plugin.ts`

```ts
export interface AdmitContext {
  readonly running: readonly TaskNode[]
  readonly concurrency: number
}
```

## `AffectedChanges`

type · `src/workspace/affected.ts`

What `--affected` seeds its tasks from: changed projects, each one's changed
paths, and the projects a change reaches whole (a lockfile claim, a config
import, a nested repository, a workspace-wide file), where every task is
affected.

```ts
export interface AffectedChanges {
  projects: Set<string>
  changed: readonly string[]
  paths: ReadonlyMap<string, readonly string[]>
  whole: ReadonlySet<string>
  wholeBy?: ReadonlyMap<string, string>
  wide?: boolean
  nested?: readonly string[]
  dirLinks?: ReadonlySet<string>
  dirLinksIn?: ReadonlyMap<string, ReadonlySet<string>>
  untrackedIn?: ReadonlyMap<string, ReadonlySet<string>>
  untracked?: ReadonlySet<string>
}
```

## `applyMigration`

function · `src/orchestrator/migration.ts`

Render a plan to files, refuse to overwrite without `force`, write (or
print, under `dry`), and report. Returns the process exit code.

```ts
export async function applyMigration(args: ApplyMigrationArgs): Promise<number>
```

## `ApplyMigrationArgs`

type · `src/workspace/migration.ts`

```ts
export interface ApplyMigrationArgs {
  root: string
  metas: readonly MigrationMember[]
  plan: MigrationPlan
  source: string
  verb: string
  dry: boolean
  force: boolean
  init?: boolean
  notes?: readonly string[]
  emptyReason?: string
  example?: boolean
  written?: (relPaths: readonly string[]) => readonly string[]
  format?: MigrationFormat
  json?: boolean
  lock?: (root: string) => Promise<{ code: number; said: string }>
  steps?: readonly (readonly [label: string, value: string])[]
  plugins?: readonly WorkspacePlugin[]
}
```

## `ArtifactInfo`

type · `src/cache/layered-cache.ts`

What a remote knows of an artifact before download: its size and the
producing task's duration, when the wire carries them.

```ts
export interface ArtifactInfo {
  readonly size?: number
  readonly durationMs?: number
}
```

## `ArtifactRun`

type · `src/orchestrator/task-artifacts.ts`

What a task's run left besides its files: its output, and its time and usage.

```ts
export interface ArtifactRun {
  readonly output: readonly CapturedChunk[]
  readonly durationMs: number
  readonly cpuMs?: number
  readonly peakRssBytes?: number
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly secret?: readonly string[]
  readonly absent?: boolean
}
```

## `ArtifactTask`

type · `src/orchestrator/task-artifacts.ts`

The task a `TaskArtifacts` call names: where its outputs are and what ran.

```ts
export interface ArtifactTask {
  readonly id: string
  readonly projectDir: string
  readonly command: string
  readonly outputs: {
    readonly files: readonly string[]
    readonly workspaceFiles: readonly string[]
  }
  readonly nestedProjectDirs?: readonly string[]
  readonly others?: ReadonlySet<string>
}
```

## `branchCacheScope`

function · `src/workspace/config-schema.ts`

A branch's cache scope, `<owner>/<repo>:<branch>`: what CI writes for a
branch and a laptop on it reads. The repository's
identity, not a remote's local name, so a clone whose `origin` is a fork
names the fork. A name may hold characters a scope may not; each
becomes `_`.

```ts
export function branchCacheScope(repo: string, branch: string): string
```

## `BranchFacts`

type · `src/orchestrator/plugin.ts`

What CI knows of the run's branch: `scope`, the cache scope
(`VX_CACHE_SCOPE` beats it, it beats git's); `base`, the commit compared
with (a PR's base), for a bare `--affected`; `trusted`: no scope, whatever
git says (a merge queue). The scope keys plugin entries only. `refs`: the
refs a remote reads, in order; unset, git's. A later plugin's field wins.

```ts
export interface BranchFacts {
  scope?: string
  base?: string
  trusted?: boolean
  refs?: readonly string[]
}
```

## `Cache`

class · `src/cache/cache.ts`

```ts
export class Cache implements CacheLayer {
  readonly hasRemote
  readonly uploads: UploadTally
  readonly downloads: { count: number; bytes: number }
  readonly traffic: RemoteTraffic
  static inspect(cacheDir: string): Cache
  constructor(
    cacheDir: string,
    localPolicy: { read: boolean; write: boolean } = { read: true, write: true },
    repoDir?: string,
    artifactCeiling: number = MAX_DECOMPRESSED_ARTIFACT_BYTES,
    mode: 'open' | 'inspect' | 'preview' = 'open',
    storeRoot?: string | null,
    store: StoreOptions = DEFAULT_STORE,
  )
  get runId(): string | undefined
  set runId(runId: string | undefined)
  get remoteHits(): RemoteHits
  get storeDir(): string | undefined
  get schemaReset(): SchemaReset | null
  get storeReset(): SchemaReset | null
  get memo(): StoreMemo
  key(input: CacheKeyInput): Promise<string>
  async prefetch(_hash: string, _ctx?: CacheGetContext): Promise<boolean>
  async get(hash: string, ctx?: CacheGetContext): Promise<CacheEntry | null>
  getIngested(hash: string): Promise<CacheEntry | null>
  getSaved(hash: string): Promise<CacheEntry | null>
  holdsNothing(): boolean
  async getMany(
    hashes: readonly string[],
    ctx?: (hash: string) => CacheGetContext,
  ): Promise<Map<string, CacheEntry>>
  async has(hash: string): Promise<'local' | 'remote' | null>
  async localHasMany(hashes: readonly string[]): Promise<Set<string>>
  outputsPath(hash: string): string
  outputBytes(hash: string): number | undefined
  kept(hash: string): boolean
  artifactSize(hash: string): number | undefined
  async restoreOutputs(
    hash: string,
    projectDir: string,
    workspaceRoot?: string,
    outputs?: DeclaredOutputs,
  ): Promise<void>
  assertWritable(): void
  readOnlyNotice(): string | null
  async save(args: {
    hash: string
    entry: Omit<CacheEntry, 'hash' | 'storedAt' | 'outputFiles' | 'exitCode'>
    projectDir: string
    outputFiles: string[]
    outputDirs?: string[]
    workspaceOutputFiles?: string[]
    workspaceOutputDirs?: string[]
    workspaceRoot?: string
    inputComponents?: readonly TaskInputRow[]
  }): Promise<void>
  get localWritesEnabled(): boolean
  packArtifactBytes(args: SaveArgs): Promise<Uint8Array>
  async pinArtifact(hash: string): Promise<{ body: Blob; release: () => Promise<void> }>
  async ingest(hash: string, body: Blob | Response, meta: IngestMeta): Promise<void>
  checkpointOffThread(): void
  async stopCheckpoints(): Promise<void>
  stats(opts: CacheStatsOptions = {}): CacheStats
  async prune(options: PruneOptions): Promise<PruneResult>
  async orphanStats(): Promise<{ orphans: number; orphanBytes: number }>
  close(): void
}
```

## `CacheContext`

type · `src/orchestrator/plugin.ts`

A `cache` hook's context: the workspace and the run's scope, never the local store or the policy, which core owns.

```ts
export interface CacheContext extends BaseContext {
  readonly scope: string | undefined
  readonly refs: readonly string[]
  readonly lent?: () => string | undefined
}
```

## `CacheFacts`

type · `src/orchestrator/task-artifacts.ts`

What a run's cache is read under, for a machine that runs its tasks
(`ExecutorContext.cacheFacts`, `CommandContext.artifactsFor`): the
refs the run worked out, so that machine reads as the run would, and
the access each remote lent, by plugin.

```ts
export interface CacheFacts {
  readonly refs: readonly string[]
  readonly lent: Readonly<Record<string, string>>
  readonly expiresAt?: number
}
```

## `CacheFlags`

type · `src/cache/policy.ts`

`--no-cache` and `--force`, which still apply over whichever spec set the base.

```ts
export interface CacheFlags {
  noCache?: boolean
  force?: boolean
}
```

## `CacheLayer`

type · `src/cache/layer.ts`

The shape every cache implementation honours, so `executeTask` takes `Cache`
or `LayeredCache` alike.

```ts
export interface CacheLayer {
  readonly memo: TaskMemo
  readonly local?: Cache | undefined
  readonly hasRemote?: boolean
  remoteHasMany?(hashes: readonly string[]): Promise<Map<string, ArtifactInfo> | null>
  remoteHasEach?(
    hashes: readonly string[],
    concurrency: number,
  ): Promise<Map<string, ArtifactInfo> | null>
  localHasMany?(hashes: readonly string[]): Promise<Set<string>>
  remoteKnown?(hashes: readonly string[]): Map<string, ArtifactInfo>
  markRemoteAbsent?(hashes: Iterable<string>): void
  probeBeforeUpload?(hashes: Promise<readonly string[]>): void
  drainUploads?(): Promise<void>
  stopUploads?(): void
  key(input: CacheKeyInput): Promise<string>
  get(hash: string, ctx?: CacheGetContext): Promise<CacheEntry | null>
  getSaved?(hash: string, ctx?: CacheGetContext): Promise<CacheEntry | null>
  share?(hash: string): Promise<boolean>
  resend?(hash: string): Promise<boolean>
  uploaded?(hash: string): Promise<boolean | undefined>
  getMany?(
    hashes: readonly string[],
    ctx?: (hash: string) => CacheGetContext,
  ): Promise<Map<string, CacheEntry>>
  has(hash: string): Promise<'local' | 'remote' | null>
  prefetch(hash: string, ctx?: CacheGetContext): Promise<boolean>
  restoreOutputs(
    hash: string,
    projectDir: string,
    workspaceRoot?: string,
    outputs?: DeclaredOutputs,
  ): Promise<void>
  save(args: {
    hash: string
    entry: Omit<CacheEntry, 'hash' | 'storedAt' | 'outputFiles' | 'exitCode'>
    projectDir: string
    outputFiles: string[]
    outputDirs?: string[]
    workspaceOutputFiles?: string[]
    workspaceOutputDirs?: string[]
    workspaceRoot?: string
    inputComponents?: readonly TaskInputRow[]
    absent?: boolean
  }): Promise<void>
  ingest(hash: string, body: Blob | Response, meta: IngestMeta): Promise<void>
  stats(opts?: CacheStatsOptions): CacheStats
  outputsPath(hash: string): string
  artifactSize?(hash: string): number | undefined
  outputBytes?(hash: string): number | undefined
  kept?(hash: string): boolean
  prune(options: PruneOptions): Promise<PruneResult>
  close(): void
}
```

## `CachePolicy`

type · `src/cache/policy.ts`

Independent read/write control of the local and remote layers, so `--force`
(re-run, still refresh) differs from `--no-cache`. It gates the artifact
get/save path and the local file-hash writes; bookkeeping (`recordRun`,
stats, prune, key derivation, prefetch-ingest) never.

```ts
export interface CachePolicy {
  localRead: boolean
  localWrite: boolean
  remoteRead: boolean
  remoteWrite: boolean
}
```

## `CacheSettings`

type · `src/config.ts`

`WorkspaceConfig.cache`: where the cache lives and what a run does with it.

```ts
export interface CacheSettings {
  dir?: string
  policy?: string
  download?: 'all' | 'toplevel' | 'none'
  upload?: { failures?: 'ci' | 'local' | 'always' }
  store?: { embeddings?: false | string; decompress?: boolean }
  concurrency?: { download?: number; upload?: number; restore?: number }
}
```

## `CacheSource`

type · `src/graph/task-status.ts`

Where a task's result came from, derived ONCE in core from the status.
`none`: it never engaged the cache, or its hit's restore failed (a
failed task, in no cache column).

```ts
export type CacheSource = 'miss' | 'local' | 'remote' | 'none'
```

## `CapturedChunk`

type · `src/exec/runner.ts`

One piece of a task's output and the stream it came on.

```ts
export interface CapturedChunk {
  text: string
  err: boolean
}
```

## `CiContext`

type · `src/orchestrator/run-context.ts`

```ts
export interface CiContext {
  ci: boolean
  provider: string | null
  runUrl?: string
  change?: string
  pipeline?: string
  job?: string
  attempt?: number
}
```

## `CommandContext`

type · `src/orchestrator/plugin.ts`

```ts
export interface CommandContext extends BaseContext {
  readonly concurrency: number
  readonly vx: readonly string[]
  readonly cache: PluginCache
  readonly artifacts: TaskArtifacts
  artifactsFor(facts: () => CacheFacts | undefined): TaskArtifacts
}
```

## `ConfigContext`

type · `src/orchestrator/plugin.ts`

```ts
export interface ConfigContext extends WorkspaceHookContext {
  setBranch(facts: BranchFacts): void
}
```

## `CorruptArtifactError`

class · `src/cache/layer.ts`

Bytes that are not the artifact their key names: they do not decompress or
parse, or a remote's digest or signature check failed. The hit becomes a
miss, and the re-run's save replaces that remote's copy.

```ts
export class CorruptArtifactError extends Error {
  constructor(
    public readonly hash: string,
    reason: string,
    public override readonly cause?: unknown,
  )
}
```

## `criticalPath`

function · `src/graph/critical-path.ts`

For each node, the expected remaining critical-path duration: its own p50
plus the maximum over its dependents. A node with no history takes its
assumed duration if one was given, else the workspace median; an empty
history takes a flat default.

```ts
export function criticalPath(
  nodes: readonly TaskNode[],
  history: ReadonlyMap<string, { readonly p50DurationMs?: number | undefined }>,
  assume: Readonly<Record<string, number>> = {},
): ReadonlyMap<string, number>
```

## `currentBranch`

function · `src/orchestrator/run-context.ts`

The run's branch: `run.branch` (the flag given, else `VX_RUN_BRANCH`,
else the workspace's), else HEAD's, else the CI provider's for a
detached checkout. What run history records and a forecast reads first.

```ts
export function currentBranch(
  workspaceRoot: string,
  workspace?: unknown,
  flag?: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null
```

## `definePlugin`

function · `src/orchestrator/plugin.ts`

The one way to make a plugin: `definePlugin(import.meta, { ...hooks })`.
The name comes from the nearest named `package.json` above the calling
module and is stamped where the loader checks, so a plugin is named by its
package alone.

```ts
export function definePlugin(origin: PluginOrigin, hooks: PluginHooks): VxPlugin
```

## `defineProject`

function · `src/config.ts`

Identity function, so TypeScript narrows literals and checks `dependsOn`
against this project's own task names: a bare entry naming no task is a
compile error; `^name` and `pkg#name` stay free strings.

```ts
export function defineProject<const T extends ProjectConfig>(
  config: T &
    KnownExecs<T> &
    Known<T, ProjectConfig> & {
      tasks?: {
        [K in keyof NonNullable<T['tasks']>]?: Known<NonNullable<T['tasks']>[K], TaskConfig> & {
          dependsOn?: DependsOn<
            At<NonNullable<T['tasks']>[K], 'dependsOn'>,
            Extract<keyof NonNullable<T['tasks']>, string>
          >
          exec?: Known<At<NonNullable<T['tasks']>[K], 'exec'>, ExecConfig>
          inputs?: Known<At<NonNullable<T['tasks']>[K], 'inputs'>, InputsConfig>
          outputs?: Known<At<NonNullable<T['tasks']>[K], 'outputs'>, TaskOutputs>
        }
      }
    },
): T
```

## `defineWorkspace`

function · `src/config.ts`

```ts
export function defineWorkspace<T extends WorkspaceConfig>(
  config: T &
    Known<T, WorkspaceConfig> & {
      run?: Known<At<T, 'run'>, RunSettings> & {
        rules?: Known<At<At<T, 'run'>, 'rules'>, WorkspaceRules>
      }
      cache?: Known<At<T, 'cache'>, CacheSettings>
      inputs?: Known<At<T, 'inputs'>, WorkspaceInputs> & {
        stability?: Known<At<At<T, 'inputs'>, 'stability'>, InputStability>
      }
      outputs?: Known<At<T, 'outputs'>, WorkspaceOutputs>
      lock?: Known<At<T, 'lock'>, LockSettings>
      watch?: Known<At<T, 'watch'>, WatchSettings>
    },
): T
```

## `DiscoverContext`

type · `src/orchestrator/plugin.ts`

```ts
export interface DiscoverContext extends WorkspaceHookContext {
  readonly cacheDir: string
  readonly projects: readonly ProjectMeta[]
  worktreeChanges(): Promise<readonly string[] | null>
}
```

## `DiscoveredProject`

type · `src/orchestrator/plugin.ts`

What a `discover` hook returns per directory — see `VxPlugin.discover`.

```ts
export interface DiscoveredProject {
  readonly dir: string
  readonly name?: string
  readonly deps?: readonly string[]
  readonly reach?: readonly string[]
}
```

## `Distribution`

type · `src/exec/executor.ts`

The distribution contract: hooks core asks of an executor spreading one run
over machines it starts. Each optional; a throw or bad shape is left out
with one warning.

```ts
export interface Distribution {
  readonly workers?: ReadonlyArray<readonly [name: string, platforms: readonly string[]]>
  demand?(remaining: ReadonlySet<string>, missed: ReadonlySet<string>): void
  running?(taskId: string): string | null | undefined
  unneeded?(taskId: string): void
  footer?(): readonly (readonly [label: string, text: Inline])[]
  machines?(): readonly MachineReport[]
  idealMs?(): number | undefined
  advice?(): readonly WorkerAdvice[]
  profile?(): readonly Record<string, unknown>[]
}
```

## `Duration`

type · `src/config.ts`

A duration with its unit: `'500ms'`, `'30s'`, `'5m'`, `'2h'`, `'1d'`. A
bare number is refused: a unit in the value keeps the name free of one.

```ts
export type Duration = `${number}${'ms' | 's' | 'm' | 'h' | 'd'}`
```

## `ExecConfig`

type · `src/config.ts`

```ts
export interface ExecConfig {
  command: string
  remote?: boolean | 'only'
  platforms?: readonly Platform[]
  worker?: string
  env?: ExecEnv
  timeout?: Duration
  retries?: number
  persistent?: PersistentConfig
  interactive?: boolean
  sandbox?: SandboxConfig
}
```

## `ExecEnv`

type · `src/config.ts`

```ts
export interface ExecEnv {
  passThrough?: readonly string[]
  define?: Record<string, string>
  secret?: readonly string[]
}
```

## `ExecuteRequest`

type · `src/exec/executor.ts`

One task's command as core hands it to an executor. `outputs`, `envDefine`
and `forwardArgs` are frozen copies: core saves the outputs afterwards, and
config and args are shared.

```ts
export interface ExecuteRequest {
  readonly taskId: string
  readonly workspaceRoot: string
  readonly inputs?: TaskInputs
  readonly cacheKey?: string
  readonly unsaved?: boolean
  readonly refresh?: boolean
  readonly remoteOnly?: boolean
  readonly platform?: string
  readonly worker?: string
  readonly attempt?: number
  readonly download?: 'eager' | 'deferred'
  readonly outputs: {
    readonly files: readonly string[]
    readonly workspaceFiles: readonly string[]
  }
  readonly command: string
  readonly forwardArgs: readonly string[]
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
  readonly envDefine: Readonly<Record<string, string>>
  readonly capture: CaptureConfig
  readonly timeoutMs?: number
  readonly onStdout: (chunk: string) => void
  readonly onStderr: (chunk: string) => void
  readonly signal?: AbortSignal
  readonly liveChildren?: Set<ReturnType<typeof Bun.spawn>>
  readonly onSpawn?: (pid: number) => void
  readonly sandbox?: ExecuteSandbox
  readonly terminal?: true
  readonly servers?: readonly ServerSpec[]
}
```

## `ExecuteResult`

type · `src/exec/executor.ts`

```ts
export interface ExecuteResult extends RunResult {
  readonly violations: readonly SandboxViolation[]
  readonly outputs?: { kind: 'disk' } | { kind: 'deferred'; materialize: () => Promise<void> }
  readonly changed?: readonly string[]
  readonly where?: string
  readonly machine?: {
    readonly cores: number
    readonly memoryBytes: number
    readonly cpuShare?: number
  }
}
```

## `ExecuteSandbox`

type · `src/exec/executor.ts`

Sandbox baselines + the user's resolved sandbox block, when the task is sandboxed.

```ts
export interface ExecuteSandbox {
  readonly baseAllowRead: readonly string[]
  readonly baseDenyRead: readonly string[]
  readonly reportWithin: string
  readonly reportLinked: readonly string[]
  readonly config: ResolvedSandboxConfig
  readonly keyed?: readonly string[]
  readonly keyRoot?: string
  readonly keyNested?: readonly string[]
  readonly dependencyReads?: readonly string[]
  readonly dependencyReported?: readonly string[]
  readonly readableDeps?: readonly ReadableOutputs[]
}
```

## `ExecutorCapabilities`

type · `src/exec/executor.ts`

What an executor declares it can do; core offers it tasks by these.

```ts
export interface ExecutorCapabilities {
  readonly remote?: boolean
  readonly sandbox?: boolean
  readonly servers?: boolean
  readonly runtime?: boolean
  readonly dependencyOutputs?: boolean
  readonly exclusive?: boolean
  readonly timeouts?: boolean
  readonly platforms?: readonly string[]
  readonly capacity?: number
}
```

## `ExecutorContext`

type · `src/orchestrator/plugin.ts`

```ts
export interface ExecutorContext extends BaseContext {
  readonly concurrency: number
  readonly artifacts: TaskArtifacts
  cacheFacts(): Promise<CacheFacts>
}
```

## `executorFallback`

function · `src/exec/executor.ts`

What a remote executor rejects with to give a task back: core runs the same
request on the local floor and says `reason` once. A `remote: 'only'` task
fails naming `reason` instead. Matched by name: a plugin's `@vzn/vx` may be
another copy of this class.

```ts
export function executorFallback(reason: string): Error
```

## `exitSignal`

function · `src/exec/runner.ts`

The signal an exit above 128 stands for, by platform numbering; undefined for
a plain exit. The shell's convention, not proof: a command may exit 137
itself.

```ts
export function exitSignal(code: number): string | undefined
```

## `FailedOutcome`

type · `src/graph/outcome.ts`

```ts
export interface FailedOutcome
  extends StartedOutcome, FailureFacts, None<BlockFacts>, None<PlatformFacts> {
  status: 'failed'
  serverExit?: never
}
```

## `findWorkspaceRoot`

function · `src/workspace/workspace.ts`

The workspace root for `start`: the directory holding the first
`.vx/workspace.*` up to the git top-level (or `/` outside git) ({@link
workspaceFile}). Nothing else decides it. Throws `VX_E_NO_WORKSPACE`, naming
`git sparse-checkout add` when a sparse checkout left it out.

Outside git, a file another user owns is refused (unless run as root, as
containers need): one planted in a shared dir above you (`/tmp`) would run as
you. The owner checked is the file's (a link's included) and its `.vx`'s.
Inside git the walk never leaves your checkout. `uid` is for tests.

```ts
export async function findWorkspaceRoot(
  start: string,
  uid: number = process.getuid?.() ?? 0,
): Promise<string>
```

## `FingerprintChange`

type · `src/orchestrator/plugin.ts`

```ts
export interface FingerprintChange {
  readonly file: string
  readonly before: Uint8Array | null
  readonly after: Uint8Array | null
  readonly extras?: ReadonlyMap<
    string,
    { readonly before: Uint8Array | null; readonly after: Uint8Array | null }
  >
}
```

## `FingerprintClaim`

type · `src/orchestrator/plugin.ts`

A plugin's claim on workspace-root files — see `VxPlugin.fingerprint`.

```ts
export interface FingerprintClaim {
  readonly files: readonly string[]
  affected(
    change: FingerprintChange,
    ctx: FingerprintContext,
  ): Iterable<string> | undefined | Promise<Iterable<string> | undefined>
  extraFiles?(
    file: string,
    bytes: Uint8Array,
    ctx: FingerprintContext,
  ): readonly string[] | Promise<readonly string[]>
  digests?(
    file: string,
    ctx: FingerprintContext,
  ): FingerprintDigests | undefined | Promise<FingerprintDigests | undefined>
}
```

## `FingerprintContext`

type · `src/orchestrator/plugin.ts`

```ts
export interface FingerprintContext extends BaseContext {
  readonly projects: ReadonlyArray<{ readonly name: string; readonly dir: string }>
}
```

## `FingerprintDigests`

type · `src/orchestrator/plugin.ts`

`FingerprintClaim.digests`' answer.

```ts
export interface FingerprintDigests {
  readonly hash: string
  readonly projects: Readonly<Record<string, string>>
  readonly extras?: readonly string[]
}
```

## `GeneratedProject`

type · `src/workspace/migration.ts`

```ts
export interface GeneratedProject {
  name: string
  dir: string
  importLines: string[]
  tags?: readonly string[]
  writeName?: boolean
  tasks: GeneratedTask[]
}
```

## `GeneratedTask`

type · `src/workspace/migration.ts`

```ts
export interface GeneratedTask {
  name: string
  todos: string[]
  task: Record<string, unknown> | null
}
```

## `GitContext`

type · `src/orchestrator/run-context.ts`

```ts
export interface GitContext {
  commitSha: string | null
  branch: string | null
  dirty: boolean | null
}
```

## `GraphHookContext`

type · `src/orchestrator/plugin.ts`

```ts
export interface GraphHookContext extends BaseContext {
  readonly requested: readonly string[]
}
```

## `HistoryProvider`

type · `src/history/history.ts`

```ts
export interface HistoryProvider {
  loadFor(taskIds: readonly string[]): Promise<HistoryTable>
  p50sFor?(taskIds: readonly string[]): Promise<ReadonlyMap<string, number>>
}
```

## `HistoryTable`

type · `src/history/history.ts`

Map keyed by `project#task`.

```ts
export type HistoryTable = ReadonlyMap<string, TaskHistory>
```

## `HostContext`

type · `src/orchestrator/run-context.ts`

```ts
export interface HostContext {
  host: string | null
  os: string
  arch: string
}
```

## `hostPlatform`

function · `src/exec/executor.ts`

This machine as `exec.platforms` names it: `os-arch` as Bun reports them, `linux-x64`.

```ts
export function hostPlatform(): string
```

## `InputChanges`

type · `src/graph/outcome.ts`

What moved in a missed task's key since the last entry saved for it.

```ts
export interface InputChanges {
  count: number
  first: readonly { kind: string; name: string; change: 'changed' | 'added' | 'removed' }[]
}
```

## `InputsConfig`

type · `src/config.ts`

```ts
export interface InputsConfig {
  files: readonly string[]
  workspaceFiles?: readonly string[]
  env?: readonly string[]
  tasks?: readonly string[]
  runtime?: readonly string[]
  workspaceRuntime?: readonly string[]
  stability?: InputStability
}
```

## `InputStability`

type · `src/config.ts`

```ts
export interface InputStability {
  strategy?: 'immutable' | 'mutable' | 'unchecked'
  severity?: 'warn' | 'error'
}
```

## `InvocationRecord`

type · `src/history/run-history.ts`

One header row per `vx run` invocation (the `invocations` table). All
fields mirror the columns; nullable VCS/host columns are `null` when
the probe failed (not a git repo, hostname unavailable). Recorded
once per run inside the same transaction as the per-task `runs` rows.

```ts
export interface InvocationRecord {
  runId: string
  command: string
  requestedTasks: string
  cachePolicy: string
  concurrency: number
  flow: 'focused' | 'broad' | null
  startedAt: number
  endedAt: number
  totalDurationMs: number
  taskCount: number
  failedCount: number
  hitCount: number
  hitLocalCount: number
  hitRemoteCount: number
  upToDateCount: number
  restoredLocalCount: number
  restoredRemoteCount: number
  exitOk: boolean
  commitSha: string | null
  branch: string | null
  dirty: boolean | null
  ci: boolean
  ciProvider: string | null
  host: string | null
  os: string | null
  arch: string | null
  vxVersion: string
}
```

## `isCacheHit`

function · `src/graph/task-status.ts`

Did the result come from the cache (either layer)? Derived from
`deriveCacheSource`. Unknown strings are not hits.

```ts
export function isCacheHit(status: string): boolean
```

## `isLiteralPattern`

function · `src/util/paths.ts`

True when a pattern has no wildcard and names one path. One copy for every
caller: graph/task-graph.ts once omitted `{}`, so `dist/{a,b}.txt` compared
unequal to `dist/a.txt` and two tasks deleted each other's outputs, green.

```ts
export function isLiteralPattern(glob: string): boolean
```

## `isPassStatus`

function · `src/graph/task-status.ts`

Did the task pass? A hit counts; `skipped` and `aborted` do not, as neither
finished on its own terms.

Takes `string`: most statuses arrive over a wire or from a database. An
unknown string does not pass, the safe direction.

```ts
export function isPassStatus(status: string): boolean
```

## `isSecretUnavailable`

function · `src/util/secrets.ts`

A `secret` rejection that is a missing secret, not a fault. By name: a plugin may load its own copy of core.

```ts
export function isSecretUnavailable(err: unknown): err is SecretUnavailable
```

## `isStarterConfig`

function · `src/workspace/migration.ts`

Whether `file` is `vx init`'s starter, untouched: a migration maps over it
as over no config, so the scripts `vx init` pointed at become tasks.

```ts
export function isStarterConfig(file: string): boolean
```

## `isUserError`

function · `src/util/errors.ts`

`instanceof UserError`, plus the same class arriving from ANOTHER COPY of
core. A compiled `vx` binary carries core inside it while a plugin in the
workspace imports `@vzn/vx` from node_modules, so a plugin's `UserError` is a
different class object and `instanceof` is false — a plugin verb's "bad flag
--x" printed as `UserError: bad flag --x` with a stack, and a REAPI refusal
would have read as an "internal error" (reproduced through the real binary).
The name is the contract that survives the copy boundary.

```ts
export function isUserError(err: unknown): err is UserError
```

## `KeyHookContext`

type · `src/orchestrator/plugin.ts`

```ts
export interface KeyHookContext extends BaseContext {
  locked(file: string): Promise<LockedFile | undefined>
}
```

## `LentAccess`

type · `src/cache/layered-cache.ts`

A run's access to a remote, lent to a machine that runs its tasks (`RemoteCacheLayer.lend`).

```ts
export interface LentAccess {
  readonly token: string
  readonly expiresAt?: number
}
```

## `loadProjectConfig`

function · `src/workspace/project-loader.ts`

```ts
export async function loadProjectConfig(configPath: string): Promise<ProjectConfig>
```

## `loadResolvedProjects`

function · `src/orchestrator/projects.ts`

The run path's view of a workspace's projects for a reader — a plugin's
verb, an embedder: the lock, the plugin `config`, `discover` and
`project` stages. `scope` is every project or a list of names; no
closure. No lock is `NO_LOCK`. Plugin warnings go to `warn`.

```ts
export async function loadResolvedProjects(
  workspaceRoot: string,
  opts: { scope?: 'all' | readonly string[]; warn?: (message: string) => void } = {},
): Promise<Map<string, ProjectEntry>>
```

## `localHistory`

function · `src/history/history.ts`

The run history in `cache`'s index. A plugin reads history only through this:
core owns every read and write of cache.db.

```ts
export function localHistory(cache: Cache, options: LocalHistoryOptions = {}): LocalHistory
```

## `LocalHistory`

type · `src/history/history.ts`

One local cache's run history, read and written by core (`localHistory`): plain rows out, no handle.

```ts
export interface LocalHistory extends HistoryProvider {
  resourcesFor(taskIds: readonly string[]): Promise<ReadonlyMap<string, TaskResources>>
  durationsFor(taskIds: readonly string[]): Promise<ReadonlyMap<string, number>>
  measuresFor(ids: readonly string[]): ReadonlyMap<string, MeasureForecast>
  hasImported(sha: string): boolean
  importTimings(
    sha: string,
    timings: ReadonlyMap<string, number>,
    needs?: ReadonlyMap<string, TaskResources>,
    defs?: ReadonlyMap<string, string>,
  ): void
}
```

## `LocalHistoryOptions`

type · `src/history/history.ts`

```ts
export interface LocalHistoryOptions {
  readonly recent?: number | undefined
  readonly branch?: string | null | undefined
  readonly defs?: ReadonlyMap<string, string> | undefined
}
```

## `LockedFile`

type · `src/orchestrator/plugin.ts`

`KeyHookContext.locked`'s answer.

```ts
export interface LockedFile {
  readonly extras: Readonly<Record<string, string>>
  digest(projectDir: string): string | undefined
}
```

## `lockfileClaim`

function · `src/orchestrator/lockfile-claim.ts`

```ts
export function lockfileClaim<L = unknown>(
  options: LockfileClaimOptions<L>,
): LockfileClaimHooks<L>
```

## `LockfileClaimHooks`

type · `src/orchestrator/lockfile-claim.ts`

What a lockfile plugin spreads into `definePlugin` (`fingerprint`, `key`), and `links` for its own stages.

```ts
export interface LockfileClaimHooks<L = unknown> {
  readonly fingerprint: FingerprintClaim
  key(task: TaskNode, ctx: KeyHookContext): Promise<Readonly<Record<string, string>> | undefined>
  links(ctx: {
    readonly workspaceRoot: string
    readonly cacheDir: string
  }): Promise<ReadonlyMap<string, L> | undefined>
  recorded(ctx: {
    readonly workspaceRoot: string
    readonly cacheDir: string
  }): Promise<ReadonlyMap<string, ReadonlySet<string>> | undefined>
}
```

## `LockfileClaimOptions`

type · `src/orchestrator/lockfile-claim.ts`

```ts
export interface LockfileClaimOptions<L = unknown> {
  readonly file: string
  readonly digest: (text: string, files: ReadonlyMap<string, string>) => ReadonlyMap<string, string>
  readonly extraFiles?: (text: string) => readonly string[]
  readonly version: number
  readonly identity?: string
  readonly scope?: 'project' | 'workspace'
  readonly part?: string
  readonly links?: (text: string) => ReadonlyMap<string, L>
  readonly recorded?: (text: string) => ReadonlyMap<string, readonly string[]>
}
```

## `LockSettings`

type · `src/config.ts`

`WorkspaceConfig.lock`.

```ts
export interface LockSettings {
  reviewFiles?: boolean
}
```

## `LOG_WIRE_VERSION`

const · `src/orchestrator/task-log-buffer.ts`

Version of the drained-bundle shape below. It is the canonical drained
 logs format, not one transport's: every sink ships the same object.

```ts
export const LOG_WIRE_VERSION = 1
```

## `Logger`

type · `src/report/logger.ts`

```ts
export interface Logger {
  status(line: string): void
  warn?(line: string): void
  taskStdout(node: TaskNode, chunk: string): void
  taskStderr(node: TaskNode, chunk: string): void
  taskComplete(node: TaskNode, outcome: TaskOutcome): void
  runStart?(info: {
    total: number
    concurrency?: number
    requestedCount?: number
    context?: RunContext
    startedAtMs?: number
  }): void
  taskStart?(node: TaskNode): void
  runEnd?(): void
  stepStart?(id: string): void
  stepEnd?(id: string, info: { durationMs: number; ok: boolean }): void
  runStop?(): void
  runDone?(): void
}
```

## `machineMemoryBytes`

function · `src/util/cgroup.ts`

The machine's total memory, capped by its cgroup limit.

```ts
export function machineMemoryBytes(probe: CgroupProbe = {}): number
```

## `machineParallelism`

function · `src/util/cgroup.ts`

The cores this process may run on, capped by its cgroup CPU quota,
rounded up (a 1.5-core quota is two workers, not one) and never below
one. The default worker count.

```ts
export function machineParallelism(probe: CgroupProbe = {}): number
```

## `MachineReport`

type · `src/exec/executor.ts`

One machine an executor ran tasks on, as the run summary reports it.

```ts
export interface MachineReport {
  name: string
  status: string
  cores: number
  memoryBytes: number
  done: number
  failed: number
  onlineMs: number
  busyMs: number
  cpuPeak: number
  cpuAvg: number
  memoryPeakBytes: number
  memoryAvgBytes: number
  utilization: number
  bookedAvg?: number
  warmUpMs?: number
  startMs?: number
}
```

## `Measure`

type · `src/report/events.ts`

What a plugin measured that is no task of the graph (a worker's
warm-up), timed as a task is: an id under the plugin's name
(`<plugin>#<name>`), a definition hash that starts its history over
when what it measures changes, its milliseconds and, if any, the cores
it kept busy.

```ts
export interface Measure {
  readonly id: string
  readonly def: string
  readonly durationMs: number
  readonly cores?: number
}
```

## `MeasureForecast`

type · `src/history/history.ts`

A plugin measure as history forecasts it: the median of its newest timings and of their cores.

```ts
export interface MeasureForecast {
  readonly durationMs: number
  readonly cores?: number
}
```

## `mergeBaseWith`

function · `src/workspace/affected.ts`

The merge base of `ref` and HEAD, or undefined. A shallow clone fetches what
it needs (`reachMergeBase`), so plugins reading base history ask this, not
`git merge-base`.

```ts
export async function mergeBaseWith(
  workspaceRoot: string,
  ref: string,
): Promise<string | undefined>
```

## `MigrationFormat`

type · `src/workspace/migration.ts`

```ts
export type MigrationFormat = 'ts' | 'mjs'
```

## `MigrationMember`

type · `src/workspace/migration.ts`

A project the adoption tool found: its name, directory and the vx config it already has.

```ts
export interface MigrationMember {
  readonly name: string
  readonly dir: string
  readonly configPath: string | null
  readonly esModule?: boolean
}
```

## `MigrationPlan`

type · `src/workspace/migration.ts`

```ts
export interface MigrationPlan {
  headerNotes: string[]
  projects: GeneratedProject[]
  extraFiles: { relPath: string; contents: string }[]
  notes: string[]
}
```

## `normalizeGlob`

function · `src/util/paths.ts`

Spellings readers, Turbo and `.gitignore` accept but a raw matcher turns into
nothing (a task keyed on nothing replays old outputs green): leading `./`,
inner `/./`, doubled `//`, a trailing `/` on a pattern (`src/*\/` becomes
`src/*\/**`; a literal's is `asTrees`'), and trailing `/.`. After an optional
`!`; a bare `.` is refused by the schema.

```ts
export function normalizeGlob(glob: string): string
```

## `OutcomeAttempts`

type · `src/graph/outcome.ts`

Its retries (`exec.retries`, `--retries`, a known flake's one more).

```ts
export interface OutcomeAttempts {
  count?: number
  failed?: readonly { endedAt: number; exitCode: number; timedOut?: true }[]
  outputs?: readonly string[]
  flaky?: { passes: number; failures: number }
}
```

## `OutcomeCache`

type · `src/graph/outcome.ts`

What the cache and the key said of the task.

```ts
export interface OutcomeCache {
  stored?: { durationMs: number; cpuMs?: number; peakRssBytes?: number }
  restored?: boolean
  saved?: true
  inputFiles?: number
  artifactBytes?: number
  outputBytes?: number
  inputChanges?: InputChanges
  deferred?: true
  off?: true
  unkeyed?: true
  driftedInput?: string | null
  keylessBy?: string
}
```

## `OutcomePlacement`

type · `src/graph/outcome.ts`

Where an executor ran it, when that is not this host (`ExecuteResult.where`, `.machine`).

```ts
export interface OutcomePlacement {
  where?: string
  carried?: true
  cores?: number
  memoryBytes?: number
  cpuShare?: number
}
```

## `OutcomeSandbox`

type · `src/graph/outcome.ts`

A sandboxed task's denials (`exec.sandbox`): any one fails the task.

```ts
export interface OutcomeSandbox {
  violations: number
  lines?: string[]
  fix?: SandboxFix
}
```

## `OutcomeTiming`

type · `src/graph/outcome.ts`

When the task waited, ran and moved bytes, on the run's clock.

```ts
export interface OutcomeTiming {
  queuedMs?: number
  admissionHeldMs?: number
  startNs?: bigint
  endNs?: bigint
  fetchMs?: number
  saveMs?: number
}
```

## `OutcomeUsage`

type · `src/graph/outcome.ts`

What this run's execution of the task used; absent on a hit.

```ts
export interface OutcomeUsage {
  cpuMs?: number
  peakRssBytes?: number
  peakCores?: number
  avgRssBytes?: number
}
```

## `OutcomeView`

type · `src/report/events.ts`

Serializable projection of a TaskOutcome (no node ref, ns as strings).

```ts
export interface OutcomeView {
  taskId: string
  status: TaskOutcome['status']
  exitCode: number
  durationMs: number
  isGroup?: boolean
  noCache?: boolean
  restoreFailed?: true
  storedDurationMs?: number
  storedCpuMs?: number
  storedPeakRssBytes?: number
  hash?: string
  cpuMs?: number
  peakRssBytes?: number
  timedOut?: true
  notReady?: 'timeout' | 'exited' | 'spawn'
  inputMoved?: string
  blockedBy?: string
  otherPlatform?: { readonly needs: readonly string[]; readonly host: string }
  admissionHeldMs?: number
  queuedMs?: number
  inputFiles?: number
  inputChanges?: InputChanges
  artifactBytes?: number
  fetchMs?: number
  saveMs?: number
  restored?: boolean
  sandboxViolations?: number
  sandboxViolationLines?: string[]
  wallclockStartNs?: string
  wallclockEndNs?: string
}
```

## `OutputContext`

type · `src/orchestrator/plugin.ts`

```ts
export interface OutputContext extends BaseContext {
  readonly isTTY: boolean
  readonly ci: boolean
}
```

## `outputDirPrefixes`

function · `src/util/paths.ts`

The directories whose snapshot covers every path the positive `globs` can
match, or null when one leaves the project: a whole subtree or literal is its
own tree, other globs the tree under their static prefix, a root-anchored one
the whole project (`''`). The snapshot's file list is held to the entry's
rows through the globs, so a source file beside outputs is no stray.

```ts
export function outputDirPrefixes(globs: readonly string[]): string[] | null
```

## `outputsOverlap`

function · `src/graph/task-graph.ts`

True only when two output globs PROVABLY overlap. Conservative, because the
caller REFUSES the run and a false positive breaks a working build:

- both literal: equal paths;
- literal vs glob: does the glob match the literal;
- both globs: identical, or one is `P/**` and the other's literal prefix is P
  or under it. Anything else passes.

A static-prefix comparison is unsound for a refusal: `dist/vx-*` and
`dist/other.txt` share `dist` and match disjoint sets.

Each side goes through `asTrees` first, the rule `cleanOutputs` deletes by:
`./dist/**` is `dist/**`, and `outputs: ['dist']` is everything under `dist`.

On the façade so `@vzn/vx-migrate` asks the same question at migration time.

```ts
export function outputsOverlap(rawA: string, rawB: string): boolean
```

## `OutputView`

type · `src/report/logger.ts`

The default logger's per-task output policy, from `--output-logs`, else a
truthy `CI`, else the CLI's flow: full: frames for executed work, one-liners
for quiet hits; CI's and the programmatic default. errors-only: only failed
tasks print. none: no per-task output. hash-only: one line per task (outcome,
id, key), Turbo's parity; the summary still renders. focused: requested nodes
stream raw, live; dependencies are silent unless they fail. broad: a
`success` line per executed task, frames for failures, silent hits.

`gha` (GitHub Actions): task output is fenced from workflow commands; in full
mode each block is a collapsible group, except failures, which stay open with
an `::error` annotation.

`ci`: suppresses the status line even on a TTY.

```ts
export interface OutputView {
  mode: 'full' | 'errors-only' | 'none' | 'focused' | 'broad' | 'hash-only'
  gha?: boolean
  ci?: boolean
}
```

## `PERSISTENT_TODO`

const · `src/workspace/migration.ts`

The one wording every mapper emits for a task it made persistent.

```ts
export const PERSISTENT_TODO =
  'persistent task — set persistent.readyWhen (regex matched against output) so ' +
  'dependents unblock on readiness, and consider exec.timeout to bound the wait'
```

## `PlannedTask`

type · `src/orchestrator/plan.ts`

```ts
export interface PlannedTask {
  node: TaskNode
  hash: string
  cacheStatus: CacheStatus
  deps: readonly string[]
  p50Ms?: number
  executor?: string
  download?: 'deferred'
  remoteBytes?: number
  affected?: AffectedReason
  otherPlatform?: { readonly needs: readonly string[]; readonly host: string }
  blockedBy?: string
}
```

## `planRun`

function · `src/orchestrator/run.ts`

Planning mode (`--dry`): the same setup as `run()`, stopping short of
execution, returning a `RunPlan` predicting each task's hit or miss.

Side effects: only `inputs.runtime` probes, which keys need. With no remote
the cache opens read-only; with one, remote hits found are kept for the next
run. Probing is the byte-free `cache.has()`: no download, ingest or
`accessed_at` bump.

```ts
export async function planRun(options: RunOptions): Promise<RunPlan>
```

## `Platform`

type · `src/config.ts`

```ts
export type Platform = (typeof PLATFORMS)[number]
```

## `PLATFORMS`

const · `src/config.ts`

The machines a task can name in `exec.platforms`: `os-arch`, as Bun's compile targets name them.

```ts
export const PLATFORMS = ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64'] as const
```

## `PLUGIN_HOOKS`

const · `src/config.ts`

Every hook a plugin may fill, in pipeline order: the one list the
loader's checks, the host's stage gate and `vx info` read, so a stage
added here is added everywhere. The type pin below refuses a list that
drifts from `Plugin`'s keys.

```ts
export const PLUGIN_HOOKS = [
  'config',
  'discover',
  'project',
  'graph',
  'key',
  'fingerprint',
  'measures',
  'schedule',
  'admit',
  'executor',
  'cache',
  'telemetry',
  'output',
  'setup',
  'commands',
  'teardown',
] as const
```

## `PluginCache`

type · `src/cache/plugin-cache.ts`

What a plugin's `ctx.cache` offers. Keys are the plugin's own names.

```ts
export interface PluginCache {
  get(key: string, scoped?: boolean): Promise<Uint8Array | null>
  put(key: string, bytes: Uint8Array): Promise<void>
  has(key: string, scoped?: boolean): Promise<boolean | null>
  hasMany(keys: readonly string[], scoped?: boolean): Promise<Set<string> | null>
  getRun(name: string): Promise<Uint8Array | null>
}
```

## `PluginCommand`

type · `src/orchestrator/plugin.ts`

One CLI verb contributed by a plugin.

```ts
export interface PluginCommand {
  readonly description: string
  run(argv: readonly string[], ctx: CommandContext): number | Promise<number>
}
```

## `PluginHook`

type · `src/config.ts`

```ts
export type PluginHook = (typeof PLUGIN_HOOKS)[number]
```

## `PluginHookHandlers`

type · `src/orchestrator/plugin.ts`

```ts
export interface PluginHookHandlers {
  onRunStart: (info: RunStartInfo) => void | Promise<void>
  onTaskStart: (node: TaskNode) => void | Promise<void>
  onTaskStdout: (node: TaskNode, chunk: string) => void | Promise<void>
  onTaskStderr: (node: TaskNode, chunk: string) => void | Promise<void>
  onTaskComplete: (node: TaskNode, outcome: TaskOutcome) => void | Promise<void>
  onMeasure: (measure: Measure) => void | Promise<void>
  onRunStatus: (line: string) => void | Promise<void>
  onRunEnd: () => void | Promise<void>
}
```

## `PluginHookName`

type · `src/orchestrator/plugin.ts`

```ts
export type PluginHookName =
  | 'onRunStart'
  | 'onTaskStart'
  | 'onTaskStdout'
  | 'onTaskStderr'
  | 'onTaskComplete'
  | 'onMeasure'
  | 'onRunStatus'
  | 'onRunEnd'
```

## `PluginHooks`

type · `src/orchestrator/plugin.ts`

What a plugin author writes: every hook, and no name.

```ts
export type PluginHooks = Omit<VxPlugin, 'name'>
```

## `PluginOptionKinds`

type · `src/orchestrator/plugin.ts`

Every option a factory takes with its kind (`'any'` for a union). Derived
from the options interface, so the checker refuses a missing, extra or
mistyped option.

```ts
export type PluginOptionKinds<T> = {
  readonly [K in keyof Required<T>]-?: OptionKind<Required<T>[K]>
}
```

## `PluginOrigin`

type · `src/orchestrator/plugin.ts`

Where a plugin is defined — `import.meta` of its module. `dir` is Bun's
field; `url` is the standard one, for a module evaluated elsewhere.

```ts
export interface PluginOrigin {
  readonly dir?: string
  readonly url?: string
}
```

## `PluginSecrets`

type · `src/util/secrets.ts`

A plugin's keychain, on the contexts of the hooks that run before the first task.

```ts
export interface PluginSecrets {
  secret(req: SecretRequest): Promise<string>
  forgetSecret(req: { readonly key: string }): Promise<void>
}
```

## `PluginSetupContext`

type · `src/orchestrator/plugin.ts`

What `setup` receives: the run's lifecycle, observe-only, and the
plugin's keychain (`secret`, `forgetSecret`): setup runs before the
status line, so a prompt there is seen.

```ts
export interface PluginSetupContext extends BaseContext, PluginSecrets {
  readonly cache: PluginCache
  readonly ci: boolean
  readonly branch: string | null
  on<K extends PluginHookName>(hook: K, handler: PluginHookHandlers[K]): void
  measure(measure: Measure): void
}
```

## `PreparedRun`

type · `src/orchestrator/prepare.ts`

```ts
export interface PreparedRun {
  workspaceRoot: string
  workspaceConfig: WorkspaceConfig | null
  plugins: readonly VxPlugin[]
  cacheDir: string
  cache: CacheLayer
  localCache: Cache
  hasRemoteLayer: boolean
  cachePolicy: CachePolicy
  cacheScope: string | undefined
  remotes: ResolvedRemote[]
  cacheRefs: readonly string[]
  priorities: (run?: ScheduleRun) => Promise<ReadonlyMap<string, number>>
  branch: () => string | null
  cacheFor: (plugin: string) => PluginCache
  keepRunEntry: ((name: string, bytes: Uint8Array) => Promise<boolean>) | undefined
  nodes: Map<string, TaskNode>
  keyOnly: ReadonlyMap<string, TaskNode>
  unresolvedTasks: readonly string[]
  declaredElsewhere: readonly string[]
  projects: ReadonlyMap<string, ProjectEntry>
  hintProjects: ReadonlyMap<string, ProjectEntry>
  anyProjectConfig: boolean
  taskless: (name: string) => boolean
  unlockedConfig: () => string | undefined
  fingerprintWatch: FingerprintWatch
  nestedDirsByProject: Map<string, string[]>
  gitFilesCache: GitFilesCache
  workspaceProjectCount: number
  hashCache: HashCache
  dependents?: ReadonlyMap<string, number>
  empty: null | 'no-tasks-declared' | 'none-affected' | 'empty-graph'
}
```

## `PreparedTask`

type · `src/orchestrator/worker-runtime.ts`

A task whose sandbox is built: its placeholders exist until `sweep`.

```ts
export interface PreparedTask {
  run(): Promise<ExecuteResult & { readonly output: CapturedChunk[] }>
  sweep(): Promise<void>
}
```

## `prepareRun`

function · `src/orchestrator/prepare.ts`

Build the prepared run: discovery, config load, package and task graph, and
the cache handle (local, maybe layered). Caller owns `cache.close()`.

Never throws on "no tasks": `empty` says why, and each caller decides.

```ts
export async function prepareRun(options: RunOptions, log: Logger): Promise<PreparedRun>
```

## `PROJECT_CONFIG_FILENAMES`

const · `src/workspace/workspace.ts`

```ts
export const PROJECT_CONFIG_FILENAMES = [
  'vx.config.ts',
  'vx.config.mts',
  'vx.config.js',
  'vx.config.mjs',
  'vx.config.cts',
  'vx.config.cjs',
]
```

## `ProjectConfig`

type · `src/config.ts`

```ts
export interface ProjectConfig {
  name?: string
  tags?: readonly string[]
  tasks?: Record<string, TaskConfig>
}
```

## `ProjectEntry`

type · `src/workspace/workspace.ts`

A discovered project joined with its loaded vx config.

```ts
export interface ProjectEntry {
  name: string
  dir: string
  config: ProjectConfig
}
```

## `ProjectHookContext`

type · `src/orchestrator/plugin.ts`

```ts
export interface ProjectHookContext extends BaseContext {
  readonly name: string
  readonly dir: string
  readonly projects: readonly ProjectMeta[]
  readonly lock: boolean
}
```

## `ProjectMeta`

type · `src/workspace/workspace.ts`

```ts
export interface ProjectMeta {
  name: string
  dir: string
  configPath: string | null
  deps?: readonly string[]
  reach?: readonly string[]
}
```

## `pruneOrphanPersistentNotes`

function · `src/workspace/migration.ts`

Strips the note from every persistent task no `dependsOn` in the mapping names.

```ts
export function pruneOrphanPersistentNotes(
  projects: readonly {
    readonly tasks: readonly {
      readonly name: string
      readonly todos: string[]
      readonly task: Record<string, unknown> | null
    }[]
  }[],
  note: string,
): void
```

## `quoteTsLiteral`

function · `src/workspace/migration.ts`

A string as a single-quoted TS literal, escaping backslash, quote and raw
newlines/CR, so values with newlines or quotes round-trip through the loader.

```ts
export function quoteTsLiteral(s: string): string
```

## `RawExpr`

type · `src/workspace/migration.ts`

Verbatim TS expression spliced into a generated array (preset spreads).

```ts
export interface RawExpr {
  readonly raw: string
}
```

## `reachDigests`

function · `src/orchestrator/lockfile-claim.ts`

One digest per node over everything the node reaches, Merkle-style: a
change anywhere in a node's reach moves its digest, a change elsewhere
does not. Lockfiles carry dependency cycles, so the unit is the
strongly connected component: Tarjan's walk (iterative — a dependency
chain can be thousands deep) emits components children-first, and each
folds its members (sorted), each as its material and the materials its
edges land on, and its child components' digests (sorted).
O(nodes + edges), where one traversal per member is O(members × nodes).

```ts
export function reachDigests(g: ReachGraph): string[]
```

## `ReachGraph`

type · `src/orchestrator/lockfile-claim.ts`

A dependency graph: one material string per node and its out-edges by index.

```ts
export interface ReachGraph {
  readonly material: readonly string[]
  readonly edges: ReadonlyArray<readonly number[]>
}
```

## `ReadableOutputs`

type · `src/exec/executor.ts`

A dependency whose declared outputs a sandboxed task may read (`ExecuteSandbox.readableDeps`).

```ts
export interface ReadableOutputs {
  readonly taskId: string
  readonly projectDir: string
  readonly outputs: {
    readonly files: readonly string[]
    readonly workspaceFiles: readonly string[]
  }
}
```

## `refuseUnknownOptions`

function · `src/orchestrator/plugin.ts`

Refuse an option a factory does not take, or a wrong kind, as core refuses
an unknown config field: Bun strips types, so a misspelt option (`reapi({
endpont })`) quietly declined, and an env string where a number belongs was
misread. `factory` names the call (`reapi()`).

```ts
export function refuseUnknownOptions<T>(
  factory: string,
  options: unknown,
  kinds: PluginOptionKinds<T>,
): void
```

## `RemoteCacheLayer`

type · `src/cache/layered-cache.ts`

What a remote cache layer provides: the plugin seam for remote caching. Core
ships no wire; a plugin's `cache` hook returns one (or
`RunOptions.remoteCache`), and `LayeredCache` owns policy, in-flight dedup,
provenance and the never-fail contract: a layer THROWS on failure, and every
throw is a miss reported to `onError`. The bytes are the local
`<hash>.tar.zst` verbatim. See docs/modules/cache.md.

Core bounds no call, so each request carries the layer's own deadline.

```ts
export interface RemoteCacheLayer {
  readonly endpoint?: string
  readonly off?: boolean
  open?(ctx: RemoteOpenContext): Promise<void>
  lend?(): Promise<LentAccess | undefined>
  has(hash: string): Promise<ArtifactInfo | null>
  hasMany?(hashes: readonly string[]): Promise<Map<string, ArtifactInfo> | null>
  get(
    hash: string,
  ): Promise<{ body: Blob | Response; durationMs: number | undefined } | null | undefined>
  put(hash: string, body: Blob, meta: { durationMs: number; replace?: true }): Promise<void | false>
  missing?(hash: string): void
}
```

## `RemoteOpenContext`

type · `src/cache/layered-cache.ts`

What a remote's `open` is handed: the run's CI verdict and its plugin's keychain.

```ts
export interface RemoteOpenContext extends PluginSecrets {
  readonly ci: boolean
  warn(message: string): void
}
```

## `ResolvedSandboxConfig`

type · `src/exec/executor.ts`

Sandbox config with every path absolute (`resolveSandboxConfig`).

```ts
export interface ResolvedSandboxConfig {
  allowRead: readonly string[]
  allowWrite: readonly string[]
  pendingWrites?: readonly string[]
  linkedWrites?: readonly { readonly link: string; readonly target: string }[]
  network?: true | readonly string[]
  denyNetwork?: readonly string[]
  systemInfo?: readonly string[]
  unixSockets?: true | readonly string[]
  localBinding?: boolean | readonly number[]
  machLookup?: readonly string[]
  pty?: boolean
  gitConfig?: boolean
  weakerWhenNested?: boolean
  weakerNetworkIsolation?: boolean
  hermetic?: boolean
  walled?: { reads: readonly string[]; walls: readonly string[] }
  wallsReached?: { read: readonly string[]; write: readonly string[] }
  ignore?: {
    read?: readonly string[]
    write?: readonly string[]
    systemInfo?: readonly string[]
    network?: readonly string[]
  }
}
```

## `restorableOutput`

function · `src/util/paths.ts`

Whether a restore may write `rel`: a declared output not `outputExcluded`,
what the save could have packed. Anything else in an artifact is not
restored.

```ts
export function restorableOutput(
  globs: readonly string[],
  scope: 'project' | 'workspace' = 'project',
): (rel: string) => boolean
```

## `run`

function · `src/orchestrator/run.ts`

```ts
export async function run(options: RunOptions): Promise<RunSummary>
```

## `RunContextRecord`

type · `src/orchestrator/telemetry.ts`

Identifies which run a record belongs to + its captured context. Maps
 cleanly onto OTel CI/CD + VCS resource attributes.

```ts
export interface RunContextRecord {
  runId: string
  vxVersion: string
  command: string
  requestedTasks: readonly string[]
  cachePolicy: string
  concurrency: number
  flow: 'focused' | 'broad' | null
  workspaceId: string
  workspaceName: string
  repository?: string
  workspacePath?: string
  commitSha: string | null
  branch: string | null
  defaultBranch: string | null
  dirty: boolean | null
  ci: boolean
  ciProvider: string | null
  ciRunUrl?: string
  ciChange?: string
  ciPipeline?: string
  ciJob?: string
  ciAttempt?: number
  host: string | null
  os: string
  arch: string
}
```

## `RunOptions`

type · `src/orchestrator/options.ts`

```ts
export interface RunOptions {
  cwd: string
  tasks: readonly string[]
  projects?: string[]
  affected?: AffectedChanges
  concurrency?: number
  cacheDir?: string
  cache?: CachePolicy
  cacheFlags?: CacheFlags
  cacheScope?: string
  outputLogs?: 'full' | 'errors-only' | 'none' | 'hash-only'
  download?: 'all' | 'toplevel' | 'none'
  downloadConcurrency?: number
  uploadConcurrency?: number
  restoreConcurrency?: number
  flow?: 'focused' | 'broad'
  retries?: number
  timeout?: number
  continueMode?: ContinueMode
  branch?: string
  schedule?: NonNullable<RunSettings['schedule']>
  excludeDependencies?: 'all' | readonly string[]
  forwardArgs?: readonly string[]
  footer?: boolean
  profile?: string
  handleSignals?: boolean
  signal?: AbortSignal
  tty?: boolean
  log?: Logger
  bus?: EventBus
  inflight?: Map<string, Promise<void>>
  telemetrySinks?: readonly TelemetrySink[]
  command?: string
  remoteCache?: RemoteCacheLayer
  artifactCeiling?: number
}
```

## `RunPlan`

type · `src/orchestrator/plan.ts`

```ts
export interface RunPlan {
  tasks: PlannedTask[]
  predicted?: PlanPrediction
  unresolvedTasks?: readonly string[]
  unresolvedHint?: string
  noneAffected?: string
  downloadDowngrades?: ReadonlyArray<{ taskId: string; reason: string }>
}
```

## `RunRecord`

type · `src/history/run-history.ts`

```ts
export interface RunRecord {
  hash?: string
  project: string
  task: string
  status: 'success' | 'failed' | 'cache-hit' | 'cache-hit-remote' | 'skipped'
  exitCode: number
  durationMs: number
  forwardArgs?: readonly string[]
  startedAt: number
  endedAt: number
  runId?: string
  cpuMs?: number
  peakRssBytes?: number
  wallclockStartNs?: bigint
  wallclockEndNs?: bigint
  cacheHit?: boolean
  restored?: boolean
  attempts?: number
  cached?: boolean
  blockedBy?: string
  timedOut?: true
  sandboxViolations?: number
  notReady?: 'timeout' | 'exited' | 'spawn'
  remoteError?: string
  peakCores?: number
  avgRssBytes?: number
  placement?: string
  keylessBy?: string
  def?: string
  placementCores?: number
  placementMemoryBytes?: number
  cpuShare?: number
  queuedMs?: number
  outputBytes?: number
  blocks?: number
  flakyPasses?: number
  flakyFailures?: number
}
```

## `RunReport`

type · `src/orchestrator/plugin.ts`

What a finished run hands each `teardown`: its facts and tasks, with the
names core kept their bytes under. Kept only when a remote takes the run's
writes (CI by default): the log of a task that saved no entry, and a failed
task's log and leftover outputs when `cache.upload.failures` covers the
run. Read with `ctx.cache.getRun(name)`; a plugin wanting a manifest writes
one (`ctx.cache.put`). Frozen.

```ts
export interface RunReport {
  readonly runId: string
  readonly commit: string | null
  readonly ciRun: CiContext
  readonly ok: boolean
  readonly tasks: readonly RunReportTask[]
}
```

## `RunReportTask`

type · `src/orchestrator/plugin.ts`

```ts
export interface RunReportTask {
  readonly id: string
  readonly status: TaskStatus
  readonly durationMs: number
  readonly key?: string
  readonly log?: string
  readonly outputs?: string
}
```

## `RunSettings`

type · `src/config.ts`

`WorkspaceConfig.run`: how a run runs.

```ts
export interface RunSettings {
  concurrency?: number | `${number}%`
  schedule?: 'most-work' | 'critical-path' | 'direct-dependents' | 'ready-order'
  timeout?: Duration
  retries?: number
  continue?: 'never' | 'deps-ok' | 'always'
  rules?: WorkspaceRules
}
```

## `RunStartInfo`

type · `src/report/events.ts`

Payload of the `run:start` event — mirrors the Logger.runStart hook.

```ts
export interface RunStartInfo {
  total: number
  concurrency?: number
  requestedCount?: number
  context?: RunContext
  startedAtMs?: number
}
```

## `RunSummary`

type · `src/orchestrator/options.ts`

```ts
export interface RunSummary {
  ok: boolean
  outcomes: TaskOutcome[]
  persistent?: HeldPersistent
  refused?: string
}
```

## `RunSummaryRecord`

type · `src/orchestrator/telemetry.ts`

A per-run summary, emitted once at run:end: the invocation header plus
per-task outcomes, so a store persists a run in one write.

```ts
export interface RunSummaryRecord {
  v: number
  run: RunContextRecord
  startedAt: number
  endedAt: number
  totalDurationMs: number
  taskCount: number
  failedCount: number
  abortedCount: number
  notRunCount?: number
  hitCount: number
  hitLocalCount: number
  hitRemoteCount: number
  upToDateCount: number
  restoredLocalCount: number
  restoredRemoteCount: number
  exitOk: boolean
  tasks: readonly TaskTelemetry[]
  stages?: readonly RunStage[]
  uploads?: { count: number; bytes: number; ms: number; failed: number }
  machines?: readonly MachineReport[]
  idealMs?: number
  advice?: readonly WorkerAdvice[]
}
```

## `SandboxConfig`

type · `src/config.ts`

What a sandboxed task may do, declared as capabilities. You say what the
task may touch; vx decides how each is enforced, and one the platform
cannot express is an error, not a silent no-op.

The baseline (`sandbox: {}`) grants almost nothing: no reads, no writes,
no network, not even the project directory, which is why `allow: { read:
['.'] }` opens most real blocks. The one implicit grant is dependencies:
`node_modules` and the real paths of the workspace packages linked
there.

Caching grants nothing: `inputs` says what invalidates a task, `allow`
what it may touch, and declared `outputs` are no write grant (only
`allow.write` binds).

Enforcement anchors at the workspace root, so a task cannot leave its
project whatever it declares. `docs/schema.md` § `exec.sandbox` has the
full account.

Paths are project-relative, absolute or `~`-expanded, and may be globs:
macOS matches the pattern, Linux expands it at start (a mount cannot
hold a pattern), so a file created later is not covered there; grant its
directory.

```ts
export interface SandboxConfig {
  allow?: SandboxGrants
  deny?: SandboxDenials
  ignore?: SandboxIgnore
  weakerWhenNested?: boolean
  weakerNetworkIsolation?: boolean
  hermetic?: boolean
}
```

## `SandboxDenials`

type · `src/config.ts`

```ts
export interface SandboxDenials {
  network?: readonly string[]
}
```

## `SandboxFix`

type · `src/graph/outcome.ts`

```ts
export interface SandboxFix {
  read?: string[]
  write?: string[]
  network?: string[]
  systemInfo?: string[]
  withheld?: string[]
  inputs?: string[]
  workspaceFiles?: string[]
}
```

## `SandboxGrants`

type · `src/config.ts`

```ts
export interface SandboxGrants {
  read?: readonly string[]
  write?: readonly string[]
  network?: true | readonly string[]
  systemInfo?: readonly string[]
  unixSockets?: true | readonly string[]
  localBinding?: boolean | readonly number[]
  machLookup?: readonly string[]
  pty?: boolean
  gitConfig?: boolean
}
```

## `ScheduleHookContext`

type · `src/orchestrator/plugin.ts`

```ts
export interface ScheduleHookContext extends BaseContext {
  readonly localCache: Cache
  readonly branch: string | null
  readonly refs: readonly string[]
  readonly measures: ReadonlyMap<string, string>
  readonly cache: PluginCache
  refine(
    weights: ReadonlyMap<string, number> | Promise<ReadonlyMap<string, number> | undefined>,
  ): void
  refining(): Promise<void>
  onRefine(listener: () => void): void
  flaky(taskIds: Iterable<string>): void
}
```

## `secretNamed`

function · `src/util/secret-mask.ts`

Whether vx masks a variable's value by its name alone (`NPM_TOKEN`, not `NPM_TOKEN_FILE`).

```ts
export function secretNamed(name: string): boolean
```

## `SecretRequest`

type · `src/util/secrets.ts`

What `ctx.secret` is asked: the entry's name, and the question to ask on a terminal.

```ts
export interface SecretRequest {
  readonly key: string
  readonly prompt?: string
}
```

## `SecretUnavailable`

type · `src/util/secrets.ts`

```ts
export interface SecretUnavailable extends Error {
  readonly reason: SecretUnavailableReason
}
```

## `SecretUnavailableReason`

type · `src/util/secrets.ts`

Why `secret` had nothing: the keychain lacks it and no prompt was given
(`not-found`), a prompt was given and nobody can answer — CI, no TTY, or
the status line already up (`no-terminal`), the answer was empty
(`declined`), or there is no keychain and no answer (`store-unavailable`).

```ts
export type SecretUnavailableReason = 'not-found' | 'no-terminal' | 'declined' | 'store-unavailable'
```

## `ServerSpec`

type · `src/exec/executor.ts`

A persistent dependency a `servers` executor starts where it runs the task, as `runPersistent` does.

```ts
export interface ServerSpec {
  readonly taskId: string
  readonly command: string
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
  readonly readyWhen?: string
  readonly timeoutMs?: number
  readonly sandbox?: { readonly config: SandboxConfig; readonly nested: readonly string[] }
}
```

## `SkippedOutcome`

type · `src/graph/outcome.ts`

It never started, so it has no exit; a key only when fail-fast stopped it after deriving one.

```ts
export interface SkippedOutcome extends OutcomeBase, None<FailureFacts>, BlockFacts, PlatformFacts {
  status: 'skipped'
  exitCode?: never
  hash?: string
  serverExit?: never
}
```

## `splitTaskId`

function · `src/util/task-id.ts`

The inverse of `taskId` (`graph/task-graph.ts`). Splits on the FIRST
`#`, so a task name that itself contains one round-trips: `taskId('a', 'b#c')` → `'a#b#c'` → `['a', 'b#c']`.

This exists because it kept being written by hand as `id.split('#', 2)`,
which is NOT the inverse — it discards everything after the second segment,
so `'a#b#c'` reads back as task `'b'`. Six call sites had that form while
`parseDependencySpec` (the surface that decides what actually runs) has
always split on the first `#`, so the query layer and the graph disagreed
about the identity of the same task: a lookup either found nothing or, worse,
answered with a different task's history.

A config's task name may not hold `#` (`taskNameProblem`), but an id also
arrives from run history and plugins, so the first-`#` rule is the one
the graph uses; one rule, one place.

```ts
export function splitTaskId(id: string): [project: string, task: string]
```

## `SucceededOutcome`

type · `src/graph/outcome.ts`

```ts
export interface SucceededOutcome
  extends StartedOutcome, None<FailureFacts>, None<BlockFacts>, None<PlatformFacts> {
  status: Exclude<TaskStatus, 'failed' | 'aborted' | 'skipped'>
  serverExit?: number
}
```

## `TaskArtifacts`

type · `src/orchestrator/task-artifacts.ts`

```ts
export interface TaskArtifacts {
  save(key: string, task: ArtifactTask, run: ArtifactRun): Promise<void>
  restore(key: string, task: ArtifactTask): Promise<CapturedChunk[] | null>
  output(key: string): Promise<CapturedChunk[] | null>
  share(key: string): Promise<boolean>
  resend(key: string): Promise<boolean>
  uploaded?(key: string): Promise<boolean | undefined>
}
```

## `TaskConfig`

type · `src/config.ts`

```ts
export interface TaskConfig {
  description?: string
  exec?: ExecConfig
  dependsOn?: readonly string[]
  inputs?: InputsConfig
  outputs?: TaskOutputs
  cache?: boolean
}
```

## `taskDefinitions`

function · `src/graph/definition.ts`

Each task's definition (`taskDefinition`) by id, groups left out: what a history reader matches rows to.

```ts
export function taskDefinitions(nodes: Iterable<TaskNode>): Map<string, string>
```

## `TaskExecutor`

type · `src/exec/executor.ts`

```ts
export interface TaskExecutor {
  readonly name: string
  readonly capabilities?: ExecutorCapabilities
  accepts?(task: TaskPlacement): boolean
  execute(req: ExecuteRequest): Promise<ExecuteResult>
  readonly distribution?: Distribution
}
```

## `TaskHistory`

type · `src/history/history.ts`

Per (project#task) — last RECENT runs collapsed into a summary.

```ts
export interface TaskHistory {
  runs: number
  p50DurationMs: number | undefined
  p99DurationMs: number | undefined
  successRate: number
  hitRate: number
  failureMode: FailureMode
  maxPeakRssBytes?: number
  maxCpuParallelism?: number
  saturatedCores?: number
  saturatedMemoryBytes?: number
  slowDurationMs?: number
}
```

## `TaskLogBuffer`

class · `src/orchestrator/task-log-buffer.ts`

Bounded per-run capture. `append` keeps a chunk LIST + running char count per
task, evicting from the head past `TASK_LOG_TAIL_CHARS` — no
string concatenation until `drain`, so a cache-hit replay (one big chunk) is
one array push, zero copies. `finish` decides retention; `drain` emits the
bundle, failures first.

```ts
export class TaskLogBuffer {
  append(taskId: string, chunk: string): void
  finish(taskId: string, status: TaskStatus, cacheSource: CacheSource, hash?: string): void
  takeEntry(taskId: string): TaskLogEntry | undefined
  drain(runId: string, workspaceId: string): TaskLogBundle
  size(): number
  budgetUsed(): number
}
```

## `TaskLogBundle`

type · `src/orchestrator/task-log-buffer.ts`

```ts
export interface TaskLogBundle {
  v: typeof LOG_WIRE_VERSION
  runId: string
  workspaceId: string
  tasks: TaskLogEntry[]
}
```

## `TaskLogEntry`

type · `src/orchestrator/task-log-buffer.ts`

```ts
export interface TaskLogEntry {
  taskId: string
  hash?: string
  status: 'success' | 'failed'
  content: string
  charsFull: number
  truncatedHeadChars: number
}
```

## `taskNameProblem`

function · `src/workspace/config-schema.ts`

Why `name` cannot be a task name, or null; `vx init` skips such a script.

```ts
export function taskNameProblem(name: string): string | null
```

## `TaskNode`

type · `src/graph/task-graph.ts`

```ts
export interface TaskNode {
  id: string
  projectName: string
  projectDir: string
  taskName: string
  config: TaskConfig
  deps: string[]
  orderOnly?: string[]
  requested: boolean
  surfaced?: boolean
  keyParts?: ReadonlyArray<readonly [name: string, value: string]>
  platform?: string
  worker?: string
  addsToOutputsOf?: string[]
  outputsAddedToBy?: string[]
  excludedUpstream?: TaskOutcome[]
}
```

## `TaskOutcome`

type · `src/graph/outcome.ts`

```ts
export type TaskOutcome = SucceededOutcome | FailedOutcome | AbortedOutcome | SkippedOutcome
```

## `TaskOutputs`

type · `src/config.ts`

```ts
export interface TaskOutputs {
  files: readonly string[]
  workspaceFiles?: readonly string[]
  clean?: boolean
}
```

## `TaskPlacement`

type · `src/exec/executor.ts`

What an executor sees when a task is PLACED — once per task, before scheduling.

```ts
export interface TaskPlacement {
  readonly taskId: string
  readonly projectName: string
  readonly projectDir: string
  readonly command: string
  readonly pinnedLocal: boolean
  readonly cacheable: boolean
}
```

## `TaskResources`

type · `src/history/history.ts`

What a scheduler learns from a task's history: its p50 and its resource maxima.

```ts
export type TaskResources = Pick<
  TaskHistory,
  | 'p50DurationMs'
  | 'maxPeakRssBytes'
  | 'maxCpuParallelism'
  | 'saturatedCores'
  | 'saturatedMemoryBytes'
  | 'slowDurationMs'
```

## `TaskStatus`

type · `src/graph/task-status.ts`

```ts
export type TaskStatus =
  | 'success'
  | 'cache-hit'
  | 'cache-hit-remote'
  | 'failed'
  | 'skipped'
  | 'aborted'
```

## `TaskTelemetry`

type · `src/orchestrator/telemetry.ts`

Denormalized per-task analytics — shared by the streaming `task.end`
 record and the per-run summary's `tasks[]`.

```ts
export interface TaskTelemetry {
  taskId: string
  project: string
  task: string
  status: TaskStatus
  cacheSource: CacheSource
  exitCode: number
  durationMs: number
  hash?: string
  cpuMs?: number
  peakRssBytes?: number
  where?: string
  carried?: true
  outputs?: 'deferred'
  attempts?: number
  blockedBy?: string
  otherPlatform?: { readonly needs: readonly string[]; readonly host: string }
  timedOut?: true
  sandboxViolations?: number
  notReady?: 'timeout' | 'exited' | 'spawn'
  failedAttempts?: readonly FailedAttempt[]
  flaky?: { passes: number; failures: number }
  sandboxViolationLines?: readonly string[]
  storedDurationMs?: number
  storedCpuMs?: number
  storedPeakRssBytes?: number
  admissionHeldMs?: number
  queuedMs?: number
  inputFiles?: number
  inputChanges?: InputChanges
  artifactBytes?: number
  fetchMs?: number
  saveMs?: number
  restored?: boolean
  wallclockStartNs?: string
  wallclockEndNs?: string
}
```

## `TaskView`

type · `src/report/events.ts`

Display projection of a TaskNode — exactly the fields renderers read.

```ts
export interface TaskView {
  id: string
  project: string
  task: string
  isGroup: boolean
  requested: boolean
  surfaced: boolean
  persistent: boolean
  command?: string
}
```

## `TELEMETRY_SCHEMA_VERSION`

const · `src/orchestrator/telemetry.ts`

Bumped when the record shape changes. Readers MUST check `v`.

```ts
export const TELEMETRY_SCHEMA_VERSION = 4
```

## `TelemetryContext`

type · `src/orchestrator/telemetry.ts`

Read-only context a sink is created with. No mutable run handle — the
 isolation guarantee is structural.

```ts
export interface TelemetryContext {
  readonly workspaceRoot: string
  readonly cacheDir: string
  warn(message: string): void
}
```

## `TelemetryRecord`

type · `src/orchestrator/telemetry.ts`

A streaming record, one per lifecycle event: the `WireEvent` plus run context
and per-task analytics. `task.log` records are large and opt-in
(`TelemetrySink.wants`).

```ts
export type TelemetryRecord =
  | {
      v: number
      kind: 'run.start'
      run: RunContextRecord
      total: number
      ts: number
      startedAt: number
      originAt?: number
    }
  | {
      v: number
      kind: 'task.start'
      runId: string
      taskId: string
      project: string
      task: string
      command?: string
      dependsOn?: readonly string[]
      ts: number
    }
  | {
      v: number
      kind: 'task.log'
      runId: string
      taskId: string
      stream: 'stdout' | 'stderr'
      chunk: string
      ts: number
    }
  | {
      v: number
      kind: 'task.sample'
      runId: string
      taskId: string
      ts: number
      cpuMs: number
      rssBytes: number
    }
  | ({ v: number; kind: 'task.end'; runId: string; ts: number } & TaskTelemetry)
  | { v: number; kind: 'run.end'; runId: string; ts: number }
```

## `TelemetrySink`

type · `src/orchestrator/telemetry.ts`

A telemetry consumer. Observe-only: receives records, frozen, holds no
run handle. A write to a record throws, and the sink is switched off for
the run as for any throw.

```ts
export interface TelemetrySink {
  readonly name?: string
  readonly wants?: ReadonlyArray<TelemetryRecord['kind']>
  onRecord?(record: TelemetryRecord): void
  onRunSummary?(summary: RunSummaryRecord): void
  flush?(signal: AbortSignal): Promise<void>
}
```

## `TreeUsage`

type · `src/exec/proc-sample.ts`

```ts
export interface TreeUsage {
  cpuMs: number
  rssBytes: number
}
```

## `ui`

namespace · `src/ui/kit.ts`

```ts
export const cmd = (text: string): Inline => ({ style: 'strong', text })
export function code(frame: string): Block
export const dim = (text: string): Inline => ({ style: 'muted', text })
export function excerpt(title: string, body: string): Block
export function fields(rows: readonly FieldRow[]): Block
export function fix(action: Inline): Block
export function gap(): Block
export const id = (text: string): Inline => ({ style: 'id', text })
export function inline(x: Inline, c: ColorSupport): string
export function line(...items: Inline[]): Block
export function next(command: Inline): Block
export function notice(p: NoticeParts): Block
export const path = (text: string): Inline => ({ style: 'strong', text })
export const place = (text: string): Inline => (text === 'local' ? dim(text) : id(text))
export function render(blocks: readonly Block[], colors: ColorSupport): string
export function report(title: string, rows: readonly FieldRow[]): Block
export function section(title: string, ...body: Block[]): Block
export function section(title: string, count: Inline, ...body: Block[]): Block
export function section(title: string, ...rest: (Block | Inline)[]): Block
export function status(t: Tone, verb: string, headline: Inline): Block
export const strong = (text: string): Inline => ({ style: 'strong', text })
export function table(columns: readonly Column[], rows: readonly (readonly Inline[])[]): Block
export function tagged(t: Tone, line: string, c: ColorSupport): string
export function text(...items: Inline[]): Block
export const tone = (t: Style, text: string, bold = false): Inline =>
  bold ? { style: t, text, bold } : { style: t, text }
export function why(line: Inline): Block
export interface Block {
  readonly lines: (colors: ColorSupport) => string[]
  readonly head?: (colors: ColorSupport) => string
}
export type Column = string | { readonly title: string; readonly align: 'right' }
export type FieldRow = readonly [label: string, ...values: Inline[]] | null
export type Inline = string | Token | readonly Inline[]
export interface NoticeParts {
  tone: Tone
  verb: string
  headline: Inline
  /** What is wrong, one fact a line. */
  what?: readonly Inline[]
  why?: Inline
  /** A source frame, below the facts. */
  code?: string
  fix?: Inline
}
export interface ColorSupport {
  enabled: boolean
  readonly columns?: number | undefined
}
export type Style =
  | 'ok'
  | 'warn'
  | 'error'
  | 'info'
  | 'aborted'
  | 'notRun'
  | 'local'
  | 'remote'
  | 'heading'
  | 'term'
  | 'value'
  | 'muted'
  | 'strong'
  | 'label'
  | 'border'
  | 'plain'
export type Tone = 'ok' | 'warn' | 'error' | 'info'
export function colorsOf(stream: StreamName): ReturnType<typeof detectColors>
export function data(stream: StreamName, bytes: string): void
export function print(stream: StreamName, ...blocks: Block[]): void
export function say(t: Tone, line: string, stream: StreamName = 'err'): void
export function transient(line: Inline): () => void
export type StreamName = 'out' | 'err'
```

## `UserError`

class · `src/util/errors.ts`

```ts
export class UserError extends Error {
  readonly code: string
  parts?: RefusalParts
  constructor(message: string)
  constructor(message: string, code: string)
  constructor(message: string, code = 'VX_E_REFUSED')
}
```

## `VERSION`

const · `src/version.ts`

```ts
export const VERSION: string = pkg.version
```

## `VxPlugin`

type · `src/orchestrator/plugin.ts`

A vx plugin: any subset of where work runs (executor), which cache is used
(cache) and who observes (telemetry). It never changes what a task is (its
command), only where and how it runs. Registered explicitly in
`.vx/workspace.ts`; no auto-discovery. Made only by
`definePlugin(import.meta, hooks)`. Core names no plugin; the local
executor and cache are the floor under the list.

```ts
export interface VxPlugin {
  readonly name: string
  config?(workspace: WorkspaceConfig, ctx: ConfigContext): void | Promise<void>
  discover?(
    ctx: DiscoverContext,
  ): readonly DiscoveredProject[] | Promise<readonly DiscoveredProject[]>
  project?(config: ProjectConfig, ctx: ProjectHookContext): void | Promise<void>
  graph?(nodes: Map<string, TaskNode>, ctx: GraphHookContext): void | Promise<void>
  key?(
    task: TaskNode,
    ctx: KeyHookContext,
  ):
    | Readonly<Record<string, string>>
    | undefined
    | Promise<Readonly<Record<string, string>> | undefined>
  readonly fingerprint?: FingerprintClaim
  schedule?(
    nodes: ReadonlyMap<string, TaskNode>,
    ctx: ScheduleHookContext,
  ): ReadonlyMap<string, number> | undefined | Promise<ReadonlyMap<string, number> | undefined>
  measures?(nodes: ReadonlyMap<string, TaskNode>): ReadonlyMap<string, string> | undefined
  admit?(task: TaskNode, ctx: AdmitContext): boolean
  readonly commands?: Readonly<Record<string, PluginCommand>>
  cache?(ctx: CacheContext): RemoteCacheLayer | undefined | Promise<RemoteCacheLayer | undefined>
  executor?(ctx: ExecutorContext): TaskExecutor | undefined | Promise<TaskExecutor | undefined>
  telemetry?(
    ctx: TelemetryContext,
  ):
    | TelemetrySink
    | TelemetrySink[]
    | undefined
    | Promise<TelemetrySink | TelemetrySink[] | undefined>
  output?(ctx: OutputContext): Logger | undefined | Promise<Logger | undefined>
  setup?(ctx: PluginSetupContext): void | Promise<void>
  teardown?(run?: RunReport): void | Promise<void>
}
```

## `WatchSettings`

type · `src/config.ts`

`WorkspaceConfig.watch`.

```ts
export interface WatchSettings {
  poll?: boolean
}
```

## `withForwardArgs`

function · `src/exec/runner.ts`

The task's command with the args after `--` appended, shell-quoted, before
any trailing comment (after it they vanished silently). Trailing blanks go
first.

```ts
export function withForwardArgs(command: string, args: readonly string[] | undefined): string
```

## `WorkerAdvice`

type · `src/exec/executor.ts`

Workers that would have run the run best (`TaskExecutor.advice`).
`declared`: as many of each size as end it soonest; `more`: past a size's
limit, when sooner; `any`: one shape per platform, ending as soon for the
least core time.

```ts
export interface WorkerAdvice {
  of: 'declared' | 'more' | 'any'
  endMs: number
  workers: readonly {
    count: number
    cores: number
    memoryBytes: number
    platform?: string
    size?: string
  }[]
}
```

## `workerRuntime`

function · `src/orchestrator/worker-runtime.ts`

```ts
export function workerRuntime(opts: {
  readonly root: string
  readonly onServer?: (taskId: string, pid: number | undefined) => void
}): WorkerRuntime
```

## `WorkerRuntime`

type · `src/orchestrator/worker-runtime.ts`

```ts
export interface WorkerRuntime {
  prepare(task: WorkerTask): Promise<PreparedTask>
  probe(command: string, dir: string, workspace: boolean): Promise<string>
  packageManager(): string | null
  sample(roots: readonly number[]): Promise<ReadonlyMap<number, TreeUsage>>
  rearm(sandboxes: readonly SandboxConfig[]): Promise<void>
  stop(taskId: string): Promise<void>
  close(): Promise<void>
}
```

## `WorkerSandbox`

type · `src/orchestrator/worker-runtime.ts`

A task's `exec.sandbox` as a worker receives it: built into walls on this machine.

```ts
export interface WorkerSandbox {
  readonly config: SandboxConfig
  readonly keyed?: readonly string[]
  readonly reads?: readonly string[]
  readonly reported?: readonly string[]
  readonly readable?: readonly ReadableOutputs[]
}
```

## `WorkerTask`

type · `src/orchestrator/worker-runtime.ts`

A task to run here: the request core would build, with its sandbox not yet built.

```ts
export interface WorkerTask extends Omit<
  ExecuteRequest,
  'sandbox' | 'capture' | 'onStdout' | 'onStderr' | 'workspaceRoot'
```

## `WorkspaceConfig`

type · `src/config.ts`

The workspace: settings in groups (`run`, `cache`, `lock`, `watch`) and the
plugins. Each setting's environment variable and flag derive from its
path (`run.concurrency` → `VX_RUN_CONCURRENCY`, `vx run --concurrency`); a flag beats
the variable, which beats this file. `docs/schema.md` lists them all.
Nothing here is folded into a cache key.

```ts
export interface WorkspaceConfig {
  baseBranch?: string
  run?: RunSettings
  cache?: CacheSettings
  inputs?: WorkspaceInputs
  outputs?: WorkspaceOutputs
  lock?: LockSettings
  watch?: WatchSettings
  plugins?: readonly (Plugin | undefined | null | false)[]
}
```

## `WorkspaceHookContext`

type · `src/orchestrator/plugin.ts`

`config` runs before the cache dir is known — it may be what the hook changes.

```ts
export interface WorkspaceHookContext {
  readonly workspaceRoot: string
  warn(message: string): void
}
```

## `WorkspaceIdentity`

type · `src/orchestrator/run-context.ts`

```ts
export interface WorkspaceIdentity {
  id: string
  name: string
  repository?: string
  path?: string
}
```

## `WorkspaceInputs`

type · `src/config.ts`

`WorkspaceConfig.inputs`.

```ts
export interface WorkspaceInputs {
  stability?: InputStability
}
```

## `WorkspaceOutputs`

type · `src/config.ts`

`WorkspaceConfig.outputs`.

```ts
export interface WorkspaceOutputs {
  clean?: boolean
}
```
