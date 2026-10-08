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

What `--affected` seeds its tasks from (owner, 2026-10-04): the changed
projects, each one's changed paths relative to it, and the projects a
change reaches as a whole — every task in one is affected whatever its
inputs say, because the reason was no path of its own (a lockfile claim,
a manifest edge at the base, a config import, a nested repository, a
workspace-wide file).

```ts
export interface AffectedChanges {
  projects: Set<string>
  changed: readonly string[]
  paths: ReadonlyMap<string, readonly string[]>
  whole: ReadonlySet<string>
}
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
  metas: readonly ProjectMeta[]
  plan: MigrationPlan
  source: string
  verb: string
  dry: boolean
  force: boolean
  init?: boolean
  notes?: readonly string[]
  unmapped?: boolean
  format?: MigrationFormat
}
```

## `buildPackageGraph`

function · `src/workspace/package-graph.ts`

`taskEdges`: project → the projects its tasks name in a cross-project
`dependsOn` (`e2e` → `app` from `dependsOn: ['app#build']`). A dependent
the manifest does not know but the task graph does; without it
`--filter '...app'` never selected `e2e`, and a CI that runs "what
changed and everything depending on it" silently left it out
(2026-09-10). The `^task` walk still reads `directDeps`, which carries
both — a task edge IS a dependency.

```ts
export function buildPackageGraph(
  projects: ProjectMeta[],
  taskEdges?: ReadonlyMap<string, readonly string[]>,
): PackageGraph
```

## `Cache`

class · `src/cache/cache.ts`

```ts
export class Cache implements CacheLayer {
  readonly hasRemote
  readonly uploads: UploadTally
  readonly storeDir: string | undefined
  readonly storeFallback: string | null
  readonly storeMoved: { from: string; to: string } | null
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
  )
  getConfigEval(key: string): string | null
  getConfigClosures(configPaths: readonly string[]): Map<string, string[]>
  putConfigClosure(configPath: string, files: readonly string[]): void
  getConfigEvals(keys: readonly string[]): Map<string, string>
  putConfigEval(key: string, json: string): void
  putConfigEvals(entries: ReadonlyArray<readonly [string, string]>): void
  putConfigClosures(entries: ReadonlyArray<readonly [string, readonly string[]]>): void
  hashFile(filePath: string): Promise<string>
  hashBytes(bytes: Uint8Array, nearPath: string): string
  hashFiles(paths: readonly string[]): Promise<Map<string, string>>
  knownBlobSizes(oids: readonly string[]): Map<string, number>
  rememberBlobSizes(sizes: ReadonlyMap<string, number>): void
  blobVerdict(digest: string): string[] | undefined
  rememberBlobVerdict(digest: string, paths: readonly string[]): void
  key(input: CacheKeyInput): Promise<string>
  async get(hash: string, ctx?: CacheGetContext): Promise<CacheEntry | null>
  getIngested(hash: string): Promise<CacheEntry | null>
  async getMany(
    hashes: readonly string[],
    ctx?: (hash: string) => CacheGetContext,
  ): Promise<Map<string, CacheEntry>>
  async has(hash: string): Promise<'local' | 'remote' | null>
  async prefetch(_hash: string, _ctx?: CacheGetContext): Promise<boolean>
  loadOutputFilesBatch(hashes: readonly string[]): Map<string, OutputFileRow[]>
  isOutputsCurrent(projectDir: string, expected: readonly OutputFileRow[]): Promise<boolean>
  outputsPath(hash: string): string
  async recordOutputDirs(
    hash: string,
    projectDir: string,
    prefixes: readonly string[],
    holds?: (files: readonly string[]) => boolean,
  ): Promise<void>
  recordOutputStamps(hash: string, projectDir: string, workspaceRoot: string): void
  loadOutputDirsBatch(hashes: readonly string[]): Map<string, OutputDirRow[]>
  outputDirsCurrent(projectDir: string, rows: readonly OutputDirRow[]): Promise<boolean>
  async restoreOutputs(hash: string, projectDir: string, workspaceRoot?: string): Promise<void>
  assertWritable(): void
  async save(args: {
    hash: string
    entry: Omit<CacheEntry, 'hash' | 'storedAt' | 'outputFiles' | 'exitCode'>
    projectDir: string
    outputFiles: string[]
    skipLocalWrite?: boolean
    workspaceOutputFiles?: string[]
    workspaceRoot?: string
    inputComponents?: readonly TaskInputRow[]
  }): Promise<void>
  get localWritesEnabled(): boolean
  packArtifactBytes(args: SaveArgs): Promise<Uint8Array>
  async ingest(hash: string, body: Blob | Response, meta: IngestMeta): Promise<void>
  dbHandle(): Database
  recordRun(run: RunRecord): void
  recordRuns(runs: readonly RunRecord[]): void
  recordRunBundle(bundle: { runs: readonly RunRecord[]; invocation: InvocationRecord }): void
  stats(opts: CacheStatsOptions = {}): CacheStats
  async evictIfDue(
    policy: { maxAgeMs?: number; maxBytes?: number },
    now: number = Date.now(),
  ): Promise<PruneResult | null>
  async prune(options: PruneOptions): Promise<PruneResult>
  async orphanStats(): Promise<{ orphans: number; orphanBytes: number }>
  close(): void
}
```

