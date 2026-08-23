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

import { mkdir, writeFile, chmod, rm, symlink } from 'node:fs/promises'
import path from 'node:path'
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
} from './merkle.js'
import type { ActionResult, Digest, Directory, Operation, ReapiClient } from './wire.js'

/** REAPI's ExecuteResponse arrives packed in an Any; decode just what we read. */
function decodeExecuteResponse(op: Operation): { result?: ActionResult; message?: string } {
  const value = op.response?.value
  if (value === undefined || value.length === 0) return {}
  return decodeExecuteResponseBytes(value)
}

/**
 * Hand-decoded because the response rides an `Any` and proto-loader gives no
 * decoder for an arbitrary packed type. Only the fields vx acts on are read:
 * `result` (field 1) and `message` (field 3).
 */
function decodeExecuteResponseBytes(buf: Uint8Array): { result?: ActionResult; message?: string } {
  const out: { result?: ActionResult; message?: string } = {}
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
      else if (field === 3) out.message = new TextDecoder().decode(slice)
    } else if (wire === 0) {
      const [, v] = readVarint(buf, i)
      i = v
    } else if (wire === 5) i += 4
    else if (wire === 1) i += 8
    else break
  }
  return out
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
      if (field === 1) (res.output_files ??= []).push(decodeOutputFile(slice))
      else if (field === 2) (res.output_directories ??= []).push(decodeOutputDirectory(slice))
      else if (field === 5) res.stdout_digest = decodeDigest(slice)
      else if (field === 7) res.stderr_digest = decodeDigest(slice)
      else if (field === 3) res.stdout_raw = slice
      else if (field === 6) res.stderr_raw = slice
    } else if (wire === 5) i += 4
    else if (wire === 1) i += 8
    else break
  }
  return res
}

function decodeOutputFile(buf: Uint8Array): {
  path: string
  digest: Digest
  is_executable?: boolean
} {
  const out = { path: '', digest: { hash: '', size_bytes: 0 }, is_executable: false }
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
    } else if (wire === 0) {
      const [v, n] = readVarint(buf, i)
      i = n
      if (field === 4) out.is_executable = v === 1
    } else break
  }
  return out
}

