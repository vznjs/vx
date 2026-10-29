import { lstatSync } from 'node:fs'
import path from 'node:path'
import type { TaskConfig } from '../config.js'
import type { FoldMemo, ProjectFilesCache, WorkspaceFilesCache } from '../cache/index.js'
import {
  ABSENT_INPUT,
  absentOr,
  addedInput,
  behindLink,
  filesToken,
  foldHead,
  type InputListing,
  type CacheKeyInput,
  type CacheLayer,
  FILE_HASH_RACY_MS,
  racyWindowMs,
  resolveInputs,
  type ResolveInputsArgs,
  type GitFilesCache,
  type TaskInputComponent,
  WORKSPACE_OUTPUT_PREFIX,
} from '../cache/index.js'
import type { InputFile, TaskInputs } from '../exec/index.js'
import { isGroupTask, type TaskNode, type TaskOutcome } from '../graph/index.js'
import { GROUP_VIA } from '../history/index.js'
import {
  isUserError,
  keysSorted,
  relPosix,
  secretMask,
  span,
  UserError,
  xxh3hex,
} from '../util/index.js'
import { expandGroupUpstream, filterUpstreamHashes } from './upstream.js'

/**
 * Per-run memoization caches for what doesn't change across tasks within
 * one run:
 *   - `projectFiles`: keyed by the project and its input DECLARATION.
 *     Tasks of one project that declare the same inputs and outputs
 *     resolve the same file list; see `ProjectFilesCache`.
 *   - `taskConfig`: keyed by the resolved-config object reference.
 *     Each task's config is created once at prepareRun time; the
 *     JSON.stringify + xxh3 of it is deterministic. WeakMap so
 *     entries free when the orchestrator is done.
 *
 * The whole memo is optional — the helpers fall back to computing
 * fresh when it is missing.
 */
export interface HashCache {
  taskConfig: WeakMap<TaskConfig, string>
  runtime: Map<string, Promise<string>>
  workspaceRuntime: Map<string, Promise<string>>
  workspaceFiles: WorkspaceFilesCache
  projectFiles: ProjectFilesCache
  /** Each task's last key by its probe, across runs (the local cache's `FoldMemo`). */
  folds?: FoldMemo | undefined
  /**
   * The token of the remembered graph the run's nodes are (graph-memo.ts),
   * while no plugin or flag has edited them since.
   */
  graph?: string | undefined
}

export function createHashCache(folds?: FoldMemo): HashCache {
  return {
    taskConfig: new WeakMap(),
    runtime: new Map(),
    workspaceRuntime: new Map(),
    workspaceFiles: new Map(),
    projectFiles: new Map(),
    folds,
  }
}

export interface ComputeHashArgs {
  node: TaskNode
  upstream: TaskOutcome[]
  workspaceRoot: string
  cache: CacheLayer
  forwardArgs?: readonly string[] | undefined
  nestedProjectDirs: string[]
  gitFilesCache?: GitFilesCache
  hashCache?: HashCache
  /**
   * When provided, the resolved `CacheKeyInput` components are pushed
   * here (one per key contribution) so the caller can persist them.
   * No effect on the returned hash — pure capture of values `key()`
   * already folds. The push happens inside `cache.key()` at each fold
   * site, so the recorded set can't drift from the key.
   */
  captureInto?: TaskInputComponent[]
  /**
   * The run's tasks whose runtime probes may read an upstream's writes
   * (`probesAfterWrites`): such a task's probes are answered for it alone,
   * after its upstream ran, never from the run's shared memo.
   */
  probesAfterWrites?: ReadonlySet<string>
}

/**
 * Resolve every input the cache key depends on (file content, env
 * values, upstream hashes, config bytes, forwardArgs) and ask the cache layer to combine them. Used by both
 * `executeTask` for the real run and `plan()` for `--dry`
 * previews.
 *
 * Caller is responsible for handling the group-task case before
 * calling this — an unkeyed group has no `exec` and no `inputs`, so the
 * key-derivation steps below would all fall back to defaults.
 * `computeGroupKey` is exported for that purpose.
 */