## `CacheConfig`

type · `src/config.ts`

```ts
export interface CacheConfig {
  inputs: CacheInputs
  outputs: CacheOutputs
}
```

## `CacheContext`

type · `src/orchestrator/plugin.ts`

```ts
export interface CacheContext extends BaseContext {
  readonly localCache: Cache
  readonly policy: CachePolicy
}
```

## `CacheInputs`

type · `src/config.ts`

```ts
export interface CacheInputs {
  files: readonly string[]
  workspaceFiles?: readonly string[]
  env?: readonly string[]
  tasks?: readonly string[]
  runtime?: readonly string[]
  workspaceRuntime?: readonly string[]
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
  remoteHasMany?(hashes: readonly string[]): Promise<Set<string> | null>
  markRemoteAbsent?(hashes: Iterable<string>): void
  drainUploads?(): Promise<void>
  key(input: CacheKeyInput): Promise<string>
  get(hash: string, ctx?: CacheGetContext): Promise<CacheEntry | null>
  getMany?(
    hashes: readonly string[],
    ctx?: (hash: string) => CacheGetContext,
  ): Promise<Map<string, CacheEntry>>
  has(hash: string): Promise<'local' | 'remote' | null>
  prefetch(hash: string, ctx?: CacheGetContext): Promise<boolean>
  loadOutputFilesBatch(hashes: readonly string[]): Map<string, OutputFileRow[]>
  isOutputsCurrent(projectDir: string, expected: readonly OutputFileRow[]): Promise<boolean>
  recordOutputDirs?(
    hash: string,
    projectDir: string,
    prefixes: readonly string[],
    holds?: (files: readonly string[]) => boolean,
  ): Promise<void>
  recordOutputStamps?(hash: string, projectDir: string, workspaceRoot: string): void
  loadOutputDirsBatch?(hashes: readonly string[]): Map<string, OutputDirRow[]>
  outputDirsCurrent?(projectDir: string, rows: readonly OutputDirRow[]): Promise<boolean>
  restoreOutputs(hash: string, projectDir: string, workspaceRoot?: string): Promise<void>
  save(args: {
    hash: string
    entry: Omit<CacheEntry, 'hash' | 'storedAt' | 'outputFiles' | 'exitCode'>
    projectDir: string
    outputFiles: string[]
    skipLocalWrite?: boolean
    workspaceOutputFiles?: string[]
    workspaceRoot?: string
    inputComponents?: readonly TaskInputRow[]
  }): Promise<void>
  ingest(hash: string, body: Blob | Response, meta: IngestMeta): Promise<void>
  recordRunBundle(bundle: { runs: readonly RunRecord[]; invocation: InvocationRecord }): void
  stats(opts?: CacheStatsOptions): CacheStats
  hashFile(filePath: string): Promise<string>
  outputsPath(hash: string): string
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
}
```

