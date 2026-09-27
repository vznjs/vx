// The `executor` capability: run ONE task's command on a REAPI worker.
//
// The shape core hands over (`ExecuteRequest`) is already fully resolved —
// command, cwd, env, declared inputs WITH values, declared output globs — so
// this module's job is purely translation: inputs → Merkle tree, command →
// `Command`, the pair → `Action`, then `Execute` and materialise the outputs.
//
// Placement (which tasks may come here at all) is core's: a persistent task,
// anything depending on one, and `exec.remote: false` never reach an
// executor. This declines the rest of what it cannot honour.

import { mkdir, writeFile, chmod, realpath, rm, symlink, unlink } from 'node:fs/promises'
import { constants, existsSync } from 'node:fs'
import path from 'node:path'
import { isLiteralPattern, isUserError, normalizeGlob, UserError } from '@vzn/vx'
import type { ExecuteRequest, ExecuteResult, TaskExecutor, TaskPlacement } from '@vzn/vx'
import {
  buildInputTree,
  decodeTreeWithBytes,
  digestWith,
  encodeAction,
  encodeCommand,
  encodeTree,
  sha256,
  type Blob,
  type FileGraft,
  type TreeGraft,
} from './merkle.js'
import { execDigestFor } from './cache.js'
import type { ActionResult, Digest, Directory, Operation, ReapiClient } from './wire.js'

/**
 * Split a coarse output directory into the paths its GLOB actually names.
 *
 * REAPI `output_paths` are literal, so a glob with a wildcard in the MIDDLE
 * (`packages/*&#47;node_modules`) has to be requested as its static prefix
 * (`packages`) — and the worker duly returns that whole directory, manifests
 * and all. Grafting THAT into a consumer replaces its entire `packages/`,
 * taking every project's sources with it.
 *
 * The producer is the one place that knows the glob, so it decomposes here,
 * on the way INTO the execution record: one entry per real match, each a Tree
 * of its own. A consumer then grafts `packages/vx/node_modules` and nothing
 * else, and replacement stays exactly what it was — it just lands at the path
 * the user actually declared.
 *
 * The glob's LAST segment matches files and symlinks as well as directories,
 * as the local glob does (`dist/*` saves `dist/index.js`): those become
 * output files and symlinks of the record, or a replay drops them and core
 * saves the short tree under the pure-input key.
 *
 * Nothing reads the submitter's filesystem: the matches come from the tree the
 * worker returned, so the record is a function of the action's own result.
 */
async function decomposeOutputDir(
  client: ReapiClient,
  entry: { path: string; tree_digest: Digest },
  globs: readonly string[],
  warn: (m: string) => void,
): Promise<DecomposedOutputs> {
  const whole: DecomposedOutputs = { directories: [entry], files: [], symlinks: [] }
  // Only globs that COLLAPSED to this entry are interesting; a literal glob
  // already names its own path.
  const wild = globs
    .filter((g) => globToOutputPath(g) === entry.path && g !== entry.path)
    .map((g) => g.slice(entry.path.length + 1).split('/'))
  if (wild.length === 0) return whole
  // Only whole-segment wildcards are walked. One glob the walk cannot follow
  // (`*.js`, `**`) keeps the entry whole: splitting for its siblings would
  // record their matches and drop its own.
  if (wild.some((rest) => rest.some((seg) => seg !== '*' && !isLiteralPattern(seg)))) return whole

  const blob = await client.readBlob(entry.tree_digest)
  if (blob === null) {
    warn(`vx/reapi: could not read the Tree for ${entry.path} — recording it whole`)
    return whole
  }
  // Keyed by the WORKER's own bytes, not by re-encoding our parse of them —
  // see decodeTreeWithBytes. Re-encoding resolved 4 of 649 directories here.
  const tree = decodeTreeWithBytes(blob)
  if (tree.root === undefined) return whole
  const byDigest = new Map<string, Directory>()
  tree.children.forEach((c, i) => byDigest.set(tree.childDigests[i]!, c))

  const out: Array<{ path: string; tree_digest: Digest }> = []
  const files: DecomposedOutputs['files'] = []
  const symlinks: DecomposedOutputs['symlinks'] = []
  const seen = new Set<string>()

  // Every transitive child of `dir`, which is what a Tree message must carry.
  const descendants = (dir: Directory, acc: Directory[] = []): Directory[] => {
    for (const d of dir.directories) {
      const child = byDigest.get(d.digest.hash)
      if (child === undefined) continue
      acc.push(child)
      descendants(child, acc)
    }
    return acc
  }

  const walk = (dir: Directory, segments: readonly string[], prefix: string): void => {
    if (segments.length === 0) {
      if (seen.has(prefix)) return
      seen.add(prefix)
      const data = encodeTree(dir, descendants(dir))
      out.push({ path: prefix, tree_digest: sha256(data), __data: data } as never)
      return
    }
    const [head, ...rest] = segments
    const matches = (name: string): boolean => head === '*' || name === head
    if (rest.length === 0) {
      for (const f of dir.files) {
        const at = `${prefix}/${f.name}`
        if (!matches(f.name) || seen.has(at)) continue
        seen.add(at)
        files.push({ path: at, digest: f.digest, is_executable: f.is_executable })
      }
      for (const sl of dir.symlinks) {
        const at = `${prefix}/${sl.name}`
        if (!matches(sl.name) || seen.has(at)) continue
        seen.add(at)
        symlinks.push({ path: at, target: sl.target })
      }
    }
    for (const d of dir.directories) {
      if (!matches(d.name)) continue
      const child = byDigest.get(d.digest.hash)
      if (child === undefined) continue
      walk(child, rest, `${prefix}/${d.name}`)
    }
  }

  for (const rest of wild) walk(tree.root, rest, entry.path)
  if (out.length + files.length + symlinks.length === 0) return whole

  // Upload the Tree blobs the new entries point at. ByteStream rather than a
  // batch: a Tree for a real dependency directory is megabytes, and batching
  // several into one message trips the server's own 4 MiB receive limit.
  for (const e of out) {
    const data = (e as unknown as { __data: Uint8Array }).__data
    const missing = await client.findMissingBlobs([e.tree_digest]).catch(() => [e.tree_digest])
    if (missing.length > 0) await client.writeBlob(e.tree_digest, data)
  }
  return {
    directories: out.map((e) => ({ path: e.path, tree_digest: e.tree_digest })),
    files,
    symlinks,
  }
}

interface DecomposedOutputs {
  directories: Array<{ path: string; tree_digest: Digest }>
  files: Array<{ path: string; digest: Digest; is_executable: boolean }>
  symlinks: Array<{ path: string; target: string }>
}

/** `ExecuteRequest.inputs` past the executor's own undefined guard. Derived
 *  rather than imported: the façade does not export `TaskInputs`, and widening
 *  it for one alias is the speculative widening the project rejects. */
type DescribedInputs = NonNullable<ExecuteRequest['inputs']>

/** Message text from an unknown throw, for a warning line. */
function errText(err: unknown): string {
  return err instanceof Error ? err.message.split('\n')[0]! : String(err)
}

interface DecodedExecuteResponse {
  result?: ActionResult
  message?: string
  cachedResult?: boolean
  status?: { code: number; message: string }
  /** name → log blob; fetched and surfaced when the action FAILS. */
  serverLogs: Array<{ name: string; digest: Digest; humanReadable: boolean }>
}

/** REAPI's ExecuteResponse arrives packed in an Any; hand-decoded (proto-loader
 *  exposes no decoder for an arbitrary packed type). */
function decodeExecuteResponse(op: Operation): DecodedExecuteResponse {
  const value = op.response?.value
  if (value === undefined || value.length === 0) return { serverLogs: [] }
  return decodeExecuteResponseBytes(value)
}

/**
 * `ExecuteResponse { result = 1, cached_result = 2, status = 3,
 *                    server_logs = 4 (map<string, LogFile>), message = 5 }`
 */
export function decodeExecuteResponseBytes(buf: Uint8Array): DecodedExecuteResponse {
  const out: DecodedExecuteResponse = { serverLogs: [] }
  let i = 0
  while (i < buf.length) {
    const [key, k] = readVarint(buf, i)
    i = k
    const field = key >>> 3
    const wire = key & 7
    if (wire === 2) {
      const [len, l] = readVarint(buf, i)
      i = l
      const slice = buf.subarray(i, i + len)
      i += len
      if (field === 1) out.result = decodeActionResult(slice)
      else if (field === 3) out.status = decodeRpcStatus(slice)
      else if (field === 4) {
        const entry = decodeLogEntry(slice)
        if (entry !== undefined) out.serverLogs.push(entry)
      } else if (field === 5) out.message = new TextDecoder().decode(slice)
    } else if (wire === 0) {
      const [v, n] = readVarint(buf, i)
      i = n
      if (field === 2) out.cachedResult = v === 1
    } else if (wire === 5) i += 4
    else if (wire === 1) i += 8
    else break
  }
  return out
}

