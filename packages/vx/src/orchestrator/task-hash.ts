import { lstatSync } from 'node:fs'
import path from 'node:path'
import type { InputStability, TaskConfig } from '../config.js'
import {
  type FoldMemo,
  FILE_HASH_RACY_MS,
  racyWindowMs,
  stampGrainMs,
  WORKSPACE_OUTPUT_PREFIX,
} from '../memo/index.js'
import {
  type ProjectFilesCache,
  type WorkspaceFilesCache,
  ABSENT_INPUT,
  absentOr,
  addedInput,
  behindLink,
  filesToken,
  foldHead,
  hashFileSeen,
  hashFilesOf,
  type InputListing,
  type CacheKeyInput,
  type CacheLayer,
  resolveInputs,
  type ResolveInputsArgs,
  type GitFilesCache,
  type TaskInputComponent,
} from '../cache/index.js'
import type { InputFile, TaskInputs } from '../exec/index.js'
import {
  isGroupTask,
  KeyFailed,
  standInsOf,
  type TaskNode,
  type TaskOutcome,
} from '../graph/index.js'
import { GROUP_VIA } from '../history/index.js'
import {
  isUserError,
  keysSorted,
  memoParts,
  relPosix,
  secretMask,
  span,
  UserError,
  xxh3hex,
} from '../util/index.js'
import { outputsLeft } from './run-report.js'
import { expandGroupUpstream, filterUpstreamHashes } from './upstream.js'

/**
 * Per-run memos for what does not change across tasks:
 * - `projectFiles`: by project and input declaration (`ProjectFilesCache`).
 * - `taskConfig`: by resolved-config identity; a WeakMap, freed with the run.
 *   Optional: the helpers compute fresh without it.
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

/**
 * The workspace `outputs.clean` after the config stage: a task without its own
 * runs under it, so its key folds it (`hashableConfig`). Beside `HashCache`,
 * which is the package's surface.
 */
const workspaceClean = new WeakMap<HashCache, boolean>()

/** The workspace's `outputs.clean` the run's keys were derived under. */
export function workspaceCleanOf(hashCache: HashCache): boolean | undefined {
  return workspaceClean.get(hashCache)
}

/**
 * The `inputs.stability.strategy` from `VX_INPUTS_STABILITY_STRATEGY` (beating
 * the task's) and the workspace (beaten by it): it decides which saves are
 * kept, so a key folds the one the task runs under.
 */
const inputStrategies = new WeakMap<HashCache, InputStrategies>()

type InputStrategy = InputStability['strategy']
type InputStrategies = { run?: InputStrategy; workspace?: InputStrategy }

/** The run-level `inputs.stability.strategy` values the run's keys were derived under. */
export function inputStrategiesOf(hashCache: HashCache): InputStrategies | undefined {
  return inputStrategies.get(hashCache)
}

export function createHashCache(
  folds?: FoldMemo,
  cleanOutputs?: boolean,
  strategies?: InputStrategies,
): HashCache {
  const hashCache: HashCache = {
    taskConfig: new WeakMap(),
    runtime: new Map(),
    workspaceRuntime: new Map(),
    workspaceFiles: new Map(),
    projectFiles: new Map(),
    folds,
  }
  if (cleanOutputs !== undefined) workspaceClean.set(hashCache, cleanOutputs)
  if (strategies?.run !== undefined || strategies?.workspace !== undefined)
    inputStrategies.set(hashCache, strategies)
  return hashCache
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
   * When provided, each `CacheKeyInput` component is pushed here as
   * `cache.key()` folds it, so the persisted set cannot drift from the key.
   */
  captureInto?: TaskInputComponent[]
  /**
   * The run's tasks whose runtime probes may read an upstream's writes
   * (`probesAfterWrites`): such a task's probes are answered for it alone,
   * after its upstream ran, never from the run's shared memo.
   */
  probesAfterWrites?: ReadonlySet<string>
}

/** A key derivation whose throw is the task's `KeyFailed`: its command never ran. */
export async function keyOf(derived: Promise<string>): Promise<string> {
  try {
    return await derived
  } catch (err) {
    throw new KeyFailed(err)
  }
}