## `CachePolicy`

type · `src/cache/policy.ts`

Independent read/write control over the two cache layers (local +
remote). Replaces the old single `noCache` boolean: each axis can be
toggled on its own so `--force` (re-execute but still refresh the
cache) is distinct from `--no-cache` (disable everything).

The task-artifact get/save path is gated, and the local axes also gate
the local store's config-evaluation reads and writes and its file-hash
writes (`cache.ts`). `recordRun`, `stats`, `prune`, key derivation, and
prefetch-ingest are never affected — they are bookkeeping/analytics
that a run policy has no business disabling.

```ts
export interface CachePolicy {
  localRead: boolean
  localWrite: boolean
  remoteRead: boolean
  remoteWrite: boolean
  remoteScope?: string
}
```

## `CacheSource`

type · `src/orchestrator/telemetry.ts`

Where a task's result came from, derived ONCE in core from the status.

```ts
export type CacheSource = 'miss' | 'local' | 'remote' | 'none'
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

## `clampInt`

function · `src/util/num.ts`

Clamp to an INTEGER in `[min, max]`; a non-finite value collapses to `min`.

The floor is load-bearing wherever the result reaches SQL: a fractional
`LIMIT` is a `datatype mismatch` error, not a smaller page.

```ts
export function clampInt(n: number, min: number, max: number): number
```

## `collectInfo`

function · `src/orchestrator/doctor.ts`

```ts
export async function collectInfo(cwd: string, opts: CollectInfoOptions = {}): Promise<InfoFacts>
```

## `CollectInfoOptions`

type · `src/orchestrator/doctor.ts`

```ts
export interface CollectInfoOptions {
  readonly cacheDir?: string
  readonly warn?: (message: string) => void
}
```

## `CommandContext`

type · `src/orchestrator/plugin.ts`

```ts
export interface CommandContext extends BaseContext {
  readonly concurrency: number
}
```

## `definePlugin`

function · `src/orchestrator/plugin.ts`

The one way to make a plugin: `definePlugin(import.meta, { ...hooks })`.
The name is read from the package the calling module belongs to — the
nearest `package.json` above it — and stamped where the workspace loader
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
    Known<T, ProjectConfig> & {
      tasks?: {
        [K in keyof NonNullable<T['tasks']>]?: Known<NonNullable<T['tasks']>[K], TaskConfig> & {
          dependsOn?: readonly DependsOnEntry<Extract<keyof NonNullable<T['tasks']>, string>>[]
          exec?: Known<At<NonNullable<T['tasks']>[K], 'exec'>, ExecConfig>
          cache?: Known<At<NonNullable<T['tasks']>[K], 'cache'>, CacheConfig> & {
            inputs?: Known<At<At<NonNullable<T['tasks']>[K], 'cache'>, 'inputs'>, CacheInputs>
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
      cacheRetention?: Known<
        At<T, 'cacheRetention'>,
        NonNullable<WorkspaceConfig['cacheRetention']>
      >
      rules?: Known<At<T, 'rules'>, WorkspaceRules>
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

## `escapeMarkdownCell`

function · `src/orchestrator/run-report.ts`

Make a value safe inside a GFM table cell. Task names are arbitrary TS
object keys and the loader accepts `|` and newlines, either of which
silently breaks the table on the consumer (`>> $GITHUB_STEP_SUMMARY`):
a bare pipe adds a column, a newline splits the row.

Exported because this file is not the only markdown table describing a run:
the cloud plugin's GitHub job summary renders the same data from the same
unvalidated names and shipped WITHOUT this escape, so a `|` in a task name
or an output path shifted its columns. One definition, so the two
cannot disagree about what a cell may contain.

A pipe splits the row unless an ODD run of backslashes precedes it (GFM
reads `\\` as one escaped backslash), so a pipe after an odd run is already
escaped and one more backslash would free it: `a\|b` became `a\\|b`, two
cells. A lone `\r` ends a line too.

```ts
export function escapeMarkdownCell(value: string): string
```

## `ExecConfig`

type · `src/config.ts`

```ts
export interface ExecConfig {
  command: string
  remote?: boolean | 'only'
  env?: ExecEnv
  timeout?: number
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
  readonly refresh?: boolean
  readonly remoteOnly?: boolean
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
}
```

## `ExecuteResult`

type · `src/exec/executor.ts`

```ts
export interface ExecuteResult extends RunResult {
  readonly violations: readonly SandboxViolation[]
  readonly outputs?: { kind: 'disk' } | { kind: 'deferred'; materialize: () => Promise<void> }
  readonly where?: string
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
}
```

## `ExecutorContext`

type · `src/orchestrator/plugin.ts`

```ts
export interface ExecutorContext extends BaseContext {
  readonly concurrency: number
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

Walk up from `start` to find the workspace root. A directory is a root
CANDIDATE when it contains `pnpm-workspace.yaml` or a `package.json`.

The nearest candidate that CLAIMS `start` wins — one of the directories
between it and `start` matches one of its package globs. Every workspace
member has its own `package.json`, so stopping at the first candidate would
make a run from inside a package treat that package as the whole workspace:
`^task` edges vanish, upstream hashes drop out of the cache key (stale
hits), and a second cache dir appears under the member. Claiming is decided
with the same globs `loadWorkspace` applies, so "the root that claims me"
and "the root that lists me as a project" cannot diverge. An outer root
that lists both the claimer and the claimed member outranks the claimer:
from the claimer's own directory the walk reaches the outer root too.

When no candidate claims `start` — a standalone package, or a subdirectory
of a single-project repo — the nearest candidate wins (the root itself IS
the project). Throws a `UserError` when there is no candidate before `/`.
A load that goes on to `loadWorkspace` passes its `reads`, so the
root's manifest is read once for both.

```ts
export async function findWorkspaceRoot(
  start: string,
  reads: LoadReads = new Map(),
): Promise<string>
```

## `FingerprintChange`

type · `src/orchestrator/plugin.ts`

```ts
export interface FingerprintChange {
  readonly file: string
  readonly before: Uint8Array | null
  readonly after: Uint8Array | null
}
```

## `FingerprintClaim`

type · `src/orchestrator/plugin.ts`

A plugin's claim on workspace fingerprint files — see `VxPlugin.fingerprint`.

```ts
export interface FingerprintClaim {
  readonly files: readonly string[]
  affected(
    change: FingerprintChange,
    ctx: FingerprintContext,
  ): Iterable<string> | undefined | Promise<Iterable<string> | undefined>
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

type · `src/orchestrator/history.ts`

```ts
export interface HistoryProvider {
  loadFor(taskIds: readonly string[]): Promise<HistoryTable>
  p50sFor?(taskIds: readonly string[]): Promise<ReadonlyMap<string, number>>
}
```

## `HistoryTable`

type · `src/orchestrator/history.ts`

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

## `InfoFacts`

type · `src/orchestrator/doctor.ts`

The doctor's facts, typed: what `--format json` prints and the pretty rows render.

```ts
export interface InfoFacts {
  vx: string
  bun: string
  bunSupported: boolean
  git: string | null
  gitStatusCache: { fsmonitor: boolean; untrackedCache: boolean } | null
  workspaceRoot: string
  projects: number
  tasks: number
  configErrors: Array<{ path: string; message: string }>
  plugins: Array<{ name: string; seams: string[] }>
  workers: {
    count: number
    source: 'workspace' | 'cgroup' | 'cores'
    cores: number
    cpuQuota: number | null
  }
  memory: { usableBytes: number; totalBytes: number; cgroupLimitBytes: number | null }
  cacheDir: string
  cacheStore: string | null
  cacheVersion: string
  schemaVersion: string
  cacheEntries: number
  cacheBytes: number
  orphans: { artifacts: number; bytes: number }
  runs24h: number
  hits24h: number
  restored24h: number
  flakyTasks: FlakyTask[]
  lockfile: boolean
  sandbox: { available: boolean; reason: string; declared: number; untraced: string | null }
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
  tags: string
}
```

## `isCacheHit`

function · `src/orchestrator/telemetry.ts`

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

function · `src/orchestrator/telemetry.ts`

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

## `latestRunId`

function · `src/orchestrator/metrics.ts`

The latest recorded run of a task (run_id may be NULL on very old rows).
One query for `vx why` and `vx mcp`: the CLI defaulted to it while the
tool demanded a run id an agent had to fetch first (2026-09-16).

```ts
export function latestRunId(db: Database, taskId: string): string | null
```

## `LayeredCache`

class · `src/cache/layered-cache.ts`

```ts
export class LayeredCache implements CacheLayer {
  readonly hasRemote
  constructor(
    readonly local: Cache,
    private readonly remote: RemoteCacheLayer,
    private readonly options: LayeredCacheOptions = {},
  )
  key(input: CacheKeyInput): Promise<string>
  async prefetch(hash: string, ctx?: CacheGetContext): Promise<boolean>
  async remoteHasMany(hashes: readonly string[]): Promise<Set<string> | null>
  markRemoteAbsent(hashes: Iterable<string>): void
  async get(hash: string, ctx?: CacheGetContext): Promise<CacheEntry | null>
  async has(hash: string): Promise<'local' | 'remote' | null>
  outputsPath(hash: string): string
  hashFile(filePath: string): Promise<string>
  async restoreOutputs(hash: string, projectDir: string, workspaceRoot?: string): Promise<void>
  async save(args: SaveArgs): Promise<void>
  async drainUploads(): Promise<void>
  async ingest(hash: string, body: Blob | Response, meta: IngestMeta): Promise<void>
  loadOutputFilesBatch(hashes: readonly string[]): Map<string, OutputFileRow[]>
  async isOutputsCurrent(projectDir: string, expected: readonly OutputFileRow[]): Promise<boolean>
  recordOutputDirs(
    hash: string,
    projectDir: string,
    prefixes: readonly string[],
    holds?: (files: readonly string[]) => boolean,
  ): Promise<void>
  recordOutputStamps(hash: string, projectDir: string, workspaceRoot: string): void
  loadOutputDirsBatch(hashes: readonly string[]): Map<string, OutputDirRow[]>
  outputDirsCurrent(projectDir: string, rows: readonly OutputDirRow[]): Promise<boolean>
  recordRunBundle(bundle: { runs: readonly RunRecord[]; invocation: InvocationRecord }): void
  stats(opts?: CacheStatsOptions): CacheStats
  prune(options: PruneOptions): Promise<PruneResult>
  close(): void
}
```

## `listProjectMetas`

function · `src/workspace/workspace.ts`

```ts
export async function listProjects(workspace: Workspace): Promise<ProjectMeta[]>
```

## `loadProjectConfig`

function · `src/workspace/project-loader.ts`

```ts
export async function loadProjectConfig(
  configPath: string,
  opts?: LoadProjectConfigOptions,
): Promise<ProjectConfig>
```

## `loadResolvedProjects`

function · `src/orchestrator/projects.ts`

The run path's view of a workspace's projects for a reader — `vx show`,
the MCP server, an embedder: discovery, the plugin `config` and
`project` stages, and the local cache opened only to serve cached
evaluations, so a pure config costs a stat, not an evaluation. `scope`
is every project or a list of names; no closure, no lock (a reader
reads live, as a default run does). Plugin warnings go to `warn`.

```ts
export async function loadResolvedProjects(
  workspaceRoot: string,
  opts: { scope?: 'all' | readonly string[]; warn?: (message: string) => void } = {},
): Promise<Map<string, ProjectEntry>>
```

## `loadWorkspace`

function · `src/workspace/workspace.ts`

Read the workspace's package-glob list, supporting all common
package managers:
  - `pnpm-workspace.yaml` (pnpm)
  - `package.json` `workspaces` array (npm / yarn / bun)
  - `package.json` `workspaces.packages` array (yarn legacy)

If a `package.json` exists with no `workspaces` field, the root
itself is treated as a single-project workspace.

```ts
export async function loadWorkspace(root: string, reads?: LoadReads): Promise<Workspace>
```

## `LocalHistoryProvider`

class · `src/orchestrator/history.ts`

Reads from the orchestrator's local SQLite cache.db.

```ts
export class LocalHistoryProvider implements HistoryProvider {
  constructor(
    private readonly db: Database,
    private readonly recent: number = DEFAULT_RECENT,
  ) {}
  async loadFor(taskIds: readonly string[]): Promise<HistoryTable>
  async p50sFor(taskIds: readonly string[]): Promise<ReadonlyMap<string, number>>
}
```

## `lockfileClaim`

function · `src/orchestrator/lockfile-claim.ts`

```ts
export function lockfileClaim(options: LockfileClaimOptions): LockfileClaimHooks
```

## `LockfileClaimHooks`

type · `src/orchestrator/lockfile-claim.ts`

The two hooks a lockfile plugin spreads into `definePlugin`.

```ts
export interface LockfileClaimHooks {
  readonly fingerprint: FingerprintClaim
  key(task: TaskNode, ctx: KeyHookContext): Promise<Readonly<Record<string, string>> | undefined>
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

type · `src/orchestrator/logger.ts`

```ts
export interface Logger {
  status(line: string): void
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

## `maskedCommand`

function · `src/util/secret-mask.ts`

A task's command as vx shows it: its secret values masked.

```ts
export function maskedCommand(command: string, env?: TaskEnvSecrets): string
```

## `maskedLine`

function · `src/util/secret-mask.ts`

A line vx prints for no one task (a plugin's warning): this process's secrets masked.

```ts
export function maskedLine(line: string): string
```

## `MigrationFormat`

type · `src/workspace/migration.ts`

```ts
export type MigrationFormat = 'ts' | 'mjs'
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

## `NamedProject`

type · `src/orchestrator/plugin.ts`

```ts
export interface NamedProject {
  readonly dir: string
  readonly name: string
}
```

## `normalizeGlob`

function · `src/util/paths.ts`

The spellings a reader, Turbo and `.gitignore` all accept but a matcher
fed the raw string turns into NOTHING — and a task keyed on nothing
replays old outputs as a green hit (2026-09-10, probed one by one):
a leading `./`, an inner `/./` segment, a doubled `//`, and a trailing
`/` on a pattern (`src/*\/` means the trees under `src`, so it becomes
`src/*\/**`; a trailing slash on a LITERAL is `asTrees`' job). Applied
after an optional `!`; a bare `.` is the empty entry the schema refuses.

```ts
export function normalizeGlob(glob: string): string
```

## `OutcomeView`

type · `src/orchestrator/events.ts`

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
  blockedBy?: string
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

type · `src/orchestrator/logger.ts`

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
}
```

## `planRun`

function · `src/orchestrator/run.ts`

Planning mode. Same setup as `run()` — workspace discovery, config
load, package graph, task graph — but stops short of execution.
Returns a `RunPlan` predicting the cache hit/miss outcome of every
task. Used by `--dry-run` and `--graph`.

Side-effects are limited to opening + closing the local Cache handle
(and running `cache.inputs.runtime` probe commands, which key
derivation requires). Cache probing is the byte-free `cache.has()`
existence check — no artifact download, no ingest, no accessed_at bump.

```ts
export async function planRun(options: RunOptions): Promise<RunPlan>
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
  'setup',
  'commands',
  'teardown',
] as const
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

## `PluginSetupContext`

type · `src/orchestrator/plugin.ts`

What `setup` receives: the run's lifecycle, observe-only.

```ts
export interface PluginSetupContext extends BaseContext {
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
  priorities: ReadonlyMap<string, number>
  nodes: Map<string, TaskNode>
  keyOnly: ReadonlyMap<string, TaskNode>
  unresolvedTasks: readonly string[]
  declaredElsewhere: readonly string[]
  projects: ReadonlyMap<string, ProjectEntry>
  hintProjects: ReadonlyMap<string, ProjectEntry>
  anyProjectConfig: boolean
  workspaceFingerprint: string
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

## `ProjectConfig`

type · `src/config.ts`

```ts
export interface ProjectConfig {
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
  readonly packageJson: Readonly<Record<string, unknown>>
  readonly projects: readonly ProjectMeta[]
}
```

## `ProjectMeta`

type · `src/workspace/workspace.ts`

```ts
export interface ProjectMeta {
  name: string
  dir: string
  packageJson: PackageJson
  configPath: string | null
  catalogs?: Catalogs
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
caching. Core ships no wire client; a plugin's `cache` capability (or an
embedder via `RunOptions.remoteCache`) supplies an implementation speaking
whatever protocol it wants, and `LayeredCache` owns everything else:
policy gating, in-flight dedup, remote provenance, and the never-fail
contract (implementations THROW on failure; LayeredCache degrades every
throw to a cache miss via `onRemoteError`). The artifact bytes are the
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
  has(hash: string): Promise<boolean>
  hasMany?(hashes: readonly string[]): Promise<Set<string> | null>
  get(hash: string): Promise<{ body: Blob | Response; durationMs: number | undefined } | null>
  put(hash: string, body: Blob, meta: { durationMs: number }): Promise<void>
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

## `resolveRunId`

function · `src/orchestrator/run-id.ts`

The recorded run `raw` names: itself when recorded, else the one run
whose id starts with it. Null when none does; a prefix several runs share
is refused with those runs, since picking one would replay the wrong run.

```ts
export function resolveRunId(db: Database, raw: string, verb: string): string | null
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
  tags: Readonly<Record<string, string>>
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
  staged?: ReadonlyMap<string, ProjectEntry>
  discovered?: { root: string; projects: ProjectMeta[] }
  concurrency?: number
  cacheDir?: string
  cache?: CachePolicy
  remoteRequested?: boolean
  defaultCacheScope?: string
  frozen?: boolean
  outputLogs?: 'full' | 'errors-only' | 'none' | 'hash-only'
  download?: 'all' | 'toplevel' | 'none'
  flow?: 'focused' | 'broad'
  retries?: number
  timeout?: number
  continueMode?: ContinueMode
  excludeDependencies?: 'all' | readonly string[]
  forwardArgs?: readonly string[]
  summarize?: string
  beforeFooter?: (outcomes: readonly TaskOutcome[], ok: boolean) => string
  profile?: string
  handleSignals?: boolean
  signal?: AbortSignal
  holdPersistent?: boolean
  summaryTable?: boolean
  tty?: boolean
  log?: Logger
  bus?: EventBus
  inflight?: Map<string, Promise<void>>
  tags?: Record<string, string>
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
}
```

## `RunResult`

type · `src/orchestrator/run-report.ts`

One finished run, reduced to what a report needs. Used to live in
`protocol.ts` as the return type of the whole-run `backend` seam; that
seam is gone (a run always executes in-process — see
`docs/modules/executor.md`), so the shape lives with its only consumer.

```ts
export interface RunResult {
  ok: boolean
  outcomes: OutcomeView[]
}
```

## `RunStartInfo`

type · `src/orchestrator/events.ts`

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
}
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