/** `google.rpc.Status { code = 1, message = 2 }` */
function decodeRpcStatus(buf: Uint8Array): { code: number; message: string } {
  const st = { code: 0, message: '' }
  let i = 0
  while (i < buf.length) {
    const [key, k] = readVarint(buf, i)
    i = k
    const field = key >>> 3
    const wire = key & 7
    if (wire === 0) {
      const [v, n] = readVarint(buf, i)
      i = n
      if (field === 1) st.code = v
    } else if (wire === 2) {
      const [len, l] = readVarint(buf, i)
      i = l
      if (field === 2) st.message = new TextDecoder().decode(buf.subarray(i, i + len))
      i += len
    } else break
  }
  return st
}

/** One `server_logs` map entry: `{ key = 1 (string), value = 2 (LogFile{digest=1, human_readable=2}) }` */
function decodeLogEntry(
  buf: Uint8Array,
): { name: string; digest: Digest; humanReadable: boolean } | undefined {
  let name = ''
  let digest: Digest | undefined
  let humanReadable = false
  let i = 0
  while (i < buf.length) {
    const [key, k] = readVarint(buf, i)
    i = k
    if ((key & 7) !== 2) break
    const [len, l] = readVarint(buf, i)
    i = l
    const slice = buf.subarray(i, i + len)
    i += len
    if (key >>> 3 === 1) name = new TextDecoder().decode(slice)
    else if (key >>> 3 === 2) {
      let j = 0
      while (j < slice.length) {
        const [k2, j2] = readVarint(slice, j)
        j = j2
        if ((k2 & 7) === 2) {
          const [len2, j3] = readVarint(slice, j)
          j = j3
          if (k2 >>> 3 === 1) digest = decodeDigest(slice.subarray(j, j + len2))
          j += len2
        } else if ((k2 & 7) === 0) {
          const [v, j3] = readVarint(slice, j)
          j = j3
          if (k2 >>> 3 === 2) humanReadable = v === 1
        } else break
      }
    }
  }
  return digest === undefined ? undefined : { name, digest, humanReadable }
}

function decodeActionResult(buf: Uint8Array): ActionResult {
  const res: ActionResult = {}
  let i = 0
  while (i < buf.length) {
    const [key, k] = readVarint(buf, i)
    i = k
    const field = key >>> 3
    const wire = key & 7
    if (wire === 0) {
      const [v, n] = readVarint(buf, i)
      i = n
      if (field === 4) res.exit_code = v | 0
    } else if (wire === 2) {
      const [len, l] = readVarint(buf, i)
      i = l
      const slice = buf.subarray(i, i + len)
      i += len
      // Field numbers TRANSCRIBED FROM THE PROTO, not from memory — the
      // first version of this decoder guessed them and read output_files
      // (2) as output_directories, stdout_raw (5) as a digest, and so on:
      // a decoder that parses garbage without ever erroring.
      if (field === 2) (res.output_files ??= []).push(decodeOutputFile(slice))
      else if (field === 3) (res.output_directories ??= []).push(decodeOutputDirectory(slice))
      else if (field === 5) res.stdout_raw = slice
      else if (field === 6) res.stdout_digest = decodeDigest(slice)
      else if (field === 7) res.stderr_raw = slice
      else if (field === 8) res.stderr_digest = decodeDigest(slice)
      else if (field === 9) res.execution_metadata = decodeExecutedActionMetadata(slice)
      else if (field === 12) (res.output_symlinks ??= []).push(decodeOutputSymlink(slice))
    } else if (wire === 5) i += 4
    else if (wire === 1) i += 8
    else break
  }
  return res
}

/** `OutputFile { path = 1, digest = 2, is_executable = 4, contents = 5 }` —
 *  `contents` is populated when the request named the file in
 *  `inline_output_files`, sparing a CAS fetch. */
function decodeOutputFile(buf: Uint8Array): {
  path: string
  digest: Digest
  is_executable?: boolean
  contents?: Uint8Array
} {
  const out: { path: string; digest: Digest; is_executable: boolean; contents?: Uint8Array } = {
    path: '',
    digest: { hash: '', size_bytes: 0 },
    is_executable: false,
  }
  let i = 0
  while (i < buf.length) {
    const [key, k] = readVarint(buf, i)
    i = k
    const field = key >>> 3
    const wire = key & 7
    if (wire === 2) {
      const [len, l] = readVarint(buf, i)
      i = l
      const slice = buf.subarray(i, i + len)
      i += len
      if (field === 1) out.path = new TextDecoder().decode(slice)
      else if (field === 2) out.digest = decodeDigest(slice)
      else if (field === 5 && len > 0) out.contents = slice
    } else if (wire === 0) {
      const [v, n] = readVarint(buf, i)
      i = n
      if (field === 4) out.is_executable = v === 1
    } else break
  }
  return out
}

/** `OutputSymlink { path = 1, target = 2 }` */
function decodeOutputSymlink(buf: Uint8Array): { path: string; target: string } {
  const out = { path: '', target: '' }
  let i = 0
  while (i < buf.length) {
    const [key, k] = readVarint(buf, i)
    i = k
    if ((key & 7) !== 2) break
    const [len, l] = readVarint(buf, i)
    i = l
    const slice = buf.subarray(i, i + len)
    i += len
    if (key >>> 3 === 1) out.path = new TextDecoder().decode(slice)
    else if (key >>> 3 === 2) out.target = new TextDecoder().decode(slice)
  }
  return out
}

/**
 * `ExecutedActionMetadata { worker = 1, queued_timestamp = 2,
 *   worker_start = 3, worker_completed = 4, input_fetch_start = 5,
 *   input_fetch_completed = 6, execution_start = 7, execution_completed = 8 }`
 * Timestamps decode to epoch seconds — enough for phase attribution.
 */
function decodeExecutedActionMetadata(
  buf: Uint8Array,
): NonNullable<ActionResult['execution_metadata']> {
  const meta: NonNullable<ActionResult['execution_metadata']> = {}
  let i = 0
  while (i < buf.length) {
    const [key, k] = readVarint(buf, i)
    i = k
    const field = key >>> 3
    const wire = key & 7
    if (wire === 2) {
      const [len, l] = readVarint(buf, i)
      i = l
      const slice = buf.subarray(i, i + len)
      i += len
      if (field === 1) meta.worker = new TextDecoder().decode(slice)
      else if (field === 7) meta.execution_start_timestamp = decodeTimestamp(slice)
      else if (field === 8) meta.execution_completed_timestamp = decodeTimestamp(slice)
    } else if (wire === 0) {
      const [, n] = readVarint(buf, i)
      i = n
    } else break
  }
  return meta
}

/** `google.protobuf.Timestamp { seconds = 1, nanos = 2 }` */
function decodeTimestamp(buf: Uint8Array): { seconds?: string; nanos?: number } {
  const ts: { seconds?: string; nanos?: number } = {}
  let i = 0
  while (i < buf.length) {
    const [key, k] = readVarint(buf, i)
    i = k
    if ((key & 7) !== 0) break
    const [v, n] = readVarint(buf, i)
    i = n
    if (key >>> 3 === 1) ts.seconds = String(v)
    else if (key >>> 3 === 2) ts.nanos = v
  }
  return ts
}

/** `OutputDirectory { path = 1, tree_digest = 3, is_topologically_sorted = 4,
 *                      root_directory_digest = 5 }` — field 2 is RESERVED,
 *  which is exactly the trap a from-memory decoder falls into. */
function decodeOutputDirectory(buf: Uint8Array): { path: string; tree_digest: Digest } {
  const out = { path: '', tree_digest: { hash: '', size_bytes: 0 } }
  let i = 0
  while (i < buf.length) {
    const [key, k] = readVarint(buf, i)
    i = k
    const field = key >>> 3
    const wire = key & 7
    if (wire === 0) {
      const [, n] = readVarint(buf, i)
      i = n
      continue
    }
    if (wire !== 2) break
    const [len, l] = readVarint(buf, i)
    i = l
    const slice = buf.subarray(i, i + len)
    i += len
    if (field === 1) out.path = new TextDecoder().decode(slice)
    else if (field === 3) out.tree_digest = decodeDigest(slice)
  }
  return out
}