export async function computeTaskHash(args: ComputeHashArgs): Promise<string> {
  if (isKeyless(args.node.config)) return keylessHash(args.node.id)
  return taskHash(args)
}

async function taskHash(args: ComputeHashArgs): Promise<string> {
  const end = span('task hash')
  try {
    const folds = args.captureInto === undefined ? args.hashCache?.folds : undefined
    const token = folds === undefined ? undefined : filesToken(inputsArgs(args))
    if (folds === undefined || token === undefined) {
      return await args.cache.key((await resolveKeyInput(args)).input)
    }
    // The files fold last, so a fold up to them seeded into their token
    // names the key the whole fold would: the files go unresolved.
    const head = foldHead((await resolveKeyInput(args, true)).input)
    const probe = xxh3hex(`${FOLD_MEMO_VERSION}\0${token}`, head)
    const known = folds.get(args.node.id, probe)
    if (known !== undefined) return known
    const key = await args.cache.key((await resolveKeyInput(args)).input)
    folds.set(args.node.id, probe, key)
    return key
  } finally {
    end()
  }
}

/**
 * Moves every remembered fold: bump it when what a token stands for
 * changes, as when `resolveFiles` picks other files from the same records.
 */
const FOLD_MEMO_VERSION = 'fold-memo-v1'

/**
 * A task that runs a command and declares no `inputs`: nothing says what
 * it read, so no key can stand for its outputs, and a key that folds it
 * would replay a stale entry (2026-10-16).
 */
export function isKeyless(task: TaskConfig): boolean {
  return task.exec !== undefined && task.inputs === undefined
}

/**
 * Drawn once per process, on first use, so no run derives another run's
 * keyless keys.
 */
let keylessSalt: string | undefined

/** A keyless task's key: this run's alone, so every key folding it misses. */
function keylessHash(taskId: string): string {
  keylessSalt ??= crypto.randomUUID()
  return xxh3hex(`keyless\0${keylessSalt}\0${taskId}`)
}

/**
 * One file the key folded: the digest it folded, and since when (ms since
 * the epoch) that digest is known to be the file's content — the
 * enumeration's start for an index OID (`git status` vouched for it then),
 * the describe's start for a digest hashed from the file.
 */
export interface InputFact {
  path: string
  digest: string
  since: number
  /**
   * For a link, the content behind it (`behindLink`), which the key folds
   * after the link's own target string. An edit there leaves the link
   * untouched, so the re-check compares this rather than the link's ctime.
   */
  behind?: string
}

/**
 * The key AND the structured input set behind it, for the executor seam.
 * Miss path only: it re-runs the (memoized) resolution `computeTaskHash`
 * did for the probe and retains the VALUES the key folded — env, runtime
 * output, per-file digests — which `captureInto` deliberately reduces to
 * digests because its rows are persisted. Per-file digests come from the
 * same sources as the fold: the index-OID map for clean tracked files,
 * else `hashFile`'s stat memo (already warm after `key()`).
 */