`cache` grants no access in either direction: `cache.inputs` says what
INVALIDATES a task, `allow` says what it may TOUCH, and deriving one
from the other coupled them both ways — a declaration added for
caching silently widened the sandbox, and a path the task needed had
to be laundered through the cache key to get it (owner, 2026-09-05).
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

## `ScheduleHookContext`

type · `src/orchestrator/plugin.ts`

```ts
export interface ScheduleHookContext extends BaseContext {
  readonly localCache: Cache
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

## `TaskConfig`

type · `src/config.ts`

```ts
export interface TaskConfig {
  description?: string
  exec?: ExecConfig
  dependsOn?: readonly string[]
  cache?: CacheConfig
}
```

## `TaskExecutor`

type · `src/exec/executor.ts`

```ts
export interface TaskExecutor {
  readonly name: string
  readonly remote?: boolean
  readonly capacity?: number
  accepts?(task: TaskPlacement): boolean
  demand?(remaining: ReadonlySet<string>): void
  execute(req: ExecuteRequest): Promise<ExecuteResult>
}
```

## `TaskHistory`

type · `src/orchestrator/history.ts`

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
}
```

## `TaskLogBuffer`

class · `src/orchestrator/task-log-buffer.ts`

Bounded per-run capture. `append` keeps a chunk LIST + running char count per
task, evicting whole chunks from the head past `TASK_LOG_TAIL_CHARS` — no
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
  groupUpstream?: readonly TaskOutcome[]
  unkeyed?: true
  cacheOff?: true
  blockedBy?: string
  timedOut?: true
  notReady?: 'timeout' | 'exited' | 'spawn'
  where?: string
  outputs?: 'deferred'
  wallclockStartNs?: bigint
  wallclockEndNs?: bigint
  restored?: boolean
  attempts?: number
  failedAttempts?: readonly { endedAt: number; exitCode: number; timedOut?: true }[]
  flaky?: { passes: number; failures: number }
  sandboxViolations?: number
  sandboxViolationLines?: string[]
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

