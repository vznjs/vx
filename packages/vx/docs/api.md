# API reference

Every export of `@vzn/vx`, generated from `src/index.ts` by
`tests/api-reference.test.ts`: the declaration (comments dropped, a
function to its signature, a class to its public members) and the doc
comment above it. [The public surface](modules/index.md) groups the
same names by what they are for; the plugins guide shows them in use.

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

What `--affected` seeds its tasks from (2026-10-04): the changed
projects, each one's changed paths relative to it, and the projects a
change reaches as a whole — every task in one is affected whatever its
inputs say, because the reason was no path of its own (a lockfile claim,
a config import, a nested repository, a
workspace-wide file).

```ts
export interface AffectedChanges {
  projects: Set<string>
  changed: readonly string[]
  paths: ReadonlyMap<string, readonly string[]>
  whole: ReadonlySet<string>
  wholeBy?: ReadonlyMap<string, string>
  nested?: readonly string[]
  dirLinks?: ReadonlySet<string>
  dirLinksIn?: ReadonlyMap<string, ReadonlySet<string>>
}
```

## `answerRuntime`

function · `src/cache/inputs.ts`

One runtime probe answered on this machine as a key folds it: an
`inputs.runtime` command run in `projectDir`, or with `workspace` a
`workspaceRuntime` one run in `workspaceRoot`. For an executor that
checks a task's probes where it runs it (`TaskExecutor.runtime`).

```ts
export function answerRuntime(
  command: string,
  projectDir: string,
  workspaceRoot: string,
  workspace = false,
): Promise<string>
```

## `applyMigration`

function · `src/workspace/migration.ts`

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
  unmapped?: boolean
  emptyReason?: string
  format?: MigrationFormat
  json?: boolean
  lock?: (root: string) => Promise<{ code: number; said: string }>
  steps?: readonly (readonly [label: string, value: string])[]
  plugins?: readonly WorkspacePlugin[]
}
```

## `ArtifactInfo`

type · `src/cache/layered-cache.ts`

What a remote knows of an artifact it holds, before it is downloaded:
the body's size in bytes and the producing task's duration, each when
the wire carries it (Turbo's batch query and `HEAD` do).

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

## `BoundedCapture`

class · `src/exec/runner.ts`

A head-and-tail accumulator: the head fills once, the tail is a ring
of chunks trimmed from the front, so memory is bounded by the two
limits plus one chunk whatever the task prints. Each chunk keeps its
stream, so one capture can hold both in the order they arrived.

```ts
export class BoundedCapture {
  constructor(
    private readonly headChars = CAPTURE_HEAD_CHARS,
    private readonly tailChars = CAPTURE_TAIL_CHARS,
  ) {}
  push(text: string, err = false): void
  rebound(
    headChars: number,
    tailChars: number,
    through: (chunks: CapturedChunk[]) => CapturedChunk[] = (c) => c,
  ): BoundedCapture
  chunks(): CapturedChunk[]
  text(): string
}
```

## `branchCacheScope`

function · `src/workspace/config-schema.ts`

A branch's cache scope, `<owner>/<repo>:<branch>`: what CI writes for a
branch and a laptop on it reads (2026-10-17). The repository's
identity, not a remote's local name, so a clone whose `origin` is a fork
names the fork. A name may hold characters a scope may not; each
becomes `_`.

```ts
export function branchCacheScope(repo: string, branch: string): string
```

## `BranchFacts`

type · `src/orchestrator/plugin.ts`

What a CI knows of the run's branch (2026-10-17): `scope`, the
cache scope (`'vznjs/vx:feat-x'`; `VX_CACHE_SCOPE` beats it, and it
beats the one git names), and `base`, the commit the branch is compared
with (a pull request's base), for a bare `--affected`. `trusted`: the
run has no scope, whatever git names (a merge queue's run,
2026-10-18). The scope keys plugin entries only. `refs`: the refs a
remote reads, in order (`CacheContext.refs`; 2026-10-25: a pull
request its head branch, then its base, then the default branch; a
merge queue or train only its base); unset, git's. A later plugin's
field wins.

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
  readonly remoteHits: RemoteHits
  readonly storeDir: string | undefined
  readonly schemaReset: SchemaReset | null
  readonly formatChange: SchemaReset | null
  readonly storeReset: SchemaReset | null
  static inspect(cacheDir: string): Cache
  constructor(
    private readonly cacheDir: string,
    localPolicy: { read: boolean; write: boolean } = { read: true, write: true },
    repoDir?: string,
    private readonly artifactCeiling: number = MAX_DECOMPRESSED_ARTIFACT_BYTES,
    mode: 'open' | 'inspect' | 'preview' = 'open',
    storeRoot?: string | null,
    private readonly store: StoreOptions = DEFAULT_STORE,
  )
  hashFile(filePath: string): Promise<string>
  hashBytes(bytes: Uint8Array, nearPath: string): string
  hashFiles(paths: readonly string[]): Promise<Map<string, string>>
  knownBlobSizes(oids: readonly string[]): Map<string, number>
  rememberBlobSizes(sizes: ReadonlyMap<string, number>): void
  blobVerdict(digest: string): string[] | undefined
  rememberBlobVerdict(digest: string, paths: readonly string[]): void
  foldMemo(): FoldMemo
  key(input: CacheKeyInput): Promise<string>
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
  async prefetch(_hash: string, _ctx?: CacheGetContext): Promise<boolean>
  loadOutputFilesBatch(hashes: readonly string[]): Map<string, OutputFileRow[]>
  isOutputsCurrent(projectDir: string, expected: readonly OutputFileRow[]): boolean
  outputsPath(hash: string): string
  artifactSize(hash: string): number | undefined
  async recordOutputDirs(
    hash: string,
    projectDir: string,
    prefixes: readonly string[],
    holds?: (files: readonly string[]) => boolean,
  ): Promise<void>
  recordOutputStamps(hash: string, projectDir: string, workspaceRoot: string): void
  loadOutputDirsBatch(hashes: readonly string[]): Map<string, OutputDirRow[]>
  outputDirsCurrent(projectDir: string, rows: readonly OutputDirRow[]): boolean
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
    | { compressed: Uint8Array; tar: Uint8Array }
    | { tmpPath: string }
    | { plan: true; saved: SavedTree }
  >
  dbHandle(): Database
  recordRun(run: RunRecord): void
  recordRuns(runs: readonly RunRecord[]): void
  recordRunBundle(bundle: { runs: readonly RunRecord[]; invocation: InvocationRecord }): void
  recordRemoteErrors(runId: string, errors: readonly (readonly [string, string])[]): void
  stats(opts: CacheStatsOptions = {}): CacheStats
  async prune(options: PruneOptions): Promise<PruneResult>
  async orphanStats(): Promise<{ orphans: number; orphanBytes: number }>
  close(): void
}
```