/**
 * Resolve every input the key depends on (files, env, upstream hashes, config,
 * forwardArgs) and have the cache layer combine them. Used by `executeTask` and
 * `plan()`.
 *
 * The caller handles groups first with `computeGroupKey`: an unkeyed group has
 * no `exec` or `inputs`.
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
      return await args.cache.key(await knownIdentities(args, (await resolveKeyInput(args)).input))
    }
    // The files fold last, so a fold up to them seeded into their token
    // names the key the whole fold would: the files go unresolved.
    const head = foldHead((await resolveKeyInput(args, true)).input)
    const probe = FOLD_PARTS.token(FOLD_MEMO_VERSION, { head, files: token })!
    const known = folds.get(args.node.id, probe)
    if (known !== undefined) return known
    const key = await args.cache.key(
      await knownIdentities(args, (await resolveKeyInput(args)).input),
    )
    folds.set(args.node.id, probe, key)
    return key
  } finally {
    end()
  }
}

/**
 * `input` with each file the index vouches no OID for named by the identity the
 * run already learned (`identityOf`), so a file many tasks read is stat'ed
 * once. A fast path only: each answer is `hashFile`'s own. A file whose hash
 * fails is left for the fold to ask.
 */
async function knownIdentities(
  args: ComputeHashArgs,
  input: CacheKeyInput,
): Promise<CacheKeyInput> {
  const run = args.gitFilesCache
  if (run === undefined) return input
  const provided = input.fileHashes
  let missing = false
  for (const f of input.inputFiles) {
    if (provided?.get(f) === undefined) {
      missing = true
      break
    }
  }
  if (!missing) return input
  const known = new Map<string, string>()
  const ask: string[] = []
  for (const f of input.inputFiles) {
    const id = provided?.get(f) ?? run.identityOf(f)
    if (id !== undefined) known.set(f, id)
    else ask.push(f)
  }
  const epoch = run.factsEpoch
  const learned = await hashFilesOf(args.cache.memo, ask)
  run.learnIdentities(learned, epoch)
  for (const [f, id] of learned) known.set(f, id)
  return { ...input, fileHashes: known }
}

/**
 * Moves every remembered fold: bump it when what a token stands for
 * changes, as when `resolveFiles` picks other files from the same records.
 */
const FOLD_MEMO_VERSION = 'fold-memo-v1'

/** A task's fold up to its files (`foldHead`) and the token of the files it would resolve. */
const FOLD_PARTS = memoParts<{ head: bigint; files: string }>({
  head: (head) => head.toString(36),
  files: (files) => files,
})

/**
 * A task that runs a command and declares no `inputs`: nothing says what it
 * read, so no key can stand for its outputs, and a key that folds it would
 * replay a stale entry.
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
 * One folded file: its digest, and since when (epoch ms) that digest is known
 * to be its content: the enumeration's start for an index OID, the describe's
 * start for a hashed one.
 */
export interface InputFact {
  path: string
  digest: string
  since: number
  /**
   * The ctime of the stat its digest came from, for a file hashed at the
   * describe (an index OID was not stat'ed): a ctime still equal to it is
   * not a write since, though the command's start shares its coarse tick.
   */
  ctimeMs?: number
  /**
   * For a link, the content behind it (`behindLink`), which the key folds
   * after the link's own target string. An edit there leaves the link
   * untouched, so the re-check compares this rather than the link's ctime.
   */
  behind?: string
}

/**
 * The key and the input set behind it, for the executor seam, miss path only:
 * it re-runs the memoized resolution and keeps the values the key folded (env,
 * runtime output, per-file digests), which `captureInto` reduces to digests.
 * Per-file digests come from the same sources as the fold.
 */