## `TaskStatus`

type · `src/graph/scheduler.ts`

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
  outputs?: 'deferred'
  attempts?: number
  blockedBy?: string
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

type · `src/orchestrator/events.ts`

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
export const TELEMETRY_SCHEMA_VERSION = 3
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

## `UserError`

class · `src/util/errors.ts`

```ts
export class UserError extends Error {
  constructor(message: string)
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
executed. Registered explicitly in vx.workspace.ts via
defineWorkspace({ plugins: [...] }). No auto-discovery.

Made by `definePlugin(import.meta, hooks)` only: the loader refuses a
plain object. The capabilities are consulted by `plugin-host.ts`. Core
names no plugin; the local executor and the local cache are the floor
under the list, taking what every plugin declines.

```ts
export interface VxPlugin {
  readonly name: string
  config?(workspace: WorkspaceConfig, ctx: WorkspaceHookContext): void | Promise<void>
  discover?(ctx: DiscoverContext): readonly NamedProject[] | Promise<readonly NamedProject[]>
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
  cache?(ctx: CacheContext): CacheLayer | undefined | Promise<CacheLayer | undefined>
  executor?(ctx: ExecutorContext): TaskExecutor | undefined | Promise<TaskExecutor | undefined>
  telemetry?(
    ctx: TelemetryContext,
  ):
    | TelemetrySink
    | TelemetrySink[]
    | undefined
    | Promise<TelemetrySink | TelemetrySink[] | undefined>
  setup?(ctx: PluginSetupContext): void | Promise<void>
  teardown?(): void | Promise<void>
}
```

## `whyDidThisRerunQuery`

function · `src/orchestrator/metrics.ts`

```ts
export function whyDidThisRerun(db: Database, runId: string, taskId: string): WhyDidThisRerun
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

```ts
export interface WorkspaceConfig {
  concurrency?: number
  cacheDir?: string
  timeout?: number
  cacheRetention?: { olderThan?: string; maxSize?: string }
  affectedBase?: string
  cacheScope?: string
  rules?: WorkspaceRules
  plugins?: readonly Plugin[]
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