function decodeDigest(buf: Uint8Array): Digest {
  const d: Digest = { hash: '', size_bytes: 0 }
  let i = 0
  while (i < buf.length) {
    const [key, k] = readVarint(buf, i)
    i = k
    const field = key >>> 3
    const wire = key & 7
    if (wire === 2) {
      const [len, l] = readVarint(buf, i)
      i = l
      if (field === 1) d.hash = new TextDecoder().decode(buf.subarray(i, i + len))
      i += len
    } else if (wire === 0) {
      const [v, n] = readVarint(buf, i)
      i = n
      if (field === 2) d.size_bytes = v
    } else break
  }
  return d
}

function readVarint(buf: Uint8Array, at: number): [number, number] {
  let result = 0
  let shift = 0
  let i = at
  for (;;) {
    const byte = buf[i++]
    if (byte === undefined) return [result, i]
    result |= (byte & 0x7f) << shift
    if ((byte & 0x80) === 0) break
    shift += 7
  }
  return [result >>> 0, i]
}

/**
 * Backstop for an action the server never finishes. Generous on purpose: it
 * exists so a wedged remote cannot hang a run forever, not to police slow
 * builds — a task that knows its own bound should declare `exec.timeout`,
 * which takes precedence.
 */
const DEFAULT_EXECUTE_TIMEOUT_MS = 600_000

export interface ReapiExecutorOptions {
  /**
   * Client-side bound on a single action, measured from the EXECUTING
   * transition (time spent QUEUED behind a busy pool is legitimate and is not
   * counted). Overridden per task by `exec.timeout`. Defaults to 10 minutes.
   */
  executeTimeoutMs?: number
  /** REAPI platform properties (`container-image`, `OSFamily`, …). */
  platform?: Record<string, string>
  /** How many tasks this executor runs at once; becomes the scheduler's pool. */
  capacity?: number
  /** `ExecutionPolicy.priority` — lower runs sooner on a contended pool. */
  priority?: number
  /** `Action.salt` — force distinct cache entries without changing the work. */
  salt?: string
  warn?: (message: string) => void
}

/**
 * A task is remote-eligible only if vx can DESCRIBE its inputs — that is the
 * miss path of a cacheable task. A task with no `cache` block ships nothing,
 * so a worker would run it against an empty input root and produce garbage:
 * decline it and let a later executor (the local one) take it.
 */
export function acceptsTask(task: TaskPlacement): boolean {
  return task.cacheable && !task.pinnedLocal
}