export async function describeTaskInputs(args: ComputeHashArgs): Promise<{
  hash: string
  inputs: TaskInputs
  facts: InputFact[]
  describedAt: number
  /** Lists `inputs.upstream` with a non-cacheable upstream's outputs on disk; before any read of it. */
  readUpstream: () => Promise<void>
  /** An input file the key did not fold that exists now (see `addedInput`). */
  added: () => string | undefined
}> {
  const hashedAt = Date.now()
  const { input, listings } = await resolveKeyInput(args)
  const sorted = [...input.inputFiles].sort()
  const ctimes = new Map<string, number>()
  const digests = await Promise.all(
    sorted.map(
      (f) =>
        input.fileHashes?.get(f) ??
        hashFileSeen(args.cache.memo, f, (c) => ctimes.set(f, c)).catch(absentOr),
    ),
  )
  // Learned BEFORE the key folds it: an edit in between then reads as a
  // move at the re-check (a withheld save), never as content the key
  // did not fold matching it (a stale entry).
  const hashFile = (f: string): Promise<string> => args.cache.memo.hashFile(f)
  const behind = new Map<string, string>()
  await Promise.all(
    sorted.map(async (f, i) => {
      if (digests[i]!.startsWith('120000:')) behind.set(f, await behindLink(f, hashFile))
    }),
  )
  // The key folds these same digests: asked again, each file was a second
  // lstat and memo lookup per miss (8,002 cold tasks: 160,000 of each), and
  // the key could fold bytes the facts the re-check compares never saw.
  const hash = await args.cache.key({
    ...input,
    fileHashes: new Map(sorted.map((f, i) => [f, digests[i]!])),
  })
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
    const ctimeMs = ctimes.get(f)
    if (ctimeMs !== undefined) fact.ctimeMs = ctimeMs
    const linked = behind.get(f)
    if (linked !== undefined) fact.behind = linked
    return fact
  })
  // Groups expanded: this describes the input root, not the key, and a group
  // produces nothing (`CacheKeyInput.upstreamGraft`). Sorted by hash, so it is
  // independent of declaration order.
  const graft = [...(input.upstreamGraft ?? [])].sort((a, b) =>
    a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0,
  )
  // Output lists from the local index, one SELECT for every upstream entry. A
  // non-cacheable upstream has no entry: its list is its declared outputs on
  // disk now (`readUpstream`); left empty, a remote executor shipped the
  // dependant without them and saved the result. Read on first access: the
  // local floor never reads it.
  const listUpstream = (onDisk?: ReadonlyMap<string, string[]>): TaskInputs['upstream'] => {
    const rows = args.cache.memo.loadOutputFilesBatch(graft.map((g) => g.hash))
    return graft.map((g) => {
      const outputs =
        onDisk?.get(g.taskId) ??
        (rows.get(g.hash) ?? []).map((r) =>
          r.path.startsWith(WORKSPACE_OUTPUT_PREFIX)
            ? r.path.slice(WORKSPACE_OUTPUT_PREFIX.length)
            : relPosix(input.workspaceRoot, path.join(g.projectDir, r.path)),
        )
      return { taskId: g.taskId, hash: g.hash, outputs }
    })
  }
  let upstream: TaskInputs['upstream'] | undefined
  const readUpstream = async (): Promise<void> => {
    if (upstream !== undefined) return
    const uncached = expandGroupUpstream(args.upstream).filter(
      (u) => u.hash !== undefined && u.node.config.cache !== true,
    )
    // No nested project is cut out: each file found is on this disk, where
    // a local run of the dependant reads it too.
    const onDisk = new Map(
      await Promise.all(
        uncached.map(
          async (u) => [u.node.id, await outputsLeft(u.node, input.workspaceRoot, [])] as const,
        ),
      ),
    )
    upstream ??= listUpstream(onDisk)
  }
  // A listing from the run's enumeration is as old as it; one listed with
  // no run cache was listed during this describe.
  const listedAt = args.gitFilesCache === undefined ? hashedAt : indexedAt
  return {
    hash,
    facts,
    describedAt: hashedAt,
    readUpstream,
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
 * The first input whose content may no longer be the folded digest, or
 * undefined. One `lstat` per file: a ctime older than its fact (by the racy
 * window, as git judges its index) is unwritten since (no writer can set ctime
 * back); otherwise it is hashed and compared. A gone file has moved. One
 * written after `commandFrom` (the file system's clock) has moved whatever it
 * holds: an input changed and changed back during the command matched its
 * digest, and the entry saved the other content's output. A write before it (an
 * upstream's) is judged by content. A coarse clock's same-tick ctime is the
 * upstream's if the describe already saw it (`InputFact.ctimeMs`), else the
 * command's. `byBytes` (`strategy: 'mutable'`) judges a mid-command write by
 * content when it answers true: the task's own identical rewrite (tsdown's
 * package.json), unless another writer ran until then (command-windows.ts). A
 * link's target (`InputFact.behind`) is followed again.
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
    // an even one, FAT's tick), one during the command included. No lag
    // widens it: `commandFrom` is on the file system's clock already.
    const grainMs = stampGrainMs(ctimeMs)
    if (
      commandFrom !== undefined &&
      (ctimeMs > commandFrom ||
        (ctimeMs >= commandFrom - grainMs && (grainMs > 0 || f.ctimeMs !== ctimeMs)))
    ) {
      if (byBytes?.(f.path, ctimeMs) !== true) return f.path
      suspects.push(f)
      continue
    }
    if (ctimeMs >= f.since - racyWindowMs(ctimeMs, FILE_HASH_RACY_MS)) suspects.push(f)
  }
  for (const f of suspects) {
    const now = await cache.memo.hashFile(f.path).catch(() => undefined)
    if (now !== f.digest) return f.path
  }
  // What a link points to changes without touching the link: each is
  // followed again (links are rare, so a task without one pays nothing).
  const hashFile = (file: string): Promise<string> => cache.memo.hashFile(file)
  for (const f of facts) {
    if (f.behind !== undefined && (await behindLink(f.path, hashFile)) !== f.behind) return f.path
  }
  return undefined
}

