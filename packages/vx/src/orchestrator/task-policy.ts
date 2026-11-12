// What a cached task may do, decided once from its config, the run's cache
// policy and its upstream, before any key is taken or command run.

import type { ExecConfig, InputsConfig, InputStability } from '../config.js'
import { type CachePolicy, FULL_CACHE_POLICY } from '../cache/index.js'
import { standInsOf, type TaskOutcome } from '../graph/index.js'
import type { ExecuteArgs } from './execute-task.js'
import { isKeyless } from './task-hash.js'
import { expandGroupUpstream, filterUpstreamHashes } from './upstream.js'
import { taskTimeoutMs } from './task-process.js'

export interface TaskPolicy {
  readonly exec: ExecConfig
  readonly cache: CachePolicy
  /** `cache: true` in the task's config. */
  readonly cacheable: boolean
  /** `exec.remote: 'only'` placed remotely: this machine's disk is untouched. */
  readonly remoteOnly: boolean
  /** The task whose missing `inputs` leaves this key the run's alone (`isKeyless`). */
  readonly keylessBy: string | undefined
  /** A folded upstream that ran over inputs its key no longer describes. */
  readonly unkeyedUpstream: TaskOutcome | undefined
  /** Probe the cache before running. */
  readonly read: boolean
  /** Manage outputs (clean before exec): a write axis is on. */
  readonly write: boolean
  /** A passing run is planned to be saved; the save gate decides after it. */
  readonly save: boolean
  /** `--cache-download` deferred this task: no clean, no save here. */
  readonly deferred: boolean
  readonly outputs: readonly string[]
  readonly wsOutputs: readonly string[]
  readonly forwardArgs: readonly string[]
  readonly timeout: number | undefined
  /** Its outputs overlap an upstream's: stamped, never cleaned by glob. */
  readonly additive: boolean
  /** `outputs.clean: false`: the first attempt finds its last outputs. */
  readonly keepOutputs: boolean
  readonly sandboxed: boolean
  /** `retries` set by the task or the run, an explicit 0 included. */
  readonly retriesSet: boolean
  readonly maxAttempts: number
  /** A retry may follow the first attempt (configured, or a known flake's). */
  readonly retryCanFollow: boolean
  readonly stability: Required<InputStability>
  /** The request's `unsaved`: an executor's own record keeps nothing of it. */
  readonly unsaved: boolean
  /** The request's `refresh`: an executor's own record is not replayed. */
  readonly refresh: boolean
}

export function taskPolicy(args: ExecuteArgs): TaskPolicy {
  const { node, upstream, cache } = args
  const cfg = node.config
  const exec = cfg.exec as ExecConfig // the dispatcher guarantees exec is present
  const cfgOut = cfg.outputs
  const policy = args.cachePolicy ?? FULL_CACHE_POLICY
  const cacheable = cfg.cache === true
  // `--no-cache` (all axes off) leaves the user's tree alone, while `--force`
  // (reads off, writes on) still wipes and repopulates a clean snapshot. A
  // remote-only task never touches this machine's disk: restoring
  // node_modules onto a dev machine is what the field exists to prevent.
  const remoteOnly = args.remoteOnly === true
  const present = upstream.filter((u): u is TaskOutcome => u !== undefined)
  const folded = new Set(
    filterUpstreamHashes(
      present,
      cfg.inputs?.tasks,
      node.projectName,
      node.id,
      standInsOf(node),
    ).map(([id]) => id),
  )
  const foldedTasks = expandGroupUpstream(present.filter((u) => folded.has(u.node.id)))
  const keylessBy = isKeyless(cfg)
    ? node.id
    : foldedTasks
        .map((u) => u.keylessBy ?? (isKeyless(u.node.config) ? u.node.id : undefined))
        .find((id) => id !== undefined)
  const keyless = keylessBy !== undefined
  const reads = policy.localRead || policy.remoteRead
  const read = !remoteOnly && cacheable && !keyless && reads
  const write = !remoteOnly && cacheable && (policy.localWrite || policy.remoteWrite)
  // This key folds the key of an upstream that ran over moved inputs, while
  // the bytes on disk are not the ones that key names. With `a.txt` edited
  // while `gen` ran, `gen` withheld its save, `use` saved over the edit
  // under a key folding `gen`'s, and once `a.txt` was put back `use` hit
  // the edit's output. Only an upstream whose key this one folds: one read
  // by content (`tasks: []` and a file input) is judged by its bytes.
  const unkeyedUpstream = foldedTasks.find((u) => u.unkeyed === true)
  const save =
    write &&
    args.taintedUpstream !== true &&
    unkeyedUpstream === undefined &&
    !keyless &&
    args.belowNoop !== true
  // An executor's own record of executions is a remote store: a run whose
  // policy turns the remote's read or write off keeps it off that record
  // too. Only with a remote layer: a worker that shares this machine's
  // store (`@vzn/vx-dte`'s `local()`) is no remote.
  const remoteOff = (axis: 'remoteRead' | 'remoteWrite'): boolean =>
    cache.hasRemote === true && !policy[axis]
  const additive = (node.addsToOutputsOf?.length ?? 0) > 0
  const retriesSet = exec.retries !== undefined || args.retries !== undefined
  const maxAttempts = 1 + (exec.retries ?? args.retries ?? 0)
  return {
    exec,
    cache: policy,
    cacheable,
    remoteOnly,
    keylessBy,
    unkeyedUpstream,
    read,
    write,
    save,
    deferred: args.download === 'deferred',
    outputs: cfgOut?.files ?? [],
    wsOutputs: cfgOut?.workspaceFiles ?? [],
    forwardArgs: node.requested ? (args.forwardArgs ?? []) : [],
    // `exec.timeout` beats `run.timeout` (flag, variable, workspace).
    timeout: taskTimeoutMs(exec) ?? args.timeout,
    additive,
    // `outputs.clean: false` leaves the outputs to the first attempt's
    // command and saves whatever they hold after it: the user opted out of
    // the clean-tree guarantee. An additive task never cleans by glob anyway.
    keepOutputs: !additive && (cfgOut?.clean ?? args.cleanOutputs ?? true) === false,
    sandboxed: exec.sandbox !== undefined,
    retriesSet,
    maxAttempts,
    retryCanFollow:
      maxAttempts > 1 || (!retriesSet && cacheable && !keyless && args.knownFlaky !== undefined),
    stability: inputStabilityOf(cfg.inputs, args.inputStability),
    unsaved: cacheable && ((!remoteOnly && !save) || remoteOff('remoteWrite')),
    refresh: cacheable && (!reads || remoteOff('remoteRead')),
  }
}

/**
 * What a write to an input during the command means, each field highest
 * first: the env var (`layers.run`), the task's `inputs.stability`, the
 * workspace's, then `'immutable'` and `'warn'`: by default any such write
 * withholds the save, on CI too, since a concurrent task can change an
 * input and put it back.
 */
export function inputStabilityOf(
  inputs: InputsConfig | undefined,
  layers: ExecuteArgs['inputStability'],
): Required<InputStability> {
  const task = inputs?.stability
  return {
    strategy: layers?.run.strategy ?? task?.strategy ?? layers?.workspace?.strategy ?? 'immutable',
    severity: layers?.run.severity ?? task?.severity ?? layers?.workspace?.severity ?? 'warn',
  }
}