export async function describeTaskInputs(args: ComputeHashArgs): Promise<{
  hash: string
  inputs: TaskInputs
  facts: InputFact[]
  describedAt: number
  /** An input file the key did not fold that exists now (see `addedInput`). */
  added: () => string | undefined
}> {
  const hashedAt = Date.now()
  const { input, listings } = await resolveKeyInput(args)
  const sorted = [...input.inputFiles].sort()
  const digests = await Promise.all(
    sorted.map((f) => input.fileHashes?.get(f) ?? args.cache.hashFile(f).catch(absentOr)),
  )
  // Learned BEFORE the key folds it: an edit in between then reads as a
  // move at the re-check (a withheld save), never as content the key
  // did not fold matching it (a stale entry).
  const hashFile = (f: string): Promise<string> => args.cache.hashFile(f)
  const behind = new Map<string, string>()
  await Promise.all(
    sorted.map(async (f, i) => {
      if (digests[i]!.startsWith('120000:')) behind.set(f, await behindLink(f, hashFile))
    }),
  )
  const hash = await args.cache.key(input)
  // A file gone since the enumeration is no input: the task will not read it.
  const files: InputFile[] = sorted.flatMap((f, i) =>
    digests[i] === ABSENT_INPUT
      ? []
      : [{ path: relPosix(input.workspaceRoot, f), digest: digests[i]! }],
  )
  const indexedAt = args.gitFilesCache?.enumeratedAtMs ?? 0
  const facts: InputFact[] = sorted.map((f, i) => {
    const fact: InputFact = {
      path: f,
      digest: digests[i]!,
      since: input.fileHashes?.has(f) === true ? indexedAt : hashedAt,
    }
    const linked = behind.get(f)
    if (linked !== undefined) fact.behind = linked
    return fact
  })
  // Groups expanded: this list describes the INPUT ROOT, not the key, and a
  // group produces nothing of its own (see `CacheKeyInput.upstreamGraft`).
  // Sorted by hash so the list — and any action digest derived from it — is
  // independent of dependency declaration order.
  const graft = [...(input.upstreamGraft ?? [])].sort((a, b) =>
    a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0,
  )
  // Output lists come from the local index — one SELECT for every upstream
  // entry. An upstream with no entry (non-cacheable) contributes an empty list.
  // Read on first access: the local floor never reads it, and its every
  // miss paid a query over the whole closure (execute-task reads it up
  // front for a plugin executor).
  const listUpstream = (): TaskInputs['upstream'] => {
    const rows = args.cache.loadOutputFilesBatch(graft.map((g) => g.hash))
    return graft.map((g) => {
      const outputs = (rows.get(g.hash) ?? []).map((r) =>
        r.path.startsWith(WORKSPACE_OUTPUT_PREFIX)
          ? r.path.slice(WORKSPACE_OUTPUT_PREFIX.length)
          : relPosix(input.workspaceRoot, path.join(g.projectDir, r.path)),
      )
      return { taskId: g.taskId, hash: g.hash, outputs }
    })
  }
  let upstream: TaskInputs['upstream'] | undefined
  // A listing from the run's enumeration is as old as it; one listed with
  // no run cache was listed during this describe.
  const listedAt = args.gitFilesCache === undefined ? hashedAt : indexedAt
  return {
    hash,
    facts,
    describedAt: hashedAt,
    added: () => addedInput(listings, new Set(input.inputFiles), listedAt),
    inputs: {
      files,
      env: input.envValues.map(([name, value]) => ({ name, value })),
      runtime: (input.runtimeValues ?? []).map(([command, output]) => ({ command, output })),
      workspaceRuntime: (input.workspaceRuntimeValues ?? []).map(([command, output]) => ({
        command,
        output,
      })),
      get upstream() {
        return (upstream ??= listUpstream())
      },
      configDigest: input.taskConfigHash,
    },
  }
}

/**
 * The first input whose content may no longer be the digest the key folded
 * (item 743), or undefined when every one still is. One `lstat` per file:
 * a file whose ctime is older than its fact (by the racy window, as git
 * judges its index) has not been written since, and one that is not gets
 * hashed again and compared. ctime, because no writer can set it back. A
 * file that is gone has moved. One written at or after `commandFrom` (the
 * describe just before the command) has moved whatever it holds now: an
 * input changed and changed BACK while the command ran matched its digest
 * again, and the entry saved the other content's output under the key (item
 * 1015). A write before it — an upstream's — is judged by content, as before.
 * `byBytes` (`inputStability.strategy: 'mutable'`) judges a write during
 * the command by content too, when it answers true for that file and its
 * ctime: the task says the same bytes are its own identical rewrite
 * (tsdown's package.json), not an edit undone, unless another command that
 * may write the file ran until then (command-windows.ts). A link's content
 * behind it (`InputFact.behind`) is followed again and compared.
 */