## `CacheConfig`

type · `src/config.ts`

```ts
export interface CacheConfig {
  outputs: CacheOutputs
  inputStability?: InputStability
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

The shape every cache implementation honors. `Cache` (the local store)
and `LayeredCache` both `implements` this so the
orchestrator's `executeTask` can take either without a discriminated
union and we get a compile-time guarantee the surfaces stay congruent.

```ts
export interface CacheLayer {
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
  loadOutputFilesBatch(hashes: readonly string[]): Map<string, OutputFileRow[]>
  isOutputsCurrent(projectDir: string, expected: readonly OutputFileRow[]): boolean
  recordOutputDirs?(
    hash: string,
    projectDir: string,
    prefixes: readonly string[],
    holds?: (files: readonly string[]) => boolean,
  ): Promise<void>
  recordOutputStamps?(hash: string, projectDir: string, workspaceRoot: string): void
  loadOutputDirsBatch?(hashes: readonly string[]): Map<string, OutputDirRow[]>
  outputDirsCurrent?(projectDir: string, rows: readonly OutputDirRow[]): boolean
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
  recordRunBundle(bundle: { runs: readonly RunRecord[]; invocation: InvocationRecord }): void
  stats(opts?: CacheStatsOptions): CacheStats
  hashFile(filePath: string): Promise<string>
  outputsPath(hash: string): string
  artifactSize?(hash: string): number | undefined
  prune(options: PruneOptions): Promise<PruneResult>
  close(): void
}
```

## `CacheOutputs`

type · `src/config.ts`

```ts
export interface CacheOutputs {
  files: readonly string[]
  workspaceFiles?: readonly string[]
  clean?: boolean
}
```

## `CachePolicy`

type · `src/cache/policy.ts`

Independent read/write control over the two cache layers (local +
remote). Replaces the old single `noCache` boolean: each axis can be
toggled on its own so `--force` (re-execute but still refresh the
cache) is distinct from `--no-cache` (disable everything).

The task-artifact get/save path is gated, and the local axes also gate
the local store's file-hash writes (`cache.ts`). `recordRun`, `stats`, `prune`, key derivation, and
prefetch-ingest are never affected — they are bookkeeping/analytics
that a run policy has no business disabling.

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
  inputStability?: InputStability
  outputs?: { clean?: boolean }
  upload?: { failures?: 'ci' | 'local' | 'always' }
  store?: { embeddings?: false | string; decompress?: boolean }
  concurrency?: { download?: number; upload?: number; restore?: number }
}
```

## `CacheSource`

type · `src/graph/task-status.ts`

Where a task's result came from, derived ONCE in core from the status.

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
The name is read from the package the calling module belongs to — the
nearest `package.json` above it that has a name — and stamped where the workspace loader
checks for it, so a plugin cannot be named anything but its package.

```ts
export function definePlugin(origin: PluginOrigin, hooks: PluginHooks): VxPlugin
```

## `defineProject`

function · `src/config.ts`

Identity function — exists only so TypeScript narrows literal types
and, crucially, **validates `dependsOn` against this project's own
task names**. A bare entry that isn't a declared task key is a compile
error; `^name` / `pkg#name` forms reference other projects and stay
free strings. Runtime behavior is unchanged (it returns its input).