/**
 * A task's `filesToken`, as its key's fold memo probe takes it: the fields of
 * `inputsArgs` the token reads, and no more. Built through `inputsArgs`, two
 * spread objects per call were ~3 ms of 3,202.
 */
export function taskFilesToken(
  args: Pick<ComputeHashArgs, 'node' | 'workspaceRoot' | 'nestedProjectDirs'> & {
    gitFilesCache: GitFilesCache
  },
): string | undefined {
  const node = args.node
  const out = node.config.outputs
  return filesToken({
    projectDir: node.projectDir,
    workspaceRoot: args.workspaceRoot,
    inputs: node.config.inputs,
    ownOutputs: out?.files ?? [],
    ownWorkspaceOutputs: out?.workspaceFiles ?? [],
    nestedProjectDirs: args.nestedProjectDirs,
    gitFilesCache: args.gitFilesCache,
  })
}

/** What `resolveInputs` is asked for a task's key. */
function inputsArgs(args: ComputeHashArgs): ResolveInputsArgs {
  const cfg = args.node.config
  const cfgOut = cfg.outputs
  return {
    projectDir: args.node.projectDir,
    workspaceRoot: args.workspaceRoot,
    envSource: process.env,
    inputs: cfg.inputs,
    ownOutputs: cfgOut?.files ?? [],
    ownWorkspaceOutputs: cfgOut?.workspaceFiles ?? [],
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
    standInsOf(args.node),
  )
  const upstreamHashes = upstreamPairs.map(([, hash]) => hash)
  // hash → upstream task id, for capture-row naming only (not folded).
  const upstreamIds = new Map(upstreamPairs.map(([id, hash]) => [hash, id]))
  // A group keeps no fingerprints, so `vx why` could not see past one: its
  // members are captured as rows named through it. Rows only: the group's hash
  // already folds theirs.
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
  // The dependency closure, groups expanded, for the executor's input root. Not
  // the filtered set: `inputs.tasks` says which keys fold, `dependsOn` what a
  // task may read, and locally every dependency's outputs are on disk, so a
  // remote must ship the same. Not folded (`upstreamGraft`).
  const upstreamGraft = expandGroupUpstream(args.upstream)
    .filter((u) => u.hash !== undefined)
    .map((u) => ({ taskId: u.node.id, hash: u.hash!, projectDir: u.node.projectDir }))
  // This project's trusted index-OID map (the run's bulk `git ls-files -s` +
  // `git status`): mapped files skip hashFile, the rest compute the same blob
  // OID in process. A workspaceFiles task merges the workspace partition's OIDs
  // (by absolute path). A fold that stops short of files reads no OID.
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
 * Hash the resolved task config: every config-time decision folds into the key,
 * imported values included (the loader baked them in). Every load path refuses
 * non-JSON values (workspace/json-data.ts), so this JSON is the config as vx
 * reads it. The WeakMap memo skips stringify and xxh3 on a repeat.
 */
export function hashTaskConfig(cfg: TaskConfig, hashCache?: HashCache): string {
  if (hashCache) {
    const cached = hashCache.taskConfig.get(cfg)
    if (cached !== undefined) return cached
    const hash = xxh3hex(JSON.stringify(hashableConfig(asRun(cfg, hashCache))))
    hashCache.taskConfig.set(cfg, hash)
    return hash
  }
  return xxh3hex(JSON.stringify(hashableConfig(cfg)))
}

/**
 * The config as the task runs it, where a run-level value changes what is
 * saved: folded as the task's own field would be, and only then, so keys that
 * never ran under one stay.
 *
 * Workspace `outputs.clean: false` saves leftovers: a key that missed it hit
 * that entry once the clean was back. A non-`'immutable'` strategy keeps a save
 * the check would withhold: unfolded, that entry was hit once the check was
 * back.
 */
function asRun(cfg: TaskConfig, hashCache: HashCache): TaskConfig {
  let out = cfg
  if (workspaceClean.get(hashCache) === false && cfg.outputs && cfg.outputs.clean === undefined) {
    out = { ...out, outputs: { ...cfg.outputs, clean: false } }
  }
  const strategies = inputStrategies.get(hashCache)
  const inputs = cfg.inputs
  if (strategies !== undefined && inputs !== undefined && cfg.exec !== undefined) {
    const own = inputs.stability?.strategy
    const runs = strategies.run ?? own ?? strategies.workspace ?? 'immutable'
    if (runs !== (own ?? 'immutable')) {
      out = { ...out, inputs: { ...inputs, stability: { ...inputs.stability, strategy: runs } } }
    }
  }
  return out
}

/**
 * Project the config for hashing: `exec.remote` and `exec.worker` are placement
 * only, so they are stripped: the same command over the same inputs gives the
 * same outputs wherever it runs, and a key moving with placement would split a
 * laptop from a pool. A config with no `remote` takes the fast path; the spread
 * is byte-identical for any config with an `exec`, and none without one reaches
 * here. `timeout`/`retries` stay folded by design.
 */
function hashableConfig(cfg: TaskConfig): unknown {
  // Keys sorted: moving `cache` above `exec`, or a `define` in another order,
  // missed every key of the task, and a `project` or `graph` plugin writes a
  // config the lock never sorted.
  const env = cfg.inputs?.env
  const pass = cfg.exec?.env?.passThrough
  const secret = cfg.exec?.env?.secret
  if (
    cfg.exec?.remote === undefined &&
    cfg.exec?.worker === undefined &&
    sortedNames(env) &&
    sortedNames(pass) &&
    sortedNames(secret)
  )
    return keysSorted(cfg)
  const {
    remote: _remote,
    worker: _worker,
    ...execRest
  } = cfg.exec ?? ({} as NonNullable<TaskConfig['exec']>)
  // Env names are sets: each value is read by its name, so their order
  // keys nothing (conformance env/declared-order-irrelevant).
  if (!sortedNames(pass)) execRest.env = { ...execRest.env, passThrough: [...pass!].sort() }
  if (!sortedNames(secret)) execRest.env = { ...execRest.env, secret: [...secret!].sort() }
  const out: TaskConfig = cfg.exec === undefined ? { ...cfg } : { ...cfg, exec: execRest }
  if (!sortedNames(env)) out.inputs = { ...cfg.inputs!, env: [...env!].sort() }
  return keysSorted(out)
}

function sortedNames(names: readonly string[] | undefined): boolean {
  if (names === undefined) return true
  for (let i = 1; i < names.length; i++) if (names[i - 1]! > names[i]!) return false
  return true
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
 * A group's hash (no `exec`) from its upstream outcomes, so a dependent folding
 * the group invalidates when anything beneath it changes. Sorted,
 * order-independent; an empty group gets a fixed sentinel.
 */
export function computeGroupHash(upstream: TaskOutcome[]): string {
  const ids = upstream
    .map((u) => `${u.node.id}:${u.hash ?? ''}`)
    .sort()
    .join('|')
  return xxh3hex(`group|${ids}`)
}