export async function movedInput(
  facts: readonly InputFact[],
  cache: CacheLayer,
  commandFrom?: number,
  byBytes?: (file: string, ctimeMs: number) => boolean,
): Promise<string | undefined> {
  const suspects: InputFact[] = []
  for (const f of facts) {
    let ctimeMs: number
    try {
      ctimeMs = lstatSync(f.path).ctimeMs
    } catch {
      // Gone, as the key folded it (`ABSENT_INPUT`): unmoved.
      if (f.digest === ABSENT_INPUT) continue
      return f.path
    }
    // Back since the key folded it gone.
    if (f.digest === ABSENT_INPUT) return f.path
    // A whole-second stamp may stand for any write in its second (two for
    // an even one, FAT's tick), one during the command included
    // (`racyWindowMs`).
    if (commandFrom !== undefined && ctimeMs >= commandFrom - racyWindowMs(ctimeMs, 0)) {
      if (byBytes?.(f.path, ctimeMs) !== true) return f.path
      suspects.push(f)
      continue
    }
    if (ctimeMs >= f.since - racyWindowMs(ctimeMs, FILE_HASH_RACY_MS)) suspects.push(f)
  }
  for (const f of suspects) {
    const now = await cache.hashFile(f.path).catch(() => undefined)
    if (now !== f.digest) return f.path
  }
  // What a link points to changes without touching the link: each is
  // followed again (links are rare, so a task without one pays nothing).
  const hashFile = (file: string): Promise<string> => cache.hashFile(file)
  for (const f of facts) {
    if (f.behind !== undefined && (await behindLink(f.path, hashFile)) !== f.behind) return f.path
  }
  return undefined
}

/** A task's `filesToken`, as its key's fold memo probe takes it. */
export function taskFilesToken(
  args: Pick<
    ComputeHashArgs,
    'node' | 'workspaceRoot' | 'nestedProjectDirs' | 'gitFilesCache' | 'hashCache'
  >,
): string | undefined {
  return filesToken(inputsArgs({ ...args, upstream: [], cache: undefined as never }))
}

/** What `resolveInputs` is asked for a task's key. */
function inputsArgs(args: ComputeHashArgs): ResolveInputsArgs {
  const cfg = args.node.config
  const cacheCfg = cfg.cache
  return {
    projectDir: args.node.projectDir,
    workspaceRoot: args.workspaceRoot,
    envSource: process.env,
    inputs: cfg.inputs,
    ownOutputs: cacheCfg?.outputs.files ?? [],
    ownWorkspaceOutputs: cacheCfg?.outputs.workspaceFiles ?? [],
    nestedProjectDirs: args.nestedProjectDirs,
    ...(args.gitFilesCache !== undefined ? { gitFilesCache: args.gitFilesCache } : {}),
    ...(args.probesAfterWrites?.has(args.node.id) === true ? { runtimeScope: args.node.id } : {}),
    ...(args.hashCache !== undefined
      ? {
          runtimeCache: args.hashCache.runtime,
          workspaceRuntimeCache: args.hashCache.workspaceRuntime,
          workspaceFilesCache: args.hashCache.workspaceFiles,
          projectFilesCache: args.hashCache.projectFiles,
        }
      : {}),
  }
}