```ts
export function defineProject<const T extends ProjectConfig>(
  config: T &
    KnownExecs<T> &
    Known<T, ProjectConfig> & {
      tasks?: {
        [K in keyof NonNullable<T['tasks']>]?: Known<NonNullable<T['tasks']>[K], TaskConfig> & {
          dependsOn?: readonly DependsOnEntry<Extract<keyof NonNullable<T['tasks']>, string>>[]
          exec?: Known<At<NonNullable<T['tasks']>[K], 'exec'>, ExecConfig>
          inputs?: Known<At<NonNullable<T['tasks']>[K], 'inputs'>, InputsConfig>
          cache?: Known<At<NonNullable<T['tasks']>[K], 'cache'>, CacheConfig> & {
            outputs?: Known<At<At<NonNullable<T['tasks']>[K], 'cache'>, 'outputs'>, CacheOutputs>
          }
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
      cache?: Known<At<T, 'cache'>, CacheSettings> & {
        inputStability?: Known<At<At<T, 'cache'>, 'inputStability'>, InputStability>
      }
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

What a remote executor rejects with when it gives a task back: core runs
the same request on the local floor and says `reason` once (a remote that
never started it, B-100). A task placed `remote: 'only'` must not run
here, so it fails naming `reason` instead. Matched by name, as
`isUserError` is: a plugin's `@vzn/vx` can be another copy of this class.

```ts
export function executorFallback(reason: string): Error
```

## `exitSignal`

function · `src/exec/runner.ts`

The reverse: the signal an exit above 128 stands for (137 → SIGKILL),
by the platform's numbering; undefined for a plain exit. The shell
reports 128 + n for a death by signal n, so the read is the shell's
convention, not proof — a command may exit 137 on its own.

```ts
export function exitSignal(code: number): string | undefined
```

## `findWorkspaceRoot`

function · `src/workspace/workspace.ts`

The workspace root for `start`: the directory holding the first
`.vx/workspace.*` from `start` up to the git top-level, or up to `/`
outside git ({@link workspaceFile}, shared with the hand-off). Nothing
else decides it (2026-10-13: "Workspace file is the ultimate"):
not a `package.json`, not `pnpm-workspace.yaml`, not a lockfile. Throws
`VX_E_NO_WORKSPACE` when there is none.

Outside git, a file another user owns is refused (root aside): a
`.vx/workspace.ts` planted in a shared directory above you (`/tmp`) is
code that would run as you. The owner is the file's own, a link's
included, and its `.vx` directory's. Inside git the walk never leaves your
checkout. The directory you run in is yours to judge, and costs no
stat. Run as root, vx trusts every owner, as a container over a mounted
checkout needs. `uid` is for tests.

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
  extraFiles?(file: string, bytes: Uint8Array): readonly string[]
}
```

## `FingerprintContext`

type · `src/orchestrator/plugin.ts`

```ts
export interface FingerprintContext extends BaseContext {
  readonly projects: ReadonlyArray<{ readonly name: string; readonly dir: string }>
}
```

## `foldScriptHooks`

function · `src/workspace/migration.ts`

A package.json script with the `pre<name>` / `post<name>` hooks npm runs
around it, as ONE sh command. Each part runs in its own subshell, so a
`;` or an `exit` in one ends that part alone, and the chain stops at the
first that fails, as npm stops. The parts sit in a function the
forwarded `--` args are appended to, and only the body takes them, as
npm appends them to the script and never to its hooks. A plain ` && `
join handed them to the post hook, and `test -f x && echo A; echo B` ran
`echo B` after a failed pre hook and went green (item 905). npm appends
them as TEXT: no part sees them as `$1`…, so the function quotes them
into `vx_a`, clears its positional parameters, and evals the body with
`vx_a` after it; `"$@"` on the body made a script's `$1` the first
forwarded arg and its `$*` print them twice. Each part ends on its own
line, so a trailing `# comment` cannot swallow the paren. A script with
no hooks is its body, verbatim.

```ts
export function foldScriptHooks(
  pre: string | undefined,
  body: string,
  post: string | undefined,
): string
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

type · `src/cache/layer.ts`

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

Did the task's result come out of the cache (either layer)? Derived from
`deriveCacheSource` rather than re-listing the two hit statuses, so the two
cannot disagree about what a hit is. Unknown strings read as not-a-hit.

```ts
export function isCacheHit(status: string): boolean
```

## `isLiteralPattern`

function · `src/util/paths.ts`

True when a pattern carries no wildcard — it names exactly one path.

The character SET is the whole content: in a task glob `*`, `?` and a
brace alternation are wildcards, so a pattern holding any of them must
be MATCHED, never compared as a string. It lives here, exported, because
four places asked the same question and one of them asked it with a
smaller set: `graph/task-graph.ts` omitted `{}`, so `dist/{a,b}.txt`
counted as a literal and the overlapping-output refusal compared it to
`dist/a.txt` as two unequal strings — the two tasks were accepted and
then deleted each other's outputs, green, every run (item 495). That is
the same divergence `asTrees` was moved here to end in item 442, and the
same one that removed `@vzn/vx-migrate`'s copy of `outputsOverlap` in
item 445.

```ts
export function isLiteralPattern(glob: string): boolean
```

## `isPassStatus`

function · `src/graph/task-status.ts`

Did the task pass? A cache hit counts — it produced the same result without
spending the time, which is the whole point. `skipped` and `aborted` do NOT:
neither finished on its own terms, so neither can vouch for anything.

Takes `string`, not `TaskStatus`, because most callers hold a status that
arrived over a wire or out of a database column. An unrecognised string
reads as NOT passing — the safe direction, since the alternative is calling
a run green on a status this build has never heard of.

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
workspace imports `@vzn/vx` from node_modules, so a plugin's `UserError`
is a different class object and `instanceof` is false — a plugin verb's
"bad flag --x" printed as `UserError: bad flag --x` with a stack, and a
REAPI refusal would have read as an "internal error" (reproduced through
the real binary, 2026-09-03). The name is the contract that survives the
copy boundary.

```ts
export function isUserError(err: unknown): err is UserError
```

## `KeyHookContext`

type · `src/orchestrator/plugin.ts`

```ts
export interface KeyHookContext extends BaseContext {}
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