export function reapiExecutor(client: ReapiClient, opts: ReapiExecutorOptions = {}): TaskExecutor {
  const warn = opts.warn ?? (() => undefined)
  // One Capabilities round trip per executor, not per task — the answer
  // cannot change mid-run, and a 400-task graph would otherwise ask 400 times.
  let capsPromise: ReturnType<ReapiClient['capabilities']> | undefined
  const capabilitiesOnce = (): ReturnType<ReapiClient['capabilities']> =>
    (capsPromise ??= client.capabilities())
  const executor: TaskExecutor = {
    name: 'vx/reapi',
    remote: true,
    ...(opts.capacity === undefined ? {} : { capacity: opts.capacity }),
    accepts: acceptsTask,
    async execute(req: ExecuteRequest): Promise<ExecuteResult> {
      const started = Bun.nanoseconds()
      // `inputs` is guaranteed by `accepts` (cacheable ⇒ the miss path
      // describes them); the guard is for a host that bypasses placement.
      // The ONLY plain Error left in this file: a host that routed an
      // undescribed task here violated core's own placement contract, which
      // is a vx bug and should read as one. Everything else that throws is
      // the remote store or the server misbehaving — a UserError (a raw gRPC
      // status is turned into one by `namedRefusal`), so the scheduler
      // prints it plainly instead of "internal error in <task>".
      if (req.inputs === undefined) {
        throw new Error(
          `vx/reapi: ${req.taskId} reached the remote executor with no described inputs`,
        )
      }

      // A key that already has an execution record needs no worker at all:
      // the record IS this task's entry, and its outputs are in the CAS.
      // Two shapes reach here. `remote: 'only'` — the repeat-run path for
      // `install`, once per lockfile change, ever. And any DEFERRED
      // producer: deferral writes no local entry, so vx's own probe misses
      // on every later run and the record is what makes the second run
      // cheap. `--force` reaches this through `refresh` and skips it — a
      // private cache that ignores the flag is still a cache.
      if (req.cacheKey !== undefined && req.refresh !== true) {
        // A CACHE READ, and nothing more: the record is a shortcut past the
        // worker, so a transport failure here means "no usable record", never
        // "this task failed". Core's standing rule is that a remote cache
        // error degrades to a MISS, and an executor that instead propagates
        // one turns a degraded server into a red build — observed against a
        // NativeLink that had stopped answering AC hits, where every task
        // died on the deadline rather than simply re-running.
        //
        // Deliberately NOT extended to the UPSTREAM record reads below. Those
        // decide whether a dependency's bytes exist at all, and treating a
        // failure there as "carry on" is how an action runs without its
        // inputs and caches the result.
        const prior = await client.getActionResult(execDigestFor(req.cacheKey)).catch((err) => {
          warn(
            `vx/reapi: ${req.taskId} could not read its execution record (${errText(err)}) — executing`,
          )
          return null
        })
        if (prior !== null) {
          const referenced = [
            ...(prior.output_files ?? []).map((f) => f.digest),
            ...(prior.output_directories ?? []).map((d) => d.tree_digest),
          ]
          // AC and CAS evict independently, so a record can outlive its
          // blobs. A gap means it cannot produce the outputs — fall through
          // and execute for real rather than "succeed" with nothing.
          // Same reasoning: if the completeness probe cannot run, the record
          // is unusable, which is a miss. `[]` would mean "nothing missing"
          // and would replay a record whose blobs were never checked.
          const gone =
            referenced.length > 0
              ? await client.findMissingBlobs(referenced).catch(() => referenced)
              : []
          // The record's paths are WORKSPACE-relative (rebased when it was
          // written), so the anchor is the workspace root, not the cwd.
          const fromRecord = (created?: string[]): Promise<void> =>
            materialiseOutputs(
              client,
              {
                ...req,
                cwd: req.workspaceRoot,
                projectRel: toPosix(path.relative(req.workspaceRoot, req.cwd)),
                // A blob the probe could not see (one inside a Tree, which
                // `FindMissingBlobs` checks only by the Tree's digest) was
                // replayed as a warning under a whole-tree capture: the task
                // succeeded, a declared output missing, on every run.
                replay: true,
              },
              prior,
              warn,
              created,
            )
          const deferRecord = req.remoteOnly !== true && req.download === 'deferred'
          // The replay is still the cache read: a Read that fails on its
          // stdout or on any output is a record that cannot be served, and
          // the task executes. Core cleaned the declared outputs once, before
          // this call, and does not again, so a replay that wrote part of the
          // tree takes back what it CREATED — a real run that does not write
          // those paths must not have them saved as its outputs. What it
          // overwrote was on disk before (a whole-tree capture lists the
          // inputs) and stays.
          const created: string[] = []
          const replay = async (): Promise<string> => {
            const stdout = await this_readStream(client, prior.stdout_raw, prior.stdout_digest)
            if (req.remoteOnly !== true && !deferRecord) await fromRecord(created)
            return stdout
          }
          const priorStdout =
            gone.length > 0
              ? null
              : await replay().catch(async (err: unknown) => {
                  for (const p of created.reverse()) await rm(p, { recursive: true, force: true })
                  warn(
                    `vx/reapi: ${req.taskId} could not replay its execution record (${errText(err)}) — executing`,
                  )
                  return null
                })
          if (priorStdout !== null) {
            // Delivered whatever `capture` says, as on the execute path below:
            // a deferred producer saves nothing, so its replay had printed
            // nothing at all (item 827). Only once the replay has landed, so
            // a replay that falls through does not print twice.
            if (priorStdout.length > 0) req.onStdout(priorStdout)
            return {
              exitCode: 0,
              durationMs: Math.round((Bun.nanoseconds() - started) / 1e6),
              stdout: req.capture.stdout === false ? '' : priorStdout,
              stderr: '',
              violations: [],
              ...(deferRecord
                ? { outputs: { kind: 'deferred' as const, materialize: () => fromRecord() } }
                : {}),
            }
          }
        }
      }

      const projectRel = toPosix(path.relative(req.workspaceRoot, req.cwd))
      // REAPI `output_paths` are relative to `working_directory`, so a
      // ROOT-anchored output (`cache.outputs.workspaceFiles`) declared by a
      // NESTED project can only be spelled with `..` — `packages/vx/../..
      // /node_modules`. The spec allows `..` in SYMLINK targets but servers
      // are entitled to refuse it in output paths, and NativeLink does
      // ("Could not convert path contains non-relative component to
      // RelativePath"). So when a task declares one, run the action at the
      // INPUT ROOT and `cd` into the project instead: every output path is
      // then root-relative and no `..` is ever emitted. Tasks with only
      // project-relative outputs keep the narrower working directory.
      // A wildcard in the MIDDLE of a root-anchored output
      // (`packages/*/node_modules`) still collapses to its static prefix
      // here, because REAPI output paths are literal. That used to be
      // dangerous — the whole `packages` directory came back and REPLACED the
      // sources in every consumer's input tree — so the globs were expanded
      // against the submitter's filesystem first. They are not any more:
      // grafts MERGE into the input tree (see buildInputTree), so a broad
      // capture folds in alongside what a consumer declared instead of over
      // it. Expanding was also impure — it made the action digest depend on
      // which directories happened to exist on the machine that submitted it.
      const outReq: ExecuteRequest = req
      const rootAnchored = req.outputs.workspaceFiles.length > 0
      const workingDirectory = rootAnchored ? '' : projectRel
      // The server reports output paths relative to `working_directory`, so
      // in root mode materialisation anchors at the workspace root — the same
      // rebase the record-replay path above already does for its own reason.
      const matReq = rootAnchored ? { ...req, cwd: req.workspaceRoot, projectRel } : req

      // Upstream outputs reach this action's input root one of two ways.
      // PREFERRED: by REFERENCE — the upstream executed remotely and left an
      // execution record (per-file digests, workspace-relative paths) under
      // its vx key, so its bytes flow worker→CAS→worker and never transit
      // this machine. FALLBACK: from local disk (the upstream ran locally, so
      // core restored its outputs here before this task started).
      const fileGrafts: FileGraft[] = []
      const treeGrafts: TreeGraft[] = []
      const symlinkGrafts: { path: string; target: string }[] = []
      const localUpstreamPaths: string[] = []
      for (const up of req.inputs.upstream) {
        // LOCAL DISK IS TRUTH when the upstream's outputs are materialised
        // here (core restored or produced them before this task started).
        // Grafting from the remote execution record instead can DIVERGE: two
        // machines racing a nondeterministic miss leave the artifact store
        // and the execution record holding results of DIFFERENT executions
        // under one pure-input key, and a worker fed the record would see
        // bytes this machine's own tasks do not. The graft is for outputs
        // that exist nowhere locally — a remote-only upstream.
        // "Materialised here" has to be CHECKED, not assumed. `up.outputs`
        // comes from the local index, which records what an entry contains —
        // not whether those files are on this disk right now. A task whose
        // producer ran remotely and did not bring its outputs home has index
        // rows and no files, and the tree build then dies on `stat` with
        // ENOENT naming a path the user never asked about. When they are
        // genuinely absent, the record graft is the correct source, which is
        // the branch below.
        const present = up.outputs.filter((rel) => existsSync(path.join(req.workspaceRoot, rel)))
        if (present.length > 0) {
          if (present.length !== up.outputs.length) {
            warn(
              `vx/reapi: ${up.taskId} has ${up.outputs.length - present.length} output(s) recorded ` +
                `but missing on disk — grafting is not possible for a partial set, using what is here`,
            )
          }
          localUpstreamPaths.push(...present)
          continue
        }
        const record = await client.getActionResult(execDigestFor(up.hash))
        if (record === null) continue
        // A record can OUTLIVE its blobs: the AC and the CAS evict on
        // independent schedules. On THIS branch nothing is local (that is
        // why we are grafting), so an evicted blob has no local path to
        // demote to — the declared upstream's outputs exist NOWHERE. An
        // action shipped without them is not a degraded build, it is a
        // different one: a command that tolerates the absence exits 0, and
        // vx caches that result under a key asserting those inputs were
        // present. Which upstream bytes a command reads is unknowable —
        // that is what `dependsOn` declares — so refuse, exactly as core's
        // own materialisation path does. Verified in one round trip.
        const referenced = [
          ...(record.output_files ?? []).map((f) => f.digest),
          ...(record.output_directories ?? []).map((d) => d.tree_digest),
        ]
        const gone = await client.findMissingBlobs(referenced)
        if (gone.length > 0) {
          throw new UserError(
            `vx/reapi: upstream ${up.taskId} outputs evicted from the remote store (${gone.length} blob(s)) and never materialised locally — re-run it (e.g. --force)`,
          )
        }
        for (const f of record.output_files ?? []) {
          fileGrafts.push({
            path: f.path, // recorded workspace-relative — see the record write below
            digest: f.digest,
            isExecutable: f.is_executable === true,
          })
        }
        // A record's symlinks are outputs too (a worker's own, and a glob's
        // last-segment matches since item 911); without them the action ran
        // without an input it declared, and its result was cached (item 920).
        for (const sl of record.output_symlinks ?? []) {
          symlinkGrafts.push({ path: sl.path, target: sl.target })
        }
        for (const d of record.output_directories ?? []) {
          const treeBlob = await client.readBlob(d.tree_digest)
          if (treeBlob === null) {
            // Raced an eviction between the completeness check and this
            // read; on this branch no local copy exists, so the loss is
            // real and silently dropping the graft is the same wrong-result
            // hazard as an evicted file.
            throw new UserError(
              `vx/reapi: upstream ${up.taskId} tree ${d.tree_digest.hash.slice(0, 12)} evicted from CAS — re-run it (e.g. --force)`,
            )
          }
          const decodedTree = decodeTreeWithBytes(treeBlob)
          if (decodedTree.root === undefined) continue
          treeGrafts.push({
            path: d.path,
            root: decodedTree.root,
            children: decodedTree.children,
            childDigests: decodedTree.childDigests,
          })
        }
      }

      // The key folds the project's package.json whether or not a glob
      // lists it, so the worker sees it too: a `"type": "module"` changes
      // what a bundler emits, and a tree without it ran as another task.
      const expected = new Map(req.inputs.files.map((f) => [f.path, f.digest]))
      const packageJson = projectRel === '' ? 'package.json' : `${projectRel}/package.json`
      if (req.inputs.packageJsonDigest !== '' && !expected.has(packageJson)) {
        expected.set(packageJson, req.inputs.packageJsonDigest)
      }
      const inputPaths = [...expected.keys(), ...localUpstreamPaths]
      const tree = await buildInputTree({
        expected,
        workspaceRoot: req.workspaceRoot,
        paths: inputPaths,
        // The working directory must exist in the input root (REAPI
        // requirement) even for a task with no file inputs at all. The
        // PROJECT dir is ensured too, and separately: in root-anchored mode
        // the action's working directory is the input root and the command
        // `cd`s into the project instead, so a task whose declared inputs
        // all live outside its own directory would otherwise `cd` into a
        // directory the tree never created. Outside root mode the two are
        // the same path and ensureDirs dedupes.
        ensureDirs: [workingDirectory, projectRel],
        fileGrafts,
        treeGrafts,
        symlinkGrafts,
      })
      // The tree is read after the key was taken. Bytes that moved in
      // between (an edit mid-run, `vx watch`) run as this action but must
      // not be recorded under the key: restored to the keyed state, the
      // next run anywhere replayed the edited outputs (item 1037).
      if (tree.moved.length > 0) {
        warn(
          `vx/reapi: ${req.taskId}: \`${tree.moved[0]}\` changed after its key was taken — the execution is not recorded under it`,
        )
      }
      for (const shadowedPath of tree.shadowed) {
        warn(
          `vx/reapi: ${req.taskId} declares input files under ${shadowedPath}, which an upstream graft replaces — those files are NOT in the input tree`,
        )
      }

      const platformProps = Object.entries(opts.platform ?? {}).map(([name, value]) => ({
        name,
        value,
      }))
      const outputs = outputPathSets(outReq, workingDirectory, projectRel)
      const command = {
        // `sh -c` matches vx's contract exactly: shell IS the API, so the
        // worker must interpret the string the same way the local executor's
        // spawn does.
        arguments: ['/bin/sh', '-c', fullCommand(req, rootAnchored ? projectRel : '', projectRel)],
        environmentVariables: commandEnvironment(req.inputs, req.envDefine, req.env),
        outputPaths: outputs.outputPaths,
        // Both generations of the field are set: a v2.1+ server reads
        // output_paths and ignores the legacy pair; a v2.0 server does the
        // inverse. One Command works against either.
        legacyOutputFiles: outputs.legacyFiles,
        legacyOutputDirectories: outputs.legacyDirectories,
        workingDirectory,
        platform: platformProps,
      }
      const commandBytes = encodeCommand(command)
      const commandDigest = sha256(commandBytes)
      const actionBytes = encodeAction({
        commandDigest,
        inputRootDigest: tree.root,
        ...(req.timeoutMs === undefined ? {} : { timeoutSeconds: Math.ceil(req.timeoutMs / 1000) }),
        // v2.2 moved platform onto Action; Command still carries it for older
        // servers, so both are set and they must agree.
        ...(platformProps.length === 0 ? {} : { platform: platformProps }),
        ...(opts.salt === undefined ? {} : { salt: new TextEncoder().encode(opts.salt) }),
      })
      const actionDigest = sha256(actionBytes)

      const caps = await capabilitiesOnce()
      const upload: Blob[] = [
        ...tree.blobs,
        { digest: commandDigest, data: commandBytes },
        { digest: actionDigest, data: actionBytes },
      ]
      await client.uploadBlobs(upload, caps.maxBatchBytes)

      // The action id lets a server group this action's CAS/AC traffic in its
      // UI; set before Execute so the streaming call carries it too.
      client.actionId = actionDigest.hash
      // `exec.timeout` rides the Action so the SERVER can enforce it, but a
      // server that ignores it — or has stopped making progress at all —
      // leaves the client waiting forever, and the operation stream is no
      // help: a stalled NativeLink kept sending EXECUTING heartbeats for
      // eighteen minutes while its worker sat blocked, so neither a total
      // deadline nor an inactivity one would have fired. The task's own
      // declared timeout is the honest bound, and enforcing it here makes it
      // mean the same thing wherever the task runs.
      //
      // Clocked from the EXECUTING transition, not from submission: time
      // spent QUEUED behind a busy pool is legitimate and unbounded, which is
      // why `execute` carries no deadline of its own.
      const stallAfter = req.timeoutMs ?? opts.executeTimeoutMs ?? DEFAULT_EXECUTE_TIMEOUT_MS
      const stall = new AbortController()
      let stallTimer: ReturnType<typeof setTimeout> | undefined
      const armStall = (): void => {
        if (stallTimer !== undefined) return
        stallTimer = setTimeout(() => stall.abort(), stallAfter)
      }
      // The run's stop (Ctrl-C, an embedder's abort) cancels the operation
      // stream as the stall does; unheard, vx waited on the remote for as
      // long as the action ran.
      const stop =
        req.signal === undefined ? stall.signal : AbortSignal.any([stall.signal, req.signal])
      let op: Operation
      try {
        if (req.signal?.aborted === true) throw new Error('aborted before Execute')
        op = await client.execute(
          actionDigest,
          {
            ...(opts.priority === undefined ? {} : { priority: opts.priority }),
            // Stage transitions are consumed, not printed: they arrive many
            // times per action and said nothing a reader could act on.
            onStage: (stage) => {
              if (stage.toUpperCase() === 'EXECUTING') armStall()
            },
          },
          stop,
        )
      } catch (err) {
        if (req.signal?.aborted === true) {
          throw new UserError(
            `vx/reapi: ${req.taskId}: the run stopped before its remote execution finished`,
          )
        }
        if (stall.signal.aborted) {
          throw new UserError(
            `vx/reapi: ${req.taskId} was still executing ${stallAfter}ms after the worker ` +
              `started it and the server never reported a result — giving up on the remote ` +
              `operation. Raise exec.timeout (or the plugin's executeTimeoutMs) if the task ` +
              `is legitimately this slow; otherwise the remote is not making progress.`,
          )
        }
        throw err
      } finally {
        if (stallTimer !== undefined) clearTimeout(stallTimer)
      }
      if (op.error !== undefined && (op.error.code ?? 0) !== 0) {
        throw new UserError(
          `vx/reapi: execution failed for ${req.taskId}: ${op.error.message ?? `code ${op.error.code}`}`,
        )
      }
      const decoded = decodeExecuteResponse(op)
      const { result } = decoded
      // A non-OK ExecuteResponse.status means the EXECUTION failed (not the
      // command): surface the server's message and its logs, which are the
      // only diagnostics that exist for a worker-side failure.
      if (decoded.status !== undefined && decoded.status.code !== 0) {
        const logs = await fetchServerLogs(client, decoded.serverLogs)
        throw new UserError(
          `vx/reapi: ${req.taskId} execution failed: ${decoded.status.message || `code ${decoded.status.code}`}` +
            (decoded.message === undefined ? '' : ` — ${decoded.message}`) +
            logs,
        )
      }
      if (result === undefined) {
        throw new UserError(
          `vx/reapi: ${req.taskId} returned no ActionResult${decoded.message === undefined ? '' : `: ${decoded.message}`}`,
        )
      }
      // The worker id is REPORTED, not logged: it rides `ExecuteResult.where`
      // into telemetry, where a consumer can attribute a task to a machine.
      // A line per task said the same thing to everyone, every run.
      const worker = result.execution_metadata?.worker

      const [stdout, stderr] = await Promise.all([
        this_readStream(client, result.stdout_raw, result.stdout_digest),
        this_readStream(client, result.stderr_raw, result.stderr_digest),
      ])
      // DELIVERY is unconditional; `capture` governs RETENTION only. Core
      // sets `capture: { stdout: willWrite, stderr: false }` meaning "do not
      // keep a copy in memory" — the local executor still streams both to the
      // logger chunk-by-chunk regardless. Gating delivery on it here meant a
      // failing REMOTE task printed an EMPTY frame, because a remote task has
      // no live stream and this callback is the only path its output has.
      // `bun install` reporting on stderr was invisible.
      if (stdout.length > 0) req.onStdout(stdout)
      if (stderr.length > 0) req.onStderr(stderr)

      // Record the execution under the task's vx key, output paths rewritten
      // WORKSPACE-relative (the raw result's are working-directory-relative)
      // so a dependent in ANY project can graft them at the right place.
      // Written for every successful remote execution, not just remote-only
      // tasks: it is what lets a 50-task chain flow worker→CAS→worker.
      if (req.cacheKey !== undefined && (result.exit_code ?? 0) === 0 && tree.moved.length === 0) {
        // A whole-tree capture's path is '' — the working directory itself,
        // which `${wd}/` spelled `pkg/`: never matched by a decomposition,
        // and grafted as a directory with an empty name (item 1040).
        const rebase = (rel: string): string =>
          workingDirectory === ''
            ? rel
            : rel === ''
              ? workingDirectory
              : `${workingDirectory}/${rel}`
        // Stdout rides the record as a blob so a short-circuited repeat run
        // can replay it. Best-effort: a record without it replays empty,
        // never wrong bytes.
        let stdoutDigest: Digest | undefined
        const stdoutBytes = new TextEncoder().encode(stdout)
        if (stdoutBytes.length > 0) {
          const d = sha256(stdoutBytes)
          const missing = await client.findMissingBlobs([d]).catch(() => [d])
          const uploaded =
            missing.length === 0
              ? true
              : await client.writeBlob(d, stdoutBytes).then(
                  () => true,
                  () => false,
                )
          if (uploaded) stdoutDigest = d
        }
        // A coarse capture is split into the paths its glob really names
        // before it is recorded — see decomposeOutputDir.
        const declaredGlobs = [
          ...req.outputs.workspaceFiles,
          ...req.outputs.files.map((g) => (projectRel === '' ? g : `${projectRel}/${g}`)),
        ].map((g) => normalizeGlob(g))
        const recorded: DecomposedOutputs = {
          directories: [],
          files: (result.output_files ?? []).map((f) => ({
            path: rebase(f.path),
            digest: f.digest,
            is_executable: f.is_executable === true,
          })),
          symlinks: (result.output_symlinks ?? []).map((sl) => ({
            path: rebase(sl.path),
            target: sl.target,
          })),
        }
        for (const d of result.output_directories ?? []) {
          const rebased = { path: rebase(d.path), tree_digest: d.tree_digest }
          // The record is best-effort like its write below: a Read that
          // fails while splitting failed a task whose action had succeeded.
          const split = await decomposeOutputDir(client, rebased, declaredGlobs, warn).catch(
            (err: unknown) => {
              warn(
                `vx/reapi: could not read the Tree for ${rebased.path} (${errText(err)}) — recording it whole`,
              )
              return { directories: [rebased], files: [], symlinks: [] }
            },
          )
          recorded.directories.push(...split.directories)
          recorded.files.push(...split.files)
          recorded.symlinks.push(...split.symlinks)
        }
        await client
          .updateActionResult(execDigestFor(req.cacheKey), {
            exit_code: 0,
            ...(stdoutDigest === undefined ? {} : { stdout_digest: stdoutDigest }),
            output_files: recorded.files,
            output_directories: recorded.directories,
            output_symlinks: recorded.symlinks,
          })
          .catch((err: Error) =>
            warn(`vx/reapi: could not record execution for ${req.taskId}: ${err.message}`),
          )
      }

      // A remote-only task's outputs stay remote — materialising node_modules
      // onto the submitter's disk is precisely what `remote: 'only'` forbids.
      // `--download=none` defers the same transfer WITHOUT making it
      // permanent: the bytes stay in the CAS and core gets a closure to pull
      // them if a locally-placed consumer turns out to need them.
      const deferred = req.remoteOnly !== true && req.download === 'deferred'
      if (req.remoteOnly !== true && !deferred) {
        await materialiseOutputs(client, matReq, result, warn)
      }

      return {
        exitCode: result.exit_code ?? 0,
        durationMs: Math.round((Bun.nanoseconds() - started) / 1e6),
        stdout: req.capture.stdout === false ? '' : stdout,
        stderr: req.capture.stderr === false ? '' : stderr,
        violations: [],
        ...(worker !== undefined && worker !== '' ? { where: worker } : {}),
        ...(deferred
          ? {
              outputs: {
                kind: 'deferred' as const,
                materialize: () => materialiseOutputs(client, matReq, result, warn),
              },
            }
          : {}),
      }
    },
  }
  const run = executor.execute.bind(executor)
  executor.execute = (req) =>
    run(req).catch((err: unknown) => {
      throw namedRefusal(req.taskId, err)
    })
  return executor
}