async function resolveKeyInput(
  args: ComputeHashArgs,
  skipFiles = false,
): Promise<{ input: CacheKeyInput; listings: InputListing[] }> {
  const cfg = args.node.config
  const resolved = await resolveInputs({
    ...inputsArgs(args),
    ...(skipFiles ? { skipFiles } : {}),
  }).catch((err: unknown) => {
    // A failed probe's message quotes its command and output, and the probe
    // runs in vx's own environment: `echo $NPM_TOKEN` printed the token in
    // the task's stream and `--dry`'s stderr.
    if (!isUserError(err)) throw err
    const secrets = secretMask([process.env, cfg.exec?.env?.define], cfg.exec?.env?.secret)
    throw secrets === null ? err : new UserError(secrets.mask(err.message))
  })

  const upstreamPairs = filterUpstreamHashes(
    args.upstream,
    cfg.inputs?.tasks,
    args.node.projectName,
    args.node.id,
  )
  const upstreamHashes = upstreamPairs.map(([, hash]) => hash)
  // hash → upstream task id, for capture-row naming only (not folded).
  const upstreamIds = new Map(upstreamPairs.map(([id, hash]) => [hash, id]))
  // A group records no run and keeps no fingerprints, so `vx why` could not
  // see past one: each folded group's members are captured as rows of their
  // own, named through it. Rows only, never folded: the group's hash already
  // folds theirs.
  if (args.captureInto !== undefined) {
    const folded = new Set(upstreamPairs.map(([id]) => id))
    for (const g of args.upstream) {
      if (g.groupUpstream === undefined || !folded.has(g.node.id)) continue
      for (const m of expandGroupUpstream(g.groupUpstream)) {
        if (m.hash === undefined) continue
        args.captureInto.push({
          kind: 'upstream',
          name: `${g.node.id}${GROUP_VIA}${m.node.id}`,
          hash: m.hash,
        })
      }
    }
  }
  // The DEPENDENCY closure, groups expanded — for the executor's input root.
  // Deliberately NOT the filtered set above: `inputs.tasks` says which
  // upstream KEYS this task's key folds, and what a task may READ is
  // `dependsOn`. Locally every dependency's outputs are on disk before the
  // command runs however the filter is written, so an executor that ships the
  // input closure has to ship the same thing or the task sees less remotely
  // than it does here. Not folded — see `upstreamGraft`.
  const upstreamGraft = expandGroupUpstream(args.upstream)
    .filter((u) => u.hash !== undefined)
    .map((u) => ({ taskId: u.node.id, hash: u.hash!, projectDir: u.node.projectDir }))
  // Trusted index-OID map for this project (populated by the run's
  // bulk `git ls-files -s` + `git status` pass). Mapped files skip
  // hashFile entirely; everything else falls back to the identical
  // in-process blob-OID computation. Tasks declaring workspaceFiles
  // also merge the workspace-wide partition's OIDs (keyed by abs
  // path, so the two maps agree wherever they overlap).
  // A fold that stops short of the files reads no OID: asking built the map.
  let fileHashes = skipFiles ? undefined : args.gitFilesCache?.oidsFor(args.node.projectDir)
  if (!skipFiles && (cfg.inputs?.workspaceFiles?.length ?? 0) > 0) {
    const wsOids = args.gitFilesCache?.oidsFor(args.workspaceRoot)
    if (wsOids !== undefined && wsOids !== fileHashes) {
      fileHashes = fileHashes === undefined ? wsOids : new Map([...wsOids, ...fileHashes])
    }
  }
  const taskConfigHash = hashTaskConfig(cfg, args.hashCache)

  // Args after `--` reach a requested command; the default build (a keyed
  // group) runs none, and folded, they moved every key that folds its own.
  const effectiveForwardArgs =
    args.node.requested && !isGroupTask(args.node) ? (args.forwardArgs ?? []) : []

  const input: CacheKeyInput = {
    taskId: args.node.id,
    taskConfigHash,
    envValues: resolved.envValues,
    runtimeValues: resolved.runtimeValues,
    workspaceRuntimeValues: resolved.workspaceRuntimeValues,
    inputFiles: resolved.files,
    workspaceRoot: args.workspaceRoot,
    upstreamHashes,
    upstreamIds,
    upstreamGraft,
    forwardArgs: effectiveForwardArgs,
    ...(fileHashes !== undefined ? { fileHashes } : {}),
    ...(args.node.keyParts !== undefined ? { pluginParts: args.node.keyParts } : {}),
    ...(args.node.platform !== undefined ? { platform: args.node.platform } : {}),
    ...(args.captureInto !== undefined ? { captureInto: args.captureInto } : {}),
  }
  return { input, listings: resolved.listings }
}