## `localFloor`

function · `src/orchestrator/local-floor.ts`

`sandboxes`, in a process that is no run, are the `exec.sandbox` configs
of every sandboxed task the run holds: the runtime's proxy and its
unix-socket filter are one per process, set from their union before the
first sandboxed task (`prepareSandbox`). A request that carries a
`signal` but no `liveChildren` has its children stopped here when it
aborts, the way a run's stop ends its own.

```ts
export function localFloor(
  sandboxes: readonly NonNullable<ExecConfig['sandbox']>[] = [],
): LocalFloor
```

## `LocalFloor`

type · `src/orchestrator/local-floor.ts`

```ts
export interface LocalFloor {
  execute(req: ExecuteRequest): Promise<ExecuteResult>
  rearm(sandboxes: readonly NonNullable<ExecConfig['sandbox']>[]): Promise<void>
  close(): Promise<void>
}
```

## `LocalHistoryProvider`

class · `src/history/history.ts`

Reads from the orchestrator's local SQLite cache.db.

```ts
export class LocalHistoryProvider implements HistoryProvider {
  constructor(
    private readonly db: Database,
    readonly recent: number
    private readonly branch?: string | null,
    private readonly defs?: ReadonlyMap<string, string>,
  ) {}
  async loadFor(taskIds: readonly string[]): Promise<HistoryTable>
  async loadAll(): Promise<HistoryTable>
  async p50sFor(taskIds: readonly string[]): Promise<ReadonlyMap<string, number>>
  lackedBranchHistory
  hasImported(sha: string): boolean
  importTimings(
    sha: string,
    timings: ReadonlyMap<string, number>,
    needs: ReadonlyMap<string, TaskResources> = new Map(),
    defs: ReadonlyMap<string, string> = new Map(),
  ): void
  async resourcesFor(taskIds: readonly string[]): Promise<ReadonlyMap<string, TaskResources>>
}
```

## `lockfileClaim`

function · `src/orchestrator/lockfile-claim.ts`

```ts
export function lockfileClaim(options: LockfileClaimOptions): LockfileClaimHooks
```

## `LockfileClaimHooks`

type · `src/orchestrator/lockfile-claim.ts`

What a lockfile plugin spreads into `definePlugin` (`fingerprint`, `key`), and `importers` for its own stages.

```ts
export interface LockfileClaimHooks {
  readonly fingerprint: FingerprintClaim
  key(task: TaskNode, ctx: KeyHookContext): Promise<Readonly<Record<string, string>> | undefined>
  importers(ctx: {
    readonly workspaceRoot: string
    readonly cacheDir: string
  }): Promise<ReadonlyMap<string, LockfileImporter> | undefined>
}
```

## `LockfileClaimOptions`

type · `src/orchestrator/lockfile-claim.ts`

```ts
export interface LockfileClaimOptions {
  readonly file: string
  readonly digest: (text: string, files: ReadonlyMap<string, string>) => ReadonlyMap<string, string>
  readonly extraFiles?: (text: string) => readonly string[]
  readonly version: number
  readonly scope?: 'project' | 'workspace'
  readonly part?: string
  readonly importers?: (text: string) => ReadonlyMap<string, LockfileImporter>
}
```

## `LockfileImporter`

type · `src/orchestrator/lockfile-claim.ts`

What a lockfile records of one importer's links to the workspace's other
importers: dependency name → importer directory (root-relative POSIX,
`.` for the root).