function decodeOutputDirectory(buf: Uint8Array): { path: string; tree_digest: Digest } {
  const out = { path: '', tree_digest: { hash: '', size_bytes: 0 } }
  let i = 0
  while (i < buf.length) {
    const [key, k] = readVarint(buf, i)
    i = k
    const wire = key & 7
    if (wire !== 2) break
    const [len, l] = readVarint(buf, i)
    i = l
    const slice = buf.subarray(i, i + len)
    i += len
    if (key >>> 3 === 1) out.path = new TextDecoder().decode(slice)
    else if (key >>> 3 === 2) out.tree_digest = decodeDigest(slice)
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
  return {
    name: 'vx/reapi',
    remote: true,
    ...(opts.capacity === undefined ? {} : { capacity: opts.capacity }),
    accepts: acceptsTask,
    async execute(req: ExecuteRequest): Promise<ExecuteResult> {
      const started = Bun.nanoseconds()
      // `inputs` is guaranteed by `accepts` (cacheable ⇒ the miss path
      // describes them); the guard is for a host that bypasses placement.
      if (req.inputs === undefined) {
        throw new Error(
          `vx/reapi: ${req.taskId} reached the remote executor with no described inputs`,
        )
      }

      const inputPaths = [
        ...req.inputs.files.map((f) => f.path),
        // Upstream outputs are on disk already (core restored them before
        // this task ran) and are inputs to this action on the worker.
        ...req.inputs.upstream.flatMap((u) => u.outputs),
      ]
      const tree = await buildInputTree({
        workspaceRoot: req.workspaceRoot,
        paths: inputPaths,
        digests,
      })

      const workingDirectory = toPosix(path.relative(req.workspaceRoot, req.cwd))
      const platformProps = Object.entries(opts.platform ?? {}).map(([name, value]) => ({
        name,
        value,
      }))
      const command = {
        // `sh -c` matches vx's contract exactly: shell IS the API, so the
        // worker must interpret the string the same way the local executor's
        // spawn does.
        arguments: ['/bin/sh', '-c', fullCommand(req)],
        environmentVariables: req.inputs.env.map((e) => ({ name: e.name, value: e.value })),
        outputPaths: outputPathsFor(req, workingDirectory),
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

      const caps = await client.capabilities()
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
        throw new Error(
          `vx/reapi: execution failed for ${req.taskId}: ${op.error.message ?? `code ${op.error.code}`}`,
        )
      }
      const { result, message } = decodeExecuteResponse(op)
      if (result === undefined) {
        throw new Error(
          `vx/reapi: ${req.taskId} returned no ActionResult${message === undefined ? '' : `: ${message}`}`,
        )
      }

      const [stdout, stderr] = await Promise.all([
        this_readStream(client, result.stdout_raw, result.stdout_digest),
        this_readStream(client, result.stderr_raw, result.stderr_digest),
      ])
      if (req.capture.stdout !== false && stdout.length > 0) req.onStdout(stdout)
      if (req.capture.stderr !== false && stderr.length > 0) req.onStderr(stderr)

      await materialiseOutputs(client, req, result, warn)

      return {
        exitCode: result.exit_code ?? 0,
        durationMs: Math.round((Bun.nanoseconds() - started) / 1e6),
        stdout: req.capture.stdout === false ? '' : stdout,
        stderr: req.capture.stderr === false ? '' : stderr,
        violations: [],
      }
    },
  }
}

/** stdout/stderr arrive inline OR as a CAS digest; servers choose. */
async function this_readStream(
  client: ReapiClient,
  raw: Uint8Array | undefined,
  digest: Digest | undefined,
): Promise<string> {
  if (raw !== undefined && raw.length > 0) return new TextDecoder().decode(raw)
  if (digest !== undefined && digest.size_bytes > 0) {
    const bytes = await client.readBlob(digest)
    if (bytes !== null) return new TextDecoder().decode(bytes)
  }
  return ''
}

/** Forwarded args are appended shell-quoted, exactly as the local executor does. */
function fullCommand(req: ExecuteRequest): string {
  if (req.forwardArgs.length === 0) return req.command
  const quoted = req.forwardArgs.map((a) => `'${a.replaceAll("'", `'\\''`)}'`).join(' ')
  return `${req.command} ${quoted}`
}

/**
 * REAPI `output_paths` are relative to the WORKING DIRECTORY. vx's `files` are
 * project-relative (so already working-directory-relative) while
 * `workspaceFiles` are workspace-root-relative and must be re-based.
 */
function outputPathsFor(req: ExecuteRequest, workingDirectory: string): string[] {
  const rebased = req.outputs.workspaceFiles.map((p) =>
    workingDirectory === '' ? p : toPosix(path.relative(workingDirectory, p)),
  )
  return [...req.outputs.files, ...rebased]
}

/**
 * Bring the action's outputs back to disk. Core's contract is that after an
 * executor returns, the declared outputs are where the task would have
 * written them — that is what lets the ordinary save path tar them up with no
 * knowledge of where the work happened.
 */
async function materialiseOutputs(
  client: ReapiClient,
  req: ExecuteRequest,
  result: ActionResult,
  warn: (m: string) => void,
): Promise<void> {
  const files = result.output_files ?? []
  // Batch the small ones into one round trip; anything larger goes over
  // ByteStream, which is also the only path that can be compressed.
  const small = files.filter((f) => f.digest.size_bytes > 0 && f.digest.size_bytes <= 1024 * 1024)
  const batched = await client.batchReadBlobs(small.map((f) => f.digest))

  for (const f of files) {
    const abs = path.join(req.cwd, f.path)
    await mkdir(path.dirname(abs), { recursive: true })
    const bytes =
      f.digest.size_bytes === 0
        ? new Uint8Array()
        : (batched.get(f.digest.hash) ?? (await client.readBlob(f.digest)))
    if (bytes === null) {
      warn(`vx/reapi: output ${f.path} missing from CAS (${f.digest.hash.slice(0, 12)})`)
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
    await materialiseTree(client, path.join(req.cwd, d.path), d.tree_digest, warn)
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
  warn: (m: string) => void,
): Promise<void> {
  const blob = await client.readBlob(treeDigest)
  if (blob === null) {
    warn(`vx/reapi: output tree ${treeDigest.hash.slice(0, 12)} missing from CAS`)
    return
  }
  const tree = decodeTree(blob)
  if (tree.root === undefined) {
    warn(`vx/reapi: output tree ${treeDigest.hash.slice(0, 12)} has no root directory`)
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
        warn(`vx/reapi: tree file ${f.name} missing from CAS`)
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
        warn(`vx/reapi: tree child ${child.name} not present in the Tree blob`)
        continue
      }
      await walk(node, path.join(at, child.name))
    }
  }
  await walk(tree.root, destDir)
}

const toPosix = (p: string): string => p.split(path.sep).join('/')