/**
 * Hash the resolved task config. Folds every config-time decision
 * (command, env names, dependsOn, cache directives, outputs,
 * passThroughEnv list, etc.) into the cache key. Imported values
 * participate because the loader has already baked them into the
 * resolved object before we serialize.
 *
 * A loaded config is JSON data: every load path refuses a value JSON
 * cannot carry (workspace/json-data.ts, item 701), so this JSON is the
 * config as vx reads it. The `hashCache.taskConfig` WeakMap is consulted first —
 * each task's config object is created once per run, so a hit there
 * skips the JSON.stringify + xxh3 entirely.
 */
export function hashTaskConfig(cfg: TaskConfig, hashCache?: HashCache): string {
  if (hashCache) {
    const cached = hashCache.taskConfig.get(cfg)
    if (cached !== undefined) return cached
    const hash = xxh3hex(JSON.stringify(hashableConfig(cfg)))
    hashCache.taskConfig.set(cfg, hash)
    return hash
  }
  return xxh3hex(JSON.stringify(hashableConfig(cfg)))
}

/**
 * Project the config for hashing: `exec.remote` is a pure PLACEMENT hint
 * with zero effect on outputs, so it is stripped — pinning a task to this
 * machine never busts a cache. It must not: the whole contract of a remote
 * executor is that the same command over the same inputs produces the
 * same outputs, so a key that moved when placement changed would split a
 * laptop from a worker pool over nothing. (`exec.resources` rode the same
 * rule until 2026-09-12, when reservations left the config for the
 * schedule plugin that learns them; a config never declares them now.) A
 * config that declares no `remote` takes the fast path. That is a
 * SHORTCUT, not the reason the field needed no CACHE_VERSION bump:
 * measured (item 505), the spread path stringifies byte-identically for
 * every config that HAS an `exec`, since a spread keeps an existing key
 * in place. Its one behavioural case is a config with NO `exec`, where
 * the spread would add `exec: {}` — and nothing reaches here that way,
 * proven by throwing on a no-exec config and running the whole suite:
 * a group takes `computeGroupKey`, and a keyed group has no `exec`, so no
 * `remote`. `timeout`/`retries` stay folded — their keys are
 * distinct by design (see the decision log); stripping them retroactively
 * would bump CACHE_VERSION.
 */
function hashableConfig(cfg: TaskConfig): unknown {
  // Keys sorted: moving `cache` above `exec`, or a `define` in another
  // order, missed every key of the task, and a `project` or `graph` plugin
  // writes a config the lock never sorted (2026-10-25).
  if (cfg.exec?.remote === undefined) return keysSorted(cfg)
  const { remote: _remote, ...execRest } = cfg.exec
  return keysSorted({ ...cfg, exec: execRest })
}

/**
 * A group's key: its upstream, and for a keyed group — one with `inputs`,
 * the default `build` (projects.ts) or a config's — its own inputs too,
 * the way a task's key folds them.
 */
export async function computeGroupKey(args: ComputeHashArgs): Promise<string> {
  if (args.node.config.inputs === undefined) return computeGroupHash(args.upstream)
  return computeTaskHash(args)
}

/**
 * An unkeyed group's key is `computeGroupHash` of its upstream alone, so a
 * live upstream with the same ids and keys in the same order derives these
 * bytes (execute-task's `sameUpstream`).
 */
export interface UpfrontGroupKey {
  key: string
  upstream: TaskOutcome[]
}

/**
 * Derive a stable hash for a group task (no `exec`) from its upstream
 * outcomes. Lets downstream tasks that filter `inputs.tasks` to
 * include a group still invalidate naturally when anything beneath
 * the group changes. Sorted so the hash is order-independent. Empty
 * group (no upstream) yields a fixed sentinel hash.
 */
export function computeGroupHash(upstream: TaskOutcome[]): string {
  const ids = upstream
    .map((u) => `${u.node.id}:${u.hash ?? ''}`)
    .sort()
    .join('|')
  return xxh3hex(`group|${ids}`)
}