/**
 * A gRPC status that escaped `execute` (an Execute the server refused, an
 * upload or upstream read that failed) is the server's answer, not a vx bug.
 * It reached the scheduler as a plain Error and printed as "internal error
 * in <task>" (F-11); a UserError prints as the refusal it is.
 */
function namedRefusal(taskId: string, err: unknown): unknown {
  if (isUserError(err) || !(err instanceof Error)) return err
  const status = err as Error & { code?: unknown; details?: unknown }
  if (typeof status.code !== 'number' || typeof status.details !== 'string') return err
  return new UserError(`vx/reapi: ${taskId}: the remote server failed the call — ${err.message}`)
}

/**
 * Server logs are the only diagnostics a worker-side failure produces; fetch
 * the human-readable ones (bounded) and fold them into the thrown error.
 */
async function fetchServerLogs(
  client: ReapiClient,
  logs: ReadonlyArray<{ name: string; digest: Digest; humanReadable: boolean }>,
): Promise<string> {
  const readable = logs.filter((l) => l.humanReadable && l.digest.size_bytes <= 64 * 1024)
  if (readable.length === 0) return ''
  const parts: string[] = []
  for (const log of readable) {
    const bytes = await client.readBlob(log.digest).catch(() => null)
    if (bytes !== null)
      parts.push(`\n--- server log ${log.name} ---\n${new TextDecoder().decode(bytes)}`)
  }
  return parts.join('')
}