```ts
export interface LockfileImporter {
  readonly deps: Readonly<Record<string, string>>
  readonly peers: Readonly<Record<string, string>>
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

## `mergeBaseWith`

function · `src/workspace/affected.ts`

The merge base of `ref` and HEAD, or undefined when there is none. A
shallow clone fetches what it needs from origin (`reachMergeBase`):
a plugin reading the base branch's history (shared timings) asks this,
not `git merge-base`, so a one-commit checkout serves it too.

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

A project the adoption tool found: its name, directory and the vx config
it already has. `packageJson.type` picks `vx.config.mts` for a CommonJS
TypeScript package.

```ts
export interface MigrationMember {
  readonly name: string
  readonly dir: string
  readonly configPath: string | null
  readonly packageJson?: object
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

The spellings a reader, Turbo and `.gitignore` all accept but a matcher
fed the raw string turns into NOTHING — and a task keyed on nothing
replays old outputs as a green hit (2026-09-10, probed one by one):
a leading `./`, an inner `/./` segment, a doubled `//`, and a trailing
`/` on a pattern (`src/*\/` means the trees under `src`, so it becomes
`src/*\/**`; a trailing slash on a LITERAL is `asTrees`' job), and a
trailing `/.`, read as a trailing `/`. Applied
after an optional `!`; a bare `.` is the empty entry the schema refuses.

```ts
export function normalizeGlob(glob: string): string
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

The directories whose snapshot covers every path the positive `globs`
can match, or `null` when one reaches outside the project. A
whole-subtree glob or a literal is its own tree
({@link wholeSubtreePrefixes}); any other glob is the tree under its
static prefix, and a root-anchored one (`**\/dist/**`, Turbo's shape) is
the whole project, `''`. Sound for the same reason: a file added or
removed anywhere under a recorded directory bumps a recorded mtime. The
snapshot's file list is then held to the entry's rows through the globs
themselves, so a source file beside the outputs is no stray.

```ts
export function outputDirPrefixes(globs: readonly string[]): string[] | null
```

## `outputsOverlap`

function · `src/graph/task-graph.ts`

True only when two output globs PROVABLY select an overlapping set.

Deliberately conservative, because the caller REFUSES the run: a false
positive breaks a build that works today, which is worse than the defect
being caught. So the three cases are exactly the ones that can be decided
without a general glob-intersection algorithm:

  both literal    — equal paths
  literal vs glob — ask the glob whether it matches the literal (exact)
  both globs      — identical strings, or one a whole subtree `P/**`
                    and the other's literal prefix P or under it: every
                    path the second matches is under P, so the first
                    covers it (item 941). Anything else is undecided
                    here and deliberately allowed through

The rejected alternative was comparing each glob's static prefix. It is
cheaper and catches more, but it is UNSOUND for a refusal — measured:
`dist/vx-*` and `dist/other.txt` share the prefix `dist` while matching
disjoint sets, so a prefix check refuses a legitimate config. (vx's own
`build.bun.*` tasks escape only because they declare distinct literals.)

All three cases compare SPELLINGS, so each side is run through
`asTrees` first — the same rule the resolver and `cleanOutputs` read,
and `cleanOutputs` is what actually does the deleting. That folds two
things this check used to miss, both of them the data loss it exists to
prevent:

  - the SPELLING: `./dist/**` and `dist/**` are one tree to every
    matcher in vx, and `Bun.Glob('dist/**')` does not match the literal
    `./dist/app.js` either (item 441, probed one spelling at a time);
  - the literal DIRECTORY: `outputs: ['dist']` means everything under
    `dist` — `asTrees` compiles it to `dist` + `dist/**` — while this
    compared it to `dist/app.js` as two unequal literals. Measured end
    to end: the task declaring `dist` wiped the other's `dist/app.js`
    and the run reported success (item 442).

Neither is a widening. Both read the declaration the way the code that
deletes reads it, which is the only reading that decides the hazard.

Exported through the façade because `@vzn/vx-migrate` asks the same
question at MIGRATION time — it uncaches the losers so the generated
config loads — and it used to ask it with a copy of this function. The
copy did not get items 441 and 442, so it reported clean on configs
core then refused, including `outputs: ['dist']` against
`dist/app.js`, which is the commonest turbo.json shape there is (item
445). One rule, one place: the copy is gone.

```ts
export function outputsOverlap(rawA: string, rawB: string): boolean
```

## `OutputView`

type · `src/report/logger.ts`

The default logger's per-task output policy. Resolved once per run
from (in priority order) the explicit `--output-logs` override, a
truthy `CI` env, and the CLI-detected flow:

  full        — frames for executed work, one-liners for quiet hits.
                Today's CI behavior; also the programmatic default.
  errors-only — only failed tasks print.
  none        — no per-task output at all.
  hash-only   — one line per task: outcome word, task id, cache key.
                No frames, no log replay (Turbo `--output-logs
                hash-only` parity); the end-of-run summary still
                renders. The line is the run's audit trail: which key
                each task resolved to, without any build output.
  focused     — requested nodes stream raw output live (running the
                task should feel like running the command directly);
                dependency-pulled nodes are silent unless they fail.
  broad       — news only: one `success` line per executed task,
                full frames for failures, silence for cache hits.

`gha` (on GitHub Actions, any mode): task output is fenced from
workflow commands. In full mode each task's block is also wrapped in
`::group::` / `::endgroup::` so tasks collapse in the log viewer —
except failed tasks, which stay pre-expanded and emit an `::error`
annotation instead.

`ci`: a truthy CI env was detected. Suppresses the dynamic status
line even if stdout happens to be a TTY.

```ts
export interface OutputView {
  mode: 'full' | 'errors-only' | 'none' | 'focused' | 'broad' | 'hash-only'
  gha?: boolean
  ci?: boolean
}
```

## `packageManagerPath`

function · `src/exec/env.ts`

The executable of the workspace's package manager: the root
package.json's `packageManager`, else its lockfile, found on the root's
`node_modules/.bin` and PATH. Learned once per root; null when the root
names none or this machine has none.

```ts
export function packageManagerPath(root: string): string | null
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

Planning mode. Same setup as `run()` — workspace discovery, config
load, package graph, task graph — but stops short of execution.
Returns a `RunPlan` predicting the cache hit/miss outcome of every
task. Used by `--dry`.

Side-effects are limited to opening + closing the local Cache handle
(and running `inputs.runtime` probe commands, which key
derivation requires). Cache probing is the byte-free `cache.has()`
existence check — no artifact download, no ingest, no accessed_at bump.

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

Every hook a plugin may fill, in pipeline order — THE list. The loader's
"must be a function" and "at least one of" checks, the host's stage gate
and `vx info`'s seam column all read it, so a stage added here is a stage
everywhere: `admit` reached `vx info` a day late (2026-09-12) because
that column kept its own copy, and the loader kept a third. The type
pin below refuses a list that drifts from `Plugin`'s keys either way.

```ts
export const PLUGIN_HOOKS = [
  'config',
  'discover',
  'project',
  'graph',
  'key',
  'fingerprint',
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

Every option a factory takes, each with the one kind its type allows
(`'any'` for a union of kinds, such as `false | { … }`). Derived from
the options interface, so the type checker refuses a missing option, an
extra one or a wrong kind.

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
  empty: null | 'no-tasks-declared' | 'none-affected' | 'empty-graph'
}
```

## `prepareRun`

function · `src/orchestrator/prepare.ts`

Build the prepared-run context: workspace discovery, project-config
load, package + task graph, cache handle (local, optionally wrapped
in a remote layer). Caller owns `cache.close()`.

Returns even when nothing can run — the `empty` field tells the
caller why. We never throw on "no tasks"; behavior on that case is
caller-specific (run logs + returns NOT-ok; planRun returns an
empty plan).

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

Escape an arbitrary string into a single-quoted TS literal. Escapes
backslash + quote AND raw newlines/CR — a value with an embedded newline
(legal JSON, e.g. a script `"echo a\necho b"`, or a glob with a `'`) would
otherwise splice into a single-quoted literal as an unterminated / malformed
string that fails to load (generated files must round-trip through the
loader).

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
edges land on, and its child components' digests (sorted). O(nodes + edges): 1000 importers over 3000 packages digest in
~20 ms where one traversal per importer took 400.

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

## `refuseUnknownOptions`

function · `src/orchestrator/plugin.ts`

Refuse an option a plugin factory does not take, or a value of the wrong
kind, as core refuses an unknown config field. Bun strips a config's
types, so a misspelt option (`reapi({ endpont })`) reached the factory,
which read it as unset and quietly declined, and a string where a number
or a boolean belongs (`process.env.X`) was misread or threw a bare
TypeError. `factory` names the call in the message (`reapi()`).

```ts
export function refuseUnknownOptions<T>(
  factory: string,
  options: unknown,
  kinds: PluginOptionKinds<T>,
): void
```

## `RemoteCacheLayer`

type · `src/cache/layered-cache.ts`

What a remote cache layer must provide — THE plugin seam for remote
caching. Core ships no wire client; a plugin's `cache` hook returns one
(or an embedder passes one as `RunOptions.remoteCache`), speaking
whatever protocol it wants, and `LayeredCache` owns everything else:
policy gating, in-flight dedup, remote provenance, and the never-fail
contract (implementations THROW on failure; every throw degrades to a
cache miss, reported to the remote's `onError`). The artifact bytes are the
local `<hash>.tar.zst` verbatim. The wires live in plugin packages
(`@vzn/vx-migrate`'s `turboCache()` and `nxCache()`, `@vzn/vx-reapi`); see
docs/modules/layered-cache.md.

Core awaits every call and bounds none: a `get` that never settles
holds its task and a `put` the run's upload drain, so each request
carries the layer's own deadline (every first-party layer has one; the
plugin guide's example shows it).

```ts
export interface RemoteCacheLayer {
  readonly endpoint?: string
  open?(ctx: RemoteOpenContext): Promise<void>
  lend?(): Promise<LentAccess | undefined>
  has(hash: string): Promise<ArtifactInfo | null>
  hasMany?(hashes: readonly string[]): Promise<Map<string, ArtifactInfo> | null>
  get(hash: string): Promise<{ body: Blob | Response; durationMs: number | undefined } | null>
  put(hash: string, body: Blob, meta: { durationMs: number }): Promise<void | false>
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

type · `src/exec/sandbox-runtime.ts`

Sandbox config with all path fields resolved to absolute paths.
Produced by `resolveSandboxConfig`. The shape mirrors `SandboxConfig`
but every string in a path list is guaranteed absolute.

```ts
export interface ResolvedSandboxConfig {
  allowRead: readonly string[]
  allowWrite: readonly string[]
  pendingWrites?: readonly string[]
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

Whether a restore may write `rel`: one of the outputs `globs` declare,
never under `OUTPUT_NEVER`, and under `node_modules` only where a glob
names it — what the save side could have packed (`resolveOutputs`). An
artifact naming anything else was not written by this task's save, and
none of it is restored (2026-10-16).

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
  selectedByDiff?: boolean
  affected?: AffectedChanges
  selectedOutright?: readonly string[]
  affectedReasons?: Map<string, AffectedReason>
  staged?: ReadonlyMap<string, ProjectEntry>
  discovered?: { root: string; projects: ProjectMeta[] }
  concurrency?: number
  cacheDir?: string
  cache?: CachePolicy
  cacheFlags?: CacheFlags
  remoteRequested?: string
  cacheScope?: string
  remoteReadOnlyByDefault?: boolean
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
  holdPersistent?: boolean
  keep?: HeldPersistent
  summaryTable?: boolean
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

type · `src/cache/layer.ts`

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
}
```

## `RunReport`

type · `src/orchestrator/plugin.ts`

What a finished run hands each plugin's `teardown`: its facts and every
task, with the names core kept the task's bytes under. Core keeps them
only when a remote takes the run's writes (CI by default): the log of a
task that saved no entry, and a failed task's log and the files its
outputs left when `cache.upload.failures` covers the run. Read
them with `ctx.cache.getRun(name)`. Core keeps no manifest of its own; a
plugin that wants one writes it from here (`ctx.cache.put`).

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

A per-run SUMMARY record — the denormalized invocation header plus the
per-task outcome list, emitted once at run:end. An ingesting store can
persist a whole run in one write without replaying the stream. The
manual-API exporter + a service's ingest endpoint primarily speak this shape.

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
}
```

## `sampleTrees`

function · `src/exec/proc-sample.ts`

Each root's tree usage; a root no longer alive has no entry.

```ts
export async function sampleTrees(
  roots: readonly number[],
  skip?: ReadonlySet<string>,
): Promise<Map<number, TreeUsage>>
```

## `SandboxConfig`

type · `src/config.ts`

What a sandboxed task may do, declared as CAPABILITIES.

One shape for the whole policy. You say what the task is allowed to
touch; vx decides how each capability is realised — some become sandbox
runtime config, some become rules in the OS policy, and one the platform
cannot express is an error rather than a silent no-op. None of that
reaches the config.

The baseline (`sandbox: {}`) grants almost nothing: the task reads
nothing, writes nothing and reaches no network — NOT EVEN ITS OWN
PROJECT DIRECTORY, which is why `allow: { read: ['.'] }` opens almost
every real block. The one grant vx makes for you is dependencies:
`node_modules`, and through it the real path of every workspace
package linked there.

`cache` grants no access in either direction: `inputs` says what
INVALIDATES a task, `allow` says what it may TOUCH, and deriving one
from the other coupled them both ways — a declaration added for
caching silently widened the sandbox, and a path the task needed had
to be laundered through the cache key to get it (2026-09-05).
A declared `cache.outputs` is NOT a write grant; the request
`sandbox-request.ts` builds carries no write of its own and binds
`allow.write` alone. This comment claimed the opposite — here and on
both grant fields — while the file beside it and `schema.md` both said
the truth, and no test read the bare baseline it described (item 443).
That case has a test of its own now.

Enforcement anchors at the WORKSPACE ROOT, so a task cannot leave its
project whatever it declares here. The full account, including what a
write grant costs on Linux, is in `docs/schema.md` under
`exec.sandbox`.

Paths are project-relative, absolute, or `~`-expanded, and may be
globs: macOS matches the pattern in the policy, Linux expands it when
the task starts (a mount cannot hold a pattern), so a file created
later is not covered there — grant its directory.

```ts
export interface SandboxConfig {
  allow?: SandboxGrants
  deny?: SandboxDenials
  ignore?: SandboxIgnore
  weakerWhenNested?: boolean
  weakerNetworkIsolation?: boolean
}
```

## `SandboxDenials`

type · `src/config.ts`

```ts
export interface SandboxDenials {
  network?: readonly string[]
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

## `SandboxRequest`

type · `src/orchestrator/sandbox-request.ts`

The sandbox half of the request, plus the empty files vx created so a
literal write grant had something to bind (`placeholders`). They are
vx's, not the task's, until the task writes them: `sweepPlaceholders`
takes back the ones it never touched. `withheld` names the linked
dependencies a cached task was denied, for the hint a denial under one
earns (`withheldLinkLine`).

```ts
export interface SandboxRequest {
  sandbox: NonNullable<ExecuteRequest['sandbox']>
  placeholders: Placeholder[]
  withheld: WithheldLink[]
}
```

## `sandboxRequestFor`

function · `src/orchestrator/sandbox-request.ts`

The sandbox half of an `ExecuteRequest` for one task, shared by the
cached path (through the executor) and the persistent path (spawned here).

The user's grants derive NOTHING from `cache` (2026-09-05). Those
are two different questions: `inputs` says what INVALIDATES the
task, `sandbox.allow` says what it may TOUCH. Deriving one from the other
coupled them in both directions — a declaration added for caching
silently widened the sandbox, and a path the task needed had to be
laundered through the cache key to get it. A sandboxed task declares
its own reads and writes.

`node_modules` is the one grant core still makes: it is where the task's
own PATH gets its `.bin` entries, and denying it made the sandbox
unusable for anything that imports a dependency (`bun build --compile`
died with only `error: An unknown error occurred (Unexpected)`; owner
call 2026-09-04). Declaring `cache` may NARROW that grant, never widen
anyone's (2026-09-24): `keyed` is the set of project directories the
task's key answers for (keyed-projects.ts), and `undefined` for a task
with no `cache`, which has no key to be stale.

```ts
export async function sandboxRequestFor(
  node: Pick<TaskNode, 'projectDir'>,
  sandbox: NonNullable<ExecConfig['sandbox']>,
  workspaceRoot: string,
  keyed: ReadonlySet<string> | undefined,
  nested: readonly string[] = [],
  cacheDir?: string,
): Promise<SandboxRequest>
```

## `ScheduleHookContext`

type · `src/orchestrator/plugin.ts`

```ts
export interface ScheduleHookContext extends BaseContext {
  readonly localCache: Cache
  readonly branch: string | null
  readonly refs: readonly string[]
  readonly cache: PluginCache
  refine(
    weights: ReadonlyMap<string, number> | Promise<ReadonlyMap<string, number> | undefined>,
  ): void
  refining(): Promise<void>
  onRefine(listener: () => void): void
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
the graph uses. The cache's run history read the same rule from a
private copy until item 646; one rule, one place.

```ts
export function splitTaskId(id: string): [project: string, task: string]
```

## `sweepPlaceholders`

function · `src/orchestrator/sandbox-request.ts`

Remove the placeholder files the task never wrote — still empty, mtime
untouched — and return their paths. What the task wrote is its output
and stays; what it did not is vx's own litter, and litter under a
declared output would be archived as the task's (an empty `dist/vx`
saved as a build) or, as a file where the task wanted a directory,
would fail every later run the same way.

```ts
export async function sweepPlaceholders(placeholders: readonly Placeholder[]): Promise<string[]>
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
  cache?: CacheConfig
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
  readonly remote?: boolean
  readonly sandbox?: boolean
  readonly servers?: boolean
  readonly runtime?: boolean
  readonly exclusive?: boolean
  readonly timeouts?: boolean
  readonly platforms?: readonly string[]
  readonly capacity?: number
  accepts?(task: TaskPlacement): boolean
  demand?(remaining: ReadonlySet<string>, missed: ReadonlySet<string>): void
  footer?(): readonly (readonly [label: string, text: ui.Inline])[]
  machines?(): readonly MachineReport[]
  idealMs?(): number | undefined
  profile?(): readonly Record<string, unknown>[]
  running?(taskId: string): string | null | undefined
  execute(req: ExecuteRequest): Promise<ExecuteResult>
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

Why `name` cannot be a task name, or null; `vx init` skips such a script (item 1033).

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
  addsToOutputsOf?: string[]
  outputsAddedToBy?: string[]
  excludedUpstream?: TaskOutcome[]
}
```

## `TaskOutcome`

type · `src/graph/scheduler.ts`

```ts
export interface TaskOutcome {
  node: TaskNode
  status: TaskStatus
  exitCode: number
  durationMs: number
  hash?: string
  storedDurationMs?: number
  storedCpuMs?: number
  storedPeakRssBytes?: number
  admissionHeldMs?: number
  queuedMs?: number
  inputFiles?: number
  artifactBytes?: number
  fetchMs?: number
  saveMs?: number
  inputChanges?: InputChanges
  cpuMs?: number
  peakRssBytes?: number
  peakCores?: number
  avgRssBytes?: number
  groupUpstream?: readonly TaskOutcome[]
  unkeyed?: true
  keylessBy?: string
  cacheOff?: true
  blockedBy?: string
  otherPlatform?: { readonly needs: readonly string[]; readonly host: string }
  timedOut?: true
  failedOutput?: string
  runLog?: string
  notReady?: 'timeout' | 'exited' | 'spawn'
  serverExit?: number
  inputMoved?: string
  where?: string
  carried?: true
  whereCores?: number
  whereMemoryBytes?: number
  cpuShare?: number
  outputs?: 'deferred'
  saved?: true
  wallclockStartNs?: bigint
  wallclockEndNs?: bigint
  restored?: boolean
  attempts?: number
  failedAttempts?: readonly { endedAt: number; exitCode: number; timedOut?: true }[]
  flaky?: { passes: number; failures: number }
  sandboxViolations?: number
  sandboxViolationLines?: string[]
  sandboxFix?: {
    read?: string[]
    write?: string[]
    network?: string[]
    systemInfo?: string[]
    withheld?: string[]
    inputs?: string[]
  }
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

A streaming telemetry record — one per lifecycle event. A superset of the
rendering-oriented `WireEvent`: it carries the run context + the per-task
analytics fields a consumer needs WITHOUT re-deriving from the stream.
`task.log` records are large and OPT-IN (see `TelemetrySink.wants`).

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

A telemetry consumer. Observe-only: receives records, holds no run handle.

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

namespace · `src/util/ui.ts`

```ts
export type Tone = 'ok' | 'warn' | 'error' | 'info'
export type Inline = string | { readonly style: Style; readonly text: string } | readonly Inline[]
export interface Block {
  readonly lines: (colors: ColorSupport) => string[]
}
export const id = (text: string): Inline => ({ style: 'id', text })
export const path = (text: string): Inline => ({ style: 'bold', text })
export const cmd = (text: string): Inline => ({ style: 'bold', text })
export const dim = (text: string): Inline => ({ style: 'dim', text })
export const place = (text: string): Inline => (text === 'local' ? text : id(text))
export const tone = (t: Tone, text: string): Inline => ({ style: t, text })
export function inline(x: Inline, c: ColorSupport): string
export function status(t: Tone, verb: string, headline: Inline): Block
export function tagged(t: Tone, line: string, c: ColorSupport): string
export function say(t: Tone, line: string, stream: 'out' | 'err' = 'err'): void
export function excerpt(title: string, body: string): Block
export function text(...items: Inline[]): Block
export function why(line: Inline): Block
export type FieldRow = readonly [label: string, ...values: Inline[]] | null
export function fields(rows: readonly FieldRow[]): Block
export function fix(action: Inline): Block
export function next(command: Inline): Block
export function report(mark: string, rows: readonly FieldRow[]): Block
export function table(columns: readonly string[], rows: readonly (readonly Inline[])[]): Block
export function code(frame: string): Block
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
export function notice(p: NoticeParts): Block
export function render(blocks: readonly Block[], colors: ColorSupport): string
export function print(stream: 'out' | 'err', ...blocks: Block[]): void
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

A vx plugin. Contributes any subset of the run-level capabilities —
where work runs (executor), which cache is used (cache), who
observes the run (telemetry). It never changes WHAT a task is (the
command string — principle #3), only where and how that command is
executed. Registered explicitly in .vx/workspace.ts via
defineWorkspace({ plugins: [...] }). No auto-discovery.

Made by `definePlugin(import.meta, hooks)` only: the loader refuses a
plain object. The capabilities are consulted by `plugin-host.ts`. Core
names no plugin; the local executor and the local cache are the floor
under the list, taking what every plugin declines.

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

The command a task runs with the args after `--` appended, shell-quoted.
They go before a trailing comment: appended after it, `echo args: # show`
ran without them and said nothing (item 1060). Trailing blanks go first.

```ts
export function withForwardArgs(command: string, args: readonly string[] | undefined): string
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
