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

import { mkdir, writeFile, chmod, rm, symlink, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { UserError } from '@vzn/vx'
import type { ExecuteRequest, ExecuteResult, TaskExecutor, TaskPlacement } from '@vzn/vx'
import {
  buildInputTree,
  decodeTree,
  DigestCache,
  encodeAction,
  encodeCommand,
  encodeDirectory,
  sha256,
  type Blob,
  type FileGraft,
  type TreeGraft,
} from './merkle.js'
import { execDigestFor } from './cache.js'
import type { ActionResult, Digest, Directory, Operation, ReapiClient } from './wire.js'

/** `ExecuteRequest.inputs` past the executor's own undefined guard. Derived
 *  rather than imported: the façade does not export `TaskInputs`, and widening
 *  it for one alias is the speculative widening the project rejects. */
type DescribedInputs = NonNullable<ExecuteRequest['inputs']>

export interface DecodedExecuteResponse {
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

export interface ReapiExecutorOptions {
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
  const digests = new DigestCache()
  const warn = opts.warn ?? (() => undefined)
  // One Capabilities round trip per executor, not per task — the answer
  // cannot change mid-run, and a 400-task graph would otherwise ask 400 times.
  let capsPromise: ReturnType<ReapiClient['capabilities']> | undefined
  const capabilitiesOnce = (): ReturnType<ReapiClient['capabilities']> =>
    (capsPromise ??= client.capabilities())
  return {
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
      // the remote store or the server misbehaving — a UserError, so the
      // scheduler prints it plainly instead of "internal error in <task>".
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
        const prior = await client.getActionResult(execDigestFor(req.cacheKey))
        if (prior !== null) {
          const referenced = [
            ...(prior.output_files ?? []).map((f) => f.digest),
            ...(prior.output_directories ?? []).map((d) => d.tree_digest),
          ]
          // AC and CAS evict independently, so a record can outlive its
          // blobs. A gap means it cannot produce the outputs — fall through
          // and execute for real rather than "succeed" with nothing.
          const gone = referenced.length > 0 ? await client.findMissingBlobs(referenced) : []
          if (gone.length === 0) {
            const priorStdout = await this_readStream(client, prior.stdout_raw, prior.stdout_digest)
            if (req.capture.stdout !== false && priorStdout.length > 0) req.onStdout(priorStdout)
            // The record's paths are WORKSPACE-relative (rebased when it was
            // written), so the anchor is the workspace root, not the cwd.
            const fromRecord = (): Promise<void> =>
              materialiseOutputs(client, { ...req, cwd: req.workspaceRoot }, prior, warn)
            const deferRecord = req.remoteOnly !== true && req.download === 'deferred'
            if (req.remoteOnly !== true && !deferRecord) await fromRecord()
            return {
              exitCode: 0,
              durationMs: Math.round((Bun.nanoseconds() - started) / 1e6),
              stdout: req.capture.stdout === false ? '' : priorStdout,
              stderr: '',
              violations: [],
              ...(deferRecord
                ? { outputs: { kind: 'deferred' as const, materialize: fromRecord } }
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
      // Wildcards in root-anchored outputs are expanded to literal member
      // paths BEFORE the Command is built (see expandOutputGlobs).
      const expandedWorkspaceOutputs = await expandOutputGlobs(
        req.workspaceRoot,
        req.outputs.workspaceFiles,
      )
      const outReq: ExecuteRequest = {
        ...req,
        outputs: { ...req.outputs, workspaceFiles: expandedWorkspaceOutputs },
      }
      const rootAnchored = req.outputs.workspaceFiles.length > 0
      const workingDirectory = rootAnchored ? '' : projectRel
      // The server reports output paths relative to `working_directory`, so
      // in root mode materialisation anchors at the workspace root — the same
      // rebase the record-replay path above already does for its own reason.
      const matReq = rootAnchored ? { ...req, cwd: req.workspaceRoot } : req

      // Upstream outputs reach this action's input root one of two ways.
      // PREFERRED: by REFERENCE — the upstream executed remotely and left an
      // execution record (per-file digests, workspace-relative paths) under
      // its vx key, so its bytes flow worker→CAS→worker and never transit
      // this machine. FALLBACK: from local disk (the upstream ran locally, so
      // core restored its outputs here before this task started).
      const fileGrafts: FileGraft[] = []
      const treeGrafts: TreeGraft[] = []
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
        if (up.outputs.length > 0) {
          localUpstreamPaths.push(...up.outputs)
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
          const decodedTree = decodeTree(treeBlob)
          if (decodedTree.root === undefined) continue
          treeGrafts.push({ path: d.path, root: decodedTree.root, children: decodedTree.children })
        }
      }

      const inputPaths = [...req.inputs.files.map((f) => f.path), ...localUpstreamPaths]
      const tree = await buildInputTree({
        workspaceRoot: req.workspaceRoot,
        paths: inputPaths,
        digests,
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
      })
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
        environmentVariables: commandEnvironment(req.inputs, req.envDefine),
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
      const op = await client.execute(actionDigest, {
        ...(opts.priority === undefined ? {} : { priority: opts.priority }),
        onStage: (stage) => warn(`vx/reapi: ${req.taskId} ${stage.toLowerCase()}`),
      })
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
      const worker = result.execution_metadata?.worker
      if (worker !== undefined && worker !== '') warn(`vx/reapi: ${req.taskId} ran on ${worker}`)

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
      if (req.cacheKey !== undefined && (result.exit_code ?? 0) === 0) {
        const rebase = (rel: string): string =>
          workingDirectory === '' ? rel : `${workingDirectory}/${rel}`
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
        await client
          .updateActionResult(execDigestFor(req.cacheKey), {
            exit_code: 0,
            ...(stdoutDigest === undefined ? {} : { stdout_digest: stdoutDigest }),
            output_files: (result.output_files ?? []).map((f) => ({
              path: rebase(f.path),
              digest: f.digest,
              is_executable: f.is_executable === true,
            })),
            output_directories: (result.output_directories ?? []).map((d) => ({
              path: rebase(d.path),
              tree_digest: d.tree_digest,
            })),
            output_symlinks: (result.output_symlinks ?? []).map((sl) => ({
              path: rebase(sl.path),
              target: sl.target,
            })),
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

/**
 * REAPI `output_paths` are LITERAL, so a glob whose wildcard sits in the
 * MIDDLE (`packages/&#42;/node_modules`) collapses to its static prefix
 * (`packages`) — and that whole directory then replaces the sources in every
 * consumer's input tree. But the wildcard segments name workspace member
 * DIRECTORIES, which exist as inputs and are known before the action runs, so
 * expand them here and emit one literal path per match. Trailing segments are
 * left untouched: the action produces them, so they need not exist yet.
 */
export async function expandOutputGlobs(
  workspaceRoot: string,
  globs: readonly string[],
): Promise<string[]> {
  const out: string[] = []
  for (const glob of globs) {
    const segments = glob.split('/')
    let prefixes = ['']
    let i = 0
    for (; i < segments.length; i++) {
      const seg = segments[i]!
      if (!seg.includes('*') && !seg.includes('?') && !seg.includes('[')) {
        prefixes = prefixes.map((p) => (p === '' ? seg : `${p}/${seg}`))
        continue
      }
      // A wildcard SEGMENT: match it against the directories that exist at
      // this level. Anything below it stays literal.
      const matcher = new Bun.Glob(seg)
      const next: string[] = []
      for (const prefix of prefixes) {
        const dir = prefix === '' ? workspaceRoot : path.join(workspaceRoot, prefix)
        let entries: string[]
        try {
          entries = await readdir(dir)
        } catch {
          continue
        }
        for (const entry of entries.sort()) {
          if (!matcher.match(entry)) continue
          if (!existsSync(path.join(dir, entry))) continue
          next.push(prefix === '' ? entry : `${prefix}/${entry}`)
        }
      }
      prefixes = next
      if (prefixes.length === 0) break
    }
    // Any segments after the LAST wildcard are appended verbatim.
    const tail = segments.slice(i + 1)
    for (const p of prefixes) out.push(tail.length === 0 ? p : `${p}/${tail.join('/')}`)
  }
  return [...new Set(out)].sort()
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
  const cd = cdInto === '' ? '' : `cd '${cdInto}' || exit 1; `
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
    if (/[*?[\]{]/.test(seg)) break
    literal.push(seg)
  }
  if (literal.length === segments.length) return glob // no wildcard: a literal path
  return literal.join('/')
}

/**
 * The action's environment: `cache.inputs.env` (values read from THIS
 * machine's environment, already folded into the cache key) plus
 * `exec.env.define` (literals from the task config). A define wins on
 * collision — it is the more explicit statement of intent. Nothing else from
 * `req.env` may cross: that is this machine's RESOLVED environment (its PATH,
 * HOME, TMPDIR), and shipping it would put host-specific values into the
 * action identity, splitting every machine from every other.
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
): Array<{ name: string; value: string }> {
  const merged = new Map<string, string>()
  for (const e of inputs.env) merged.set(e.name, e.value)
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
  const globs = [...req.outputs.files.map(prefix), ...req.outputs.workspaceFiles.map(rebase)]
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
 * Bring the action's outputs back to disk. Core's contract is that after an
 * executor returns, the declared outputs are where the task would have
 * written them — that is what lets the ordinary save path tar them up with no
 * knowledge of where the work happened.
 */
export async function materialiseOutputs(
  client: ReapiClient,
  req: ExecuteRequest,
  result: ActionResult,
  warn: (m: string) => void,
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
  const missing = (what: string, hash: string): void => {
    if (!wholeTreeCapture) {
      throw new UserError(
        `vx/reapi: ${req.taskId} declared output ${what} is missing from the CAS (${hash.slice(0, 12)}) — re-run it (e.g. --force)`,
      )
    }
    warn(`vx/reapi: output ${what} missing from CAS (${hash.slice(0, 12)})`)
  }
  // Batch the small ones into one round trip; anything larger goes over
  // ByteStream, which is also the only path that can be compressed.
  const small = files.filter((f) => f.digest.size_bytes > 0 && f.digest.size_bytes <= 1024 * 1024)
  const batched = await client.batchReadBlobs(small.map((f) => f.digest))

  for (const f of files) {
    const abs = path.join(req.cwd, f.path)
    await mkdir(path.dirname(abs), { recursive: true })
    const bytes =
      f.contents !== undefined
        ? f.contents // inlined by the server (`inline_output_files`): zero fetches
        : f.digest.size_bytes === 0
          ? new Uint8Array()
          : (batched.get(f.digest.hash) ?? (await client.readBlob(f.digest)))
    if (bytes === null) {
      missing(f.path, f.digest.hash)
      continue
    }
    await writeFile(abs, bytes)
    // REAPI carries the executable bit per output; a build that produces a
    // script and a later task that runs it depends on it surviving.
    if (f.is_executable === true) await chmod(abs, 0o755)
  }

  // `OutputSymlink` — a declared output that is a link, not a file. Restoring
  // it as a copy would silently change what the next task sees.
  for (const sl of result.output_symlinks ?? []) {
    const abs = path.join(req.cwd, sl.path)
    await mkdir(path.dirname(abs), { recursive: true })
    await rm(abs, { force: true })
    await symlink(sl.target, abs)
  }

  for (const d of result.output_directories ?? []) {
    await materialiseTree(client, path.join(req.cwd, d.path), d.tree_digest, missing)
  }
}

/**
 * An `OutputDirectory` points at the digest of an encoded **`Tree` proto**
 * (root Directory + every descendant), NOT at a Directory to be walked with
 * the `GetTree` RPC. Reading it as the latter is a real interop bug — it was
 * this module's first version — because `GetTree` takes a Directory root and
 * would either error or, worse, traverse something else.
 */
async function materialiseTree(
  client: ReapiClient,
  destDir: string,
  treeDigest: Digest,
  // Same policy as the file path: under a literal capture an unmaterialisable
  // entry is a hole in a DECLARED output directory, so it fails the task.
  missing: (what: string, hash: string) => void,
): Promise<void> {
  const blob = await client.readBlob(treeDigest)
  if (blob === null) {
    missing('tree', treeDigest.hash)
    return
  }
  const tree = decodeTree(blob)
  if (tree.root === undefined) {
    missing('tree (no root directory)', treeDigest.hash)
    return
  }
  // Children are addressed by their own Directory digest, so index them the
  // same way the server did — by the digest of the encoded Directory.
  const byDigest = new Map<string, Directory>()
  for (const child of tree.children) byDigest.set(sha256(encodeDirectory(child)).hash, child)

  const walk = async (dir: Directory, at: string): Promise<void> => {
    await mkdir(at, { recursive: true })
    const small = dir.files.filter(
      (f) => f.digest.size_bytes > 0 && f.digest.size_bytes <= 1024 * 1024,
    )
    const batched = await client.batchReadBlobs(small.map((f) => f.digest))
    for (const f of dir.files) {
      const bytes =
        f.digest.size_bytes === 0
          ? new Uint8Array()
          : (batched.get(f.digest.hash) ?? (await client.readBlob(f.digest)))
      if (bytes === null) {
        missing(path.join(at, f.name), f.digest.hash)
        continue
      }
      const abs = path.join(at, f.name)
      await writeFile(abs, bytes)
      if (f.is_executable) await chmod(abs, 0o755)
      // NodeProperties.unix_mode is authoritative when the server sent it.
      const mode = f.node_properties?.unixMode
      if (mode !== undefined) await chmod(abs, mode & 0o7777)
    }
    for (const sl of dir.symlinks) {
      const abs = path.join(at, sl.name)
      await rm(abs, { force: true })
      await symlink(sl.target, abs)
    }
    for (const child of dir.directories) {
      const node = byDigest.get(child.digest.hash)
      if (node === undefined) {
        missing(`${path.join(at, child.name)} (not present in the Tree blob)`, child.digest.hash)
        continue
      }
      await walk(node, path.join(at, child.name))
    }
  }
  await walk(tree.root, destDir)
}

const toPosix = (p: string): string => p.split(path.sep).join('/')