/**
 * stdout/stderr arrive inline OR as a CAS digest; servers choose.
 *
 * `null` is as real as `undefined` here: proto-loader hands back a NULL
 * message field for an absent `stdout_digest` on the `GetActionResult`
 * path, where the `Execute` path leaves it undefined. Reading only for
 * undefined dereferenced the null and crashed the whole execute call —
 * caught by the node_modules chain test the moment the record
 * short-circuit widened past `remote: 'only'`.
 */
async function this_readStream(
  client: ReapiClient,
  raw: Uint8Array | undefined,
  digest: Digest | undefined | null,
): Promise<string> {
  if (raw !== undefined && raw !== null && raw.length > 0) return new TextDecoder().decode(raw)
  if (digest !== undefined && digest !== null && digest.size_bytes > 0) {
    const bytes = await client.readBlob(digest)
    if (bytes !== null) return new TextDecoder().decode(bytes)
  }
  return ''
}

/** Forwarded args are appended shell-quoted, exactly as the local executor does. */
function fullCommand(req: ExecuteRequest, cdInto: string, projectRel: string): string {
  const quoted =
    req.forwardArgs.length === 0
      ? req.command
      : `${req.command} ${req.forwardArgs.map((a) => `'${a.replaceAll("'", `'\\''`)}'`).join(' ')}`
  // A remote action gets NO PATH from this machine — sending one would put a
  // host path in the action digest and split every laptop from every runner.
  // But a task's command is normally a package binary (`oxlint`, `tsc`), and
  // the local executor finds those because core prepends the project's
  // `node_modules/.bin` and the child inherits the caller's PATH. Neither
  // reaches a worker, so an unqualified command exits 127. Rebuild the same
  // two entries HERE, from `$PWD` at runtime: hermetic (nothing host-specific
  // enters the digest) and correct in both anchoring modes.
  //
  //   root-anchored → cwd IS the input root, so "$PWD" is the root
  //   otherwise     → cwd is the project, so climb back out of projectRel
  const climb =
    projectRel === ''
      ? ''
      : `/${projectRel
          .split('/')
          .map(() => '..')
          .join('/')}`
  const root = cdInto === '' ? `"$PWD${climb}"` : '"$PWD"'
  // Order matters: VX_ROOT is read BEFORE the cd, the project-local bin dir
  // AFTER it, so both are right whichever mode we are in.
  // Quoted as the forwarded args are: a project directory is a name like
  // any other, and `it's` ended the quote and ran the rest as script (L-7).
  const cd = cdInto === '' ? '' : `cd '${cdInto.replaceAll("'", `'\\''`)}' || exit 1; `
  return (
    `VX_ROOT=${root}; ${cd}` +
    `export PATH="$VX_ROOT/node_modules/.bin:$PWD/node_modules/.bin:$PATH"; ` +
    quoted
  )
}

/**
 * vx declares output GLOBS; REAPI `output_paths` are LITERAL paths. The
 * mapping the design doc prescribes: each glob contributes the deepest
 * literal prefix above its first wildcard (`dist/**` → `dist`,
 * `build/out-*.js` → `build`), a wildcard-free glob is itself the path, and
 * a glob whose FIRST segment already has the wildcard collapses to `''` —
 * which REAPI defines as "the entire working directory". Passing the raw
 * glob instead would name a file literally called `dist/**`, and the action
 * would return no outputs with no error anywhere.
 */
export function globToOutputPath(glob: string): string {
  const segments = glob.split('/')
  const literal: string[] = []
  for (const seg of segments) {
    if (!isLiteralPattern(seg)) break
    literal.push(seg)
  }
  if (literal.length === segments.length) return glob // no wildcard: a literal path
  return literal.join('/')
}

/**
 * The action's environment: `cache.inputs.env` (values read from THIS
 * machine's environment, already folded into the cache key) plus
 * `exec.env.define` (literals from the task config). A define wins on
 * collision — it is the more explicit statement of intent. An `inputs.env`
 * name crosses only when the local child gets the same value (`childEnv`,
 * the request's resolved environment): a name the config only TRACKS is in
 * the key but not the local child's environment, and shipping it ran the
 * worker on a value a local run never saw, under the same key (item 1092).
 * Nothing else from `childEnv` may cross: that is this machine's RESOLVED
 * environment (its PATH, HOME, TMPDIR), and shipping it would put
 * host-specific values into the action identity, splitting every machine
 * from every other.
 *
 * ORDER is deliberately not this function's business. The proto requires
 * environment_variables sorted by name so equivalent Commands hash alike, and
 * `encodeCommand` already sorts every Command it encodes — one owner, byte-
 * pinned against protobufjs. Sorting here too would be a second copy of the
 * same rule, and two copies of a canonicalisation agree until they don't.
 */
export function commandEnvironment(
  inputs: DescribedInputs,
  envDefine: Readonly<Record<string, string>>,
  childEnv: Readonly<Record<string, string | undefined>>,
): Array<{ name: string; value: string }> {
  const merged = new Map<string, string>()
  // An unset name stays unset in the action, as `passThrough` leaves it here:
  // shipping it as "" would run a different command than the key describes.
  for (const e of inputs.env) {
    if (e.value !== undefined && childEnv[e.name] === e.value) merged.set(e.name, e.value)
  }
  for (const [name, value] of Object.entries(envDefine)) merged.set(name, value)
  return [...merged].map(([name, value]) => ({ name, value }))
}

export interface OutputPathSets {
  /** v2.1+ `output_paths` — deduped, sorted. */
  outputPaths: string[]
  /** v2.0 legacy split: wildcard-free globs are files, prefix-derived are directories. */
  legacyFiles: string[]
  legacyDirectories: string[]
}

export function outputPathSets(
  req: ExecuteRequest,
  workingDirectory: string,
  projectRel = '',
): OutputPathSets {
  const rebase = (p: string): string =>
    workingDirectory === '' ? p : toPosix(path.relative(workingDirectory, p))
  // Mirror image of `rebase`: when the action runs at the input root, the
  // PROJECT-relative globs are the ones needing a prefix.
  const prefix = (p: string): string =>
    workingDirectory === '' && projectRel !== '' ? `${projectRel}/${p}` : p
  // Core's spelling first: `app/\[id\]/x` names the file `app/[id]/x` (item 667).
  const globs = [...req.outputs.files.map(prefix), ...req.outputs.workspaceFiles.map(rebase)].map(
    (g) => normalizeGlob(g),
  )
  const paths = new Set<string>()
  const files = new Set<string>()
  const dirs = new Set<string>()
  for (const glob of globs) {
    const literal = globToOutputPath(glob)
    paths.add(literal)
    // The legacy split has to GUESS what a path is; a wildcard-free glob was
    // declared as a file, a prefix cut at a wildcard is necessarily a dir.
    if (literal === glob) files.add(literal)
    else dirs.add(literal)
  }
  return {
    outputPaths: [...paths].sort(),
    legacyFiles: [...files].sort(),
    legacyDirectories: [...dirs].sort(),
  }
}

/**
 * A request as materialisation reads it: `cwd` is where the result's paths
 * are anchored, which is not the project when the action ran at the input
 * root or a record replays; `projectRel` then says where the project is.
 */
type MaterialiseRequest = ExecuteRequest & {
  readonly projectRel?: string
  /**
   * A record replay: it is a cache read, so a blob it cannot fetch fails it
   * (and the task executes) under any capture shape. Only a fresh result
   * whose capture holds more than the outputs warns instead.
   */
  readonly replay?: boolean
}

/**
 * Bring the action's outputs back to disk. Core's contract is that after an
 * executor returns, the declared outputs are where the task would have
 * written them — that is what lets the ordinary save path tar them up with no
 * knowledge of where the work happened.
 */
export async function materialiseOutputs(
  client: ReapiClient,
  req: MaterialiseRequest,
  result: ActionResult,
  warn: (m: string) => void,
  created?: string[],
): Promise<void> {
  const files = result.output_files ?? []
  // A glob with a wildcard FIRST segment has no REAPI spelling, so it is sent
  // as '' — whole-working-directory capture — and the worker returns inputs
  // and undeclared siblings alongside the real outputs. There is no way to
  // tell those apart here, so a blob we cannot fetch under that shape only
  // warns; refusing would break builds that are fine. Under a LITERAL capture
  // the server returned only what output_paths named, so every file IS a
  // declared output and an unfetchable one is a hole that `save` would tar up
  // and cache under a key claiming a complete build. That fails the task.
  const wholeTreeCapture = [
    ...(req.outputs?.files ?? []),
    ...(req.outputs?.workspaceFiles ?? []),
  ].some((g) => globToOutputPath(g) === '')
  // `abs` names a file a declared glob matches: missing, it is a hole in a
  // declared output under either capture, and warning let `save` cache the
  // short tree under the key (F-8).
  const missing = (what: string, hash: string, abs?: string): void => {
    if (!wholeTreeCapture || req.replay === true || (abs !== undefined && isDeclared(abs))) {
      throw new UserError(
        `vx/reapi: ${req.taskId} declared output ${what} is missing from the CAS (${hash.slice(0, 12)}) — re-run it (e.g. --force)`,
      )
    }
    warn(`vx/reapi: output ${what} missing from CAS (${hash.slice(0, 12)})`)
  }
  // A glob cut at its wildcard captured a directory that holds more than
  // the outputs — `src/*.gen.js` returns all of `src`, inputs included.
  // Only what a declared glob names is written: writing the rest put the
  // worker's copy of the sources over the user's, an edit made during the
  // action was lost, and core, seeing its inputs rewritten, never saved
  // the task (item 1038). A directory a LITERAL glob names is written whole.
  const projectRel = req.projectRel ?? toPosix(path.relative(req.workspaceRoot, req.cwd))
  const declared = [
    ...(req.outputs?.files ?? []).map((g) => (projectRel === '' ? g : `${projectRel}/${g}`)),
    ...(req.outputs?.workspaceFiles ?? []),
  ].map((g) => normalizeGlob(g))
  const matchers = declared.map((g) => new Bun.Glob(g))
  const isDeclared = (abs: string): boolean => {
    const rel = toPosix(path.relative(req.workspaceRoot, abs))
    return declared.includes(rel) || matchers.some((m) => m.match(rel))
  }
  // Batch the small ones into one round trip; anything larger goes over
  // ByteStream, which is also the only path that can be compressed.
  const fence = new Fence(req.workspaceRoot)
  const small = files.filter((f) => f.digest.size_bytes > 0 && f.digest.size_bytes <= 1024 * 1024)
  const batched = await client.batchReadBlobs(small.map((f) => f.digest))

  for (const f of files) {
    const abs = fence.lexical(req.cwd, f.path)
    await fence.dir(path.dirname(abs))
    await makeDir(path.dirname(abs), created)
    // Inlined only when it has bytes: an ActionResult read back through
    // proto-loader (the execution-record replay) carries `contents` as an
    // EMPTY Buffer on every file, and taking that as inline wrote each
    // replayed output empty (item 827). An empty file is the next branch.
    // Inline bytes are held to the digest they ride with, as fetched ones
    // are in wire.ts: a server's wrong inline copy was written as the output
    // and cached under the key (F-8). A mismatch fetches the blob instead.
    const inline =
      f.contents !== undefined &&
      f.contents.length > 0 &&
      digestWith(client.digest, f.contents).hash === f.digest.hash
    const bytes = inline
      ? f.contents! // inlined by the server (`inline_output_files`): zero fetches
      : Number(f.digest.size_bytes) === 0
        ? new Uint8Array()
        : (batched.get(f.digest.hash) ?? (await client.readBlob(f.digest)))
    if (bytes === null) {
      missing(f.path, f.digest.hash, abs)
      continue
    }
    await writeOutput(abs, bytes, created)
    // REAPI carries the executable bit per output; a build that produces a
    // script and a later task that runs it depends on it surviving.
    if (f.is_executable === true) await chmod(abs, 0o755)
  }

  // `OutputSymlink` — a declared output that is a link, not a file. Restoring
  // it as a copy would silently change what the next task sees.
  for (const sl of result.output_symlinks ?? []) {
    const abs = fence.lexical(req.cwd, sl.path)
    await fence.dir(path.dirname(abs))
    await makeDir(path.dirname(abs), created)
    await fence.symlink(sl.target, abs, created)
  }

  for (const d of result.output_directories ?? []) {
    const dest = fence.lexical(req.cwd, d.path)
    const whole = isDeclared(dest)
    await materialiseTree(
      client,
      fence,
      dest,
      d.tree_digest,
      missing,
      created,
      whole ? null : isDeclared,
    )
  }
}

/**
 * Where a server's paths may land: under the workspace root, through no
 * link that leads out of it (L-2). The ActionResult is the server's word —
 * a fresh one or a record replayed from its action cache — and its paths
 * and Tree names were joined as given: `../../../.bashrc`, a Tree name
 * `..`, a symlink `a -> ~` followed by a directory `a` holding
 * `.ssh/authorized_keys`, a file written through a link the result placed,
 * or a link out of the tree that the save then packed and uploaded. Each
 * is refused as the server's fault. A directory's check is memoized: it
 * is created a real directory right after, and a link is never placed over
 * a directory (`rm` without `recursive` refuses one). An absolute path
 * needs no case of its own: the join lands it where it names, and the
 * containment check judges that.
 */
class Fence {
  private realRoot: string | undefined
  private readonly checked = new Set<string>()
  private readonly root: string

  constructor(root: string) {
    this.root = path.resolve(root)
  }

  /** `rel` joined under `base`, refused when the join leaves the root. */
  lexical(base: string, rel: string): string {
    // A NUL reached the file system as a raw ERR_INVALID_ARG_VALUE.
    if (rel.includes('\0')) throw this.refuse(rel)
    const abs = path.resolve(base, rel)
    if (abs !== this.root && !abs.startsWith(this.root + path.sep)) throw this.refuse(rel)
    return abs
  }

  /** A Tree entry's name: one path component, as REAPI defines it. */
  name(at: string, name: string): string {
    if (name === '' || name === '.' || name === '..' || name.includes('/') || name.includes('\0')) {
      throw this.refuse(path.join(at, name))
    }
    return path.join(at, name)
  }

  /** `dir`, or its deepest existing ancestor, resolves inside the root. */
  async dir(dir: string): Promise<void> {
    if (this.checked.has(dir)) return
    this.realRoot ??= await realpath(this.root).catch(() => this.root)
    let probe = dir
    for (;;) {
      const real = await realpath(probe).catch(() => null)
      if (real !== null) {
        if (real !== this.realRoot && !real.startsWith(this.realRoot + path.sep)) {
          throw this.refuse(dir)
        }
        break
      }
      if (probe === this.root || path.dirname(probe) === probe) break
      probe = path.dirname(probe)
    }
    this.checked.add(dir)
  }

  /** A link whose target, read from where it stands, stays under the root. */
  async symlink(target: string, abs: string, created: string[] | undefined): Promise<void> {
    const to = path.resolve(path.dirname(abs), target)
    if (target.includes('\0') || (to !== this.root && !to.startsWith(this.root + path.sep))) {
      throw this.refuse(`${abs} -> ${target}`)
    }
    await placeSymlink(target, abs, created)
  }

  private refuse(what: string): UserError {
    return new UserError(
      `vx/reapi: the server returned an output outside the workspace (${what}) — refused; nothing is written outside ${this.root}`,
    )
  }
}

/** A write that never follows a link standing at its path. */
const WRITE_NOFOLLOW =
  constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW

/**
 * The three ways materialisation touches disk. Given `created` (a replay that
 * may have to be taken back), each also records what did not exist before it:
 * the outermost directory `mkdir` made, a file `wx` could create, a link that
 * found its name free. One syscall in the usual case, where core has cleaned.
 */
async function makeDir(dir: string, created: string[] | undefined): Promise<void> {
  const first = await mkdir(dir, { recursive: true })
  if (first !== undefined) created?.push(first)
}

async function writeOutput(
  abs: string,
  bytes: Uint8Array,
  created: string[] | undefined,
): Promise<void> {
  if (created !== undefined) {
    try {
      await writeFile(abs, bytes, { flag: 'wx' })
      created.push(abs)
      return
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
  }
  // A link at the path is replaced, never written through: the result may
  // have placed it (L-2).
  await writeFile(abs, bytes, { flag: WRITE_NOFOLLOW }).catch(async (err: unknown) => {
    if ((err as NodeJS.ErrnoException).code !== 'ELOOP') throw err
    await unlink(abs)
    await writeFile(abs, bytes, { flag: WRITE_NOFOLLOW })
  })
}

async function placeSymlink(
  target: string,
  abs: string,
  created: string[] | undefined,
): Promise<void> {
  try {
    await symlink(target, abs)
    created?.push(abs)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    await rm(abs, { force: true })
    await symlink(target, abs)
  }
}

/** Small blobs a tree restore holds in memory at once, fetched batched. */
const TREE_FETCH_WINDOW_BYTES = 64 * 1024 * 1024

/**
 * An `OutputDirectory` points at the digest of an encoded **`Tree` proto**
 * (root Directory + every descendant), NOT at a Directory to be walked with
 * the `GetTree` RPC. Reading it as the latter is a real interop bug — it was
 * this module's first version — because `GetTree` takes a Directory root and
 * would either error or, worse, traverse something else.
 */
async function materialiseTree(
  client: ReapiClient,
  fence: Fence,
  destDir: string,
  treeDigest: Digest,
  // Same policy as the file path: under a literal capture an unmaterialisable
  // entry is a hole in a DECLARED output directory, so it fails the task.
  missing: (what: string, hash: string, abs?: string) => void,
  created: string[] | undefined,
  // Null writes the whole Tree; otherwise only an entry it names, or one
  // under a directory it names, is written.
  declared: ((abs: string) => boolean) | null,
): Promise<void> {
  const blob = await client.readBlob(treeDigest)
  if (blob === null) {
    missing('tree', treeDigest.hash)
    return
  }
  const tree = decodeTreeWithBytes(blob)
  if (tree.root === undefined) {
    missing('tree (no root directory)', treeDigest.hash)
    return
  }
  // Children are addressed by the digest of the bytes the WORKER encoded.
  // Re-encoding our parse reproduces it only when both encoders agree byte
  // for byte, and a child that did not was "not present in the Tree blob"
  // (item 827), the miss decomposeOutputDir's own comment measured.
  const byDigest = new Map<string, Directory>()
  tree.children.forEach((child, i) => byDigest.set(tree.childDigests[i]!, child))

  // Files are gathered from the whole tree before any is fetched: one
  // BatchReadBlobs per DIRECTORY was a round trip each, so a `dist/` of 200
  // directories restored in 200 sequential calls (F-18). Windows bound what
  // is held. A symlink placed later in the walk lies under a directory not
  // yet visited, so no file gathered earlier is written through one.
  const files: { abs: string; f: Directory['files'][number] }[] = []
  const walk = async (dir: Directory, at: string, whole: boolean): Promise<void> => {
    const wanted = (abs: string): boolean => whole || declared!(abs)
    const here = dir.files.filter((f) => wanted(fence.name(at, f.name)))
    const symlinks = dir.symlinks.filter((sl) => wanted(fence.name(at, sl.name)))
    if (whole || here.length + symlinks.length > 0) {
      await fence.dir(at)
      await makeDir(at, created)
    }
    for (const f of here) files.push({ abs: path.join(at, f.name), f })
    for (const sl of symlinks) {
      await fence.symlink(sl.target, path.join(at, sl.name), created)
    }
    for (const child of dir.directories) {
      const childAt = fence.name(at, child.name)
      const node = byDigest.get(child.digest.hash)
      if (node === undefined) {
        if (wanted(childAt)) {
          missing(`${childAt} (not present in the Tree blob)`, child.digest.hash)
        }
        continue
      }
      await walk(node, childAt, whole || declared!(childAt))
    }
  }
  await walk(tree.root, destDir, declared === null)

  const isSmall = (f: { digest: Digest }): boolean =>
    f.digest.size_bytes > 0 && f.digest.size_bytes <= 1024 * 1024
  for (let i = 0; i < files.length;) {
    let held = 0
    let j = i
    while (j < files.length && (j === i || held < TREE_FETCH_WINDOW_BYTES)) {
      if (isSmall(files[j]!.f)) held += Number(files[j]!.f.digest.size_bytes)
      j++
    }
    const window = files.slice(i, j)
    const batched = await client.batchReadBlobs(
      window.filter((w) => isSmall(w.f)).map((w) => w.f.digest),
    )
    for (const { abs, f } of window) {
      const bytes =
        f.digest.size_bytes === 0
          ? new Uint8Array()
          : (batched.get(f.digest.hash) ?? (await client.readBlob(f.digest)))
      if (bytes === null) {
        missing(abs, f.digest.hash, abs)
        continue
      }
      await writeOutput(abs, bytes, created)
      if (f.is_executable) await chmod(abs, 0o755)
      // NodeProperties.unix_mode is authoritative when the server sent it.
      const mode = f.node_properties?.unixMode
      // Permission bits only: a server's setuid or setgid bit is not a build output's.
      if (mode !== undefined) await chmod(abs, mode & 0o777)
    }
    i = j
  }
}

const toPosix = (p: string): string => p.split(path.sep).join('/')
