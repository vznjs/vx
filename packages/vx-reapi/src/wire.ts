// The full gRPC surface of the Bazel Remote Execution API: Execution,
// ActionCache, ContentAddressableStorage, Capabilities and ByteStream.
// `@grpc/proto-loader` parses the vendored protos (28 ms) and `@grpc/grpc-js`
// carries the calls.

import * as grpc from '@grpc/grpc-js'
import * as protoLoader from '@grpc/proto-loader'
import path from 'node:path'
import { canDigest, concat, digestWith, type DigestFunctionName } from './merkle.js'

/** Bare varint bytes, for the hand-encoded RequestMetadata header. */
function varintBytes(n: number): Uint8Array {
  const out: number[] = []
  let v = n
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80)
    v >>>= 7
  }
  out.push(v)
  return new Uint8Array(out)
}

/**
 * Default bytes per ByteStream message.
 *
 * NOT a throughput knob. Bun's `node:http2` client HANGS — it does not error —
 * when a request carries more than one message and any single message exceeds
 * a threshold that the PEER's flow-control behaviour decides. Go's gRPC server
 * grows its window dynamically (a `WINDOW_UPDATE` then a `SETTINGS` raise) and
 * Bun mishandles the tail of that sequence; a `node:http2` server, which does
 * not do it, accepts 4 MB writes happily. See Bun #30342 / #26915, largely
 * fixed by #31584 — which is why the ceiling ROSE from ~64 KB on 1.3.x to
 * ~216 KB on 1.4.0 rather than the hang disappearing.
 *
 * 128 KB is MEASURED safe against bazel-remote on Bun >= 1.4 and is the
 * shipped default. It is NOT safe on Bun 1.3.x — hence `MIN_BUN` and
 * `assertBunSupportsChunking()`.
 *
 * `SAFE_CHUNK_BYTES` (65535, the RFC 7540 default initial window every peer
 * must honour with no WINDOW_UPDATE at all) is the value with no
 * peer-dependence. A deployment whose server is not bazel-remote and which
 * sees uploads wedge should pass `chunkBytes: SAFE_CHUNK_BYTES`.
 *
 * Full probe matrix: `docs/design/plugin-executor-reapi-2026-08.md` §14.
 */
export const CHUNK_BYTES = 128 * 1024

/**
 * The largest message needing no `WINDOW_UPDATE` from any conformant peer, so
 * the one size with no peer-dependence. The escape hatch when a server's
 * flow-control behaviour trips the Bun defect above.
 */
export const SAFE_CHUNK_BYTES = 65535

/** The oldest Bun whose http2 client survives a CHUNK_BYTES-sized message. */
export const MIN_BUN = [1, 4, 0] as const

/**
 * Refuse to run on a Bun that would hang instead of uploading. A version this
 * plugin cannot use is a startup error naming the fix, never a wedged run —
 * the failure mode being guarded is a HANG, which gives a user nothing to go
 * on.
 */
export function assertBunSupportsChunking(version: string = Bun.version): void {
  const parts = version.split('.').map((p) => Number.parseInt(p, 10))
  const [maj = 0, min = 0, patch = 0] = parts
  const older =
    maj < MIN_BUN[0] ||
    (maj === MIN_BUN[0] && min < MIN_BUN[1]) ||
    (maj === MIN_BUN[0] && min === MIN_BUN[1] && patch < MIN_BUN[2])
  if (older) {
    throw new Error(
      `@vzn/vx-reapi needs Bun >= ${MIN_BUN.join('.')} (running ${version}). ` +
        `Older Bun hangs on the chunked uploads this plugin makes — see ` +
        `docs/design/plugin-executor-reapi-2026-08.md §14. Upgrade with \`bun upgrade\`.`,
    )
  }
}

export interface Digest {
  hash: string
  size_bytes: number
}

export interface ServerCapabilities {
  digestFunctions: string[]
  maxBatchBytes: number
  acUpdateEnabled: boolean
  /** False for a cache-only deployment (bazel-remote). Gates the executor. */
  execEnabled: boolean
  /** `Compressor.Value` names the server accepts on ByteStream. */
  supportedCompressors: string[]
  /** Compressors accepted specifically on `BatchUpdateBlobs`. */
  supportedBatchCompressors: string[]
  /** How the server treats absolute symlink targets. */
  symlinkAbsolutePathStrategy: string
  /** Experimental `SplitBlob`/`SpliceBlob` support. */
  splitBlobSupport: boolean
  spliceBlobSupport: boolean
}

/** REAPI `Directory` node types — the Merkle input root. */
export interface FileNode {
  name: string
  digest: Digest
  is_executable: boolean
  node_properties?: { unixMode?: number; mtimeMs?: number }
}
export interface DirectoryNode {
  name: string
  digest: Digest
}
export interface SymlinkNode {
  name: string
  target: string
}
export interface Directory {
  files: FileNode[]
  directories: DirectoryNode[]
  symlinks: SymlinkNode[]
}

const PROTO_ROOT = path.join(import.meta.dir, '..', 'protos')
const LOAD_OPTIONS: protoLoader.Options = {
  includeDirs: [PROTO_ROOT],
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
}

interface ServiceClients {
  cas: grpc.Client
  ac: grpc.Client
  bs: grpc.Client
  caps: grpc.Client
  exec: grpc.Client
}

type Ctors = Record<string, new (...a: unknown[]) => grpc.Client>
let loaded: { v2: Ctors; bs: Ctors } | undefined

/** Parsed ONCE per process: proto parsing is ~28 ms and identical every time. */
function ctors(): { v2: Ctors; bs: Ctors } {
  if (loaded !== undefined) return loaded
  const reapi = grpc.loadPackageDefinition(
    protoLoader.loadSync('build/bazel/remote/execution/v2/remote_execution.proto', LOAD_OPTIONS),
  ) as unknown as { build: { bazel: { remote: { execution: { v2: Ctors } } } } }
  const bytestream = grpc.loadPackageDefinition(
    protoLoader.loadSync('google/bytestream/bytestream.proto', LOAD_OPTIONS),
  ) as unknown as { google: { bytestream: Ctors } }
  loaded = { v2: reapi.build.bazel.remote.execution.v2, bs: bytestream.google.bytestream }
  return loaded
}

/**
 * All five service stubs share ONE channel. Constructing them independently
 * opens one HTTP/2 connection per service to the same endpoint — five times
 * the sockets, five times the flow-control state, and a server that sees five
 * clients where there is one. `channelOverride` is grpc-js's supported way to
 * bind extra stubs onto an existing channel.
 */
function loadServices(target: string, creds: grpc.ChannelCredentials): ServiceClients {
  const { v2, bs } = ctors()
  const cas = new v2['ContentAddressableStorage']!(target, creds)
  const shared = { channelOverride: cas.getChannel() }
  return {
    cas,
    ac: new v2['ActionCache']!(target, creds, shared),
    caps: new v2['Capabilities']!(target, creds, shared),
    exec: new v2['Execution']!(target, creds, shared),
    bs: new bs['ByteStream']!(target, creds, shared),
  }
}

/** Transient statuses a retry can heal: UNAVAILABLE, and RESOURCE_EXHAUSTED
 *  when the server is shedding load. NOT_FOUND/INVALID_ARGUMENT never heal. */
function isRetryable(code: number | undefined): boolean {
  return code === grpc.status.UNAVAILABLE || code === grpc.status.RESOURCE_EXHAUSTED
}

const RETRY_DELAYS_MS = [100, 400, 1600]

/**
 * Promisified unary call with bounded retry on transient failure. Every
 * unary REAPI call is idempotent by construction (CAS writes are
 * content-addressed, AC updates are last-writer-wins on an immutable key),
 * so retrying cannot double-apply anything.
 */
async function unary<T>(
  client: grpc.Client,
  method: string,
  req: unknown,
  meta: grpc.Metadata,
  options: grpc.CallOptions = {},
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await new Promise<T>((resolve, reject) => {
        ;(client as unknown as Record<string, Function>)[method]!(
          req,
          meta,
          options,
          (err: grpc.ServiceError | null, res: T) => (err ? reject(err) : resolve(res)),
        )
      })
    } catch (err) {
      const delay = RETRY_DELAYS_MS[attempt]
      if (delay === undefined || !isRetryable((err as grpc.ServiceError).code)) throw err
      await Bun.sleep(delay)
    }
  }
}

const NOT_FOUND = grpc.status.NOT_FOUND

export interface ReapiOptions {
  /** `host:port` of the REAPI server. */
  endpoint: string
  /** Multi-tenant servers scope by instance; most single-tenant ones use ''. */
  instanceName?: string
  /** Sent on every call (auth, routing). */
  headers?: Record<string, string>
  /** TLS. Default: infer from an `https://`/`grpcs://` endpoint, else insecure. */
  tls?: boolean
  /** Reported in REAPI `RequestMetadata.tool_details`. */
  toolName?: string
  toolVersion?: string
  /** Groups several vx runs as one logical build in a server's UI. */
  correlatedInvocationsId?: string
  /**
   * Deadline for every CACHE-PATH call (unary RPCs, ByteStream transfers).
   * Default 30 000 ms. This is what turns a WEDGED server — accepts TCP,
   * never answers — into an error the layer above can degrade to a MISS;
   * without it the first probe hangs the whole run. Execution streams are
   * NOT bounded by this (queueing behind a busy worker pool is legitimate
   * and unbounded); a wedged server still cannot reach Execute, because the
   * deadline-bounded Capabilities call runs first and fails.
   */
  callTimeoutMs?: number
  /**
   * Bytes per ByteStream message. Defaults to `CHUNK_BYTES` (128 KB). Drop to
   * `SAFE_CHUNK_BYTES` if uploads wedge against your server — the ceiling is
   * peer-dependent, see the note on `CHUNK_BYTES`.
   */
  chunkBytes?: number
}

export class ReapiClient {
  private readonly svc: ServiceClients
  private readonly instance: string
  private readonly headers: Record<string, string>
  private readonly chunkBytes: number
  private readonly callTimeoutMs: number
  private digestFunction: DigestFunctionName = 'SHA256'
  private compression = false
  private batchCompression = false
  private negotiated: ServerCapabilities | undefined
  private readonly toolName: string
  private readonly toolVersion: string
  private readonly correlatedInvocationsId: string
  /** Set per action so the server can group its RPCs under one action. */
  actionId = ''
  toolInvocationId = ''

  constructor(opts: ReapiOptions) {
    assertBunSupportsChunking()
    const tls = opts.tls ?? /^(https|grpcs):\/\//.test(opts.endpoint)
    const target = opts.endpoint.replace(/^(https?|grpcs?):\/\//, '')
    this.svc = loadServices(
      target,
      tls ? grpc.credentials.createSsl() : grpc.credentials.createInsecure(),
    )
    this.instance = opts.instanceName ?? ''
    this.headers = opts.headers ?? {}
    this.toolName = opts.toolName ?? 'vx'
    this.toolVersion = opts.toolVersion ?? '0.0.0'
    this.correlatedInvocationsId = opts.correlatedInvocationsId ?? ''
    this.chunkBytes = opts.chunkBytes ?? CHUNK_BYTES
    this.callTimeoutMs = opts.callTimeoutMs ?? 30_000
    if (!Number.isInteger(this.chunkBytes) || this.chunkBytes < 1) {
      throw new Error(
        `@vzn/vx-reapi: chunkBytes must be a positive integer (got ${this.chunkBytes})`,
      )
    }
  }

  /**
   * Per-call metadata. Beyond the user's headers this carries REAPI's
   * `RequestMetadata` in the well-known binary header, which is how a server
   * groups the dozens of CAS/AC calls an action makes into one build in its
   * UI. Omitting it is legal and makes vx invisible in every REAPI server's
   * dashboard, which is the whole reason the field exists.
   */
  /** Call options carrying the cache-path deadline. */
  private bounded(): grpc.CallOptions {
    return { deadline: new Date(Date.now() + this.callTimeoutMs) }
  }

  private meta(): grpc.Metadata {
    const m = new grpc.Metadata()
    for (const [k, v] of Object.entries(this.headers)) m.set(k, v)
    m.set(
      'build.bazel.remote.execution.v2.requestmetadata-bin',
      Buffer.from(this.requestMetadata()),
    )
    return m
  }

  /**
   * `RequestMetadata { tool_details = 1, action_id = 2, tool_invocation_id = 3,
   *                    correlated_invocations_id = 4, action_mnemonic = 6 }`
   * with `ToolDetails { tool_name = 1, tool_version = 2 }`.
   */
  private requestMetadata(): Uint8Array {
    const str = (field: number, v: string): Uint8Array => {
      if (v === '') return new Uint8Array()
      const bytes = new TextEncoder().encode(v)
      return concat([varintBytes((field << 3) | 2), varintBytes(bytes.length), bytes])
    }
    const tool = concat([str(1, this.toolName), str(2, this.toolVersion)])
    const toolField =
      tool.length === 0
        ? new Uint8Array()
        : concat([varintBytes((1 << 3) | 2), varintBytes(tool.length), tool])
    return concat([
      toolField,
      str(2, this.actionId),
      str(3, this.toolInvocationId),
      str(4, this.correlatedInvocationsId),
    ])
  }

  /**
   * `GetCapabilities`. `execEnabled` is what decides whether this server can
   * take an `executor` at all — a cache-only deployment (bazel-remote)
   * advertises no execution capability, and offering it work would hang a run
   * on a server that will never answer.
   */
  async capabilities(): Promise<ServerCapabilities> {
    const res = await unary<{
      cache_capabilities?: {
        digest_functions?: string[]
        max_batch_total_size_bytes?: string
        action_cache_update_capabilities?: { update_enabled?: boolean }
        supported_compressors?: string[]
        supported_batch_update_compressors?: string[]
        symlink_absolute_path_strategy?: string
        split_blob_support?: boolean
        splice_blob_support?: boolean
      }
      execution_capabilities?: { exec_enabled?: boolean; digest_function?: string }
    }>(
      this.svc.caps,
      'getCapabilities',
      { instance_name: this.instance },
      this.meta(),
      this.bounded(),
    )
    const cc = res.cache_capabilities
    return {
      digestFunctions: cc?.digest_functions ?? [],
      maxBatchBytes: Number(cc?.max_batch_total_size_bytes ?? 0),
      acUpdateEnabled: cc?.action_cache_update_capabilities?.update_enabled === true,
      execEnabled: res.execution_capabilities?.exec_enabled === true,
      supportedCompressors: cc?.supported_compressors ?? [],
      supportedBatchCompressors: cc?.supported_batch_update_compressors ?? [],
      symlinkAbsolutePathStrategy: cc?.symlink_absolute_path_strategy ?? 'UNKNOWN',
      splitBlobSupport: cc?.split_blob_support === true,
      spliceBlobSupport: cc?.splice_blob_support === true,
    }
  }

  /**
   * Negotiate once against the server's advertised capabilities: the digest
   * function to hash with, and whether blobs may ride compressed. Mixing
   * digest functions within an action is invalid, so this is a per-client
   * decision, not a per-call one.
   */
  async negotiate(prefer?: {
    digestFunction?: DigestFunctionName
    compression?: boolean
  }): Promise<void> {
    const caps = await this.capabilities()
    const wanted = prefer?.digestFunction
    if (wanted !== undefined) {
      if (!caps.digestFunctions.includes(wanted)) {
        throw new Error(
          `@vzn/vx-reapi: server does not support digest function ${wanted} (has ${caps.digestFunctions.join(', ')})`,
        )
      }
      if (!canDigest(wanted))
        throw new Error(`@vzn/vx-reapi: this runtime cannot compute ${wanted}`)
      this.digestFunction = wanted
    } else {
      // Default stays SHA256 even when the server advertises stronger
      // functions: the Merkle/action encoders digest with the SAME function
      // as every blob upload, and auto-upgrading here while a caller still
      // hashes trees with sha256 would mix functions inside one action —
      // which servers reject at best and mis-address at worst. Opting into
      // another function is `negotiate({ digestFunction: 'SHA512' })`, a
      // caller-level decision made where the tree hashing can follow it.
      this.digestFunction = 'SHA256'
    }
    this.compression =
      prefer?.compression !== false &&
      caps.supportedCompressors.includes('ZSTD') &&
      typeof Bun.zstdCompressSync === 'function'
    this.batchCompression = this.compression && caps.supportedBatchCompressors.includes('ZSTD')
    this.negotiated = caps
  }

  /** The negotiated digest function; SHA256 until `negotiate()` says otherwise. */
  get digest(): DigestFunctionName {
    return this.digestFunction
  }

  /** Whether ByteStream transfers will be zstd-compressed. */
  get compressionEnabled(): boolean {
    return this.compression
  }

  /** Digest a payload under the negotiated function. */
  digestOf(data: Uint8Array): Digest {
    return digestWith(this.digestFunction, data)
  }

  /**
   * `QueryWriteStatus` — how much of a resource the server already holds, so
   * an interrupted upload resumes instead of restarting. Returns null when the
   * server has no record of it (a fresh upload).
   */
  async queryWriteStatus(
    resourceName: string,
  ): Promise<{ committedSize: number; complete: boolean } | null> {
    try {
      const res = await unary<{ committed_size?: string; complete?: boolean }>(
        this.svc.bs,
        'queryWriteStatus',
        { resource_name: resourceName },
        this.meta(),
        this.bounded(),
      )
      return { committedSize: Number(res.committed_size ?? 0), complete: res.complete === true }
    } catch (err) {
      if ((err as grpc.ServiceError).code === NOT_FOUND) return null
      throw err
    }
  }

  /**
   * Upload many small blobs in ONE round trip. The server caps the total
   * (`max_batch_total_size_bytes`, 0 = unspecified → assume the 4 MB gRPC
   * default), so callers must partition; `uploadBlobs` does that and falls
   * back to ByteStream for anything too large on its own.
   */
  async batchUpdateBlobs(
    blobs: ReadonlyArray<{ digest: Digest; data: Uint8Array }>,
  ): Promise<void> {
    if (blobs.length === 0) return
    const res = await unary<{
      responses?: Array<{ digest: Digest; status?: { code?: number; message?: string } }>
    }>(
      this.svc.cas,
      'batchUpdateBlobs',
      {
        instance_name: this.instance,
        requests: blobs.map((b) => ({
          digest: b.digest,
          data: this.batchCompression ? Bun.zstdCompressSync(b.data) : b.data,
          ...(this.batchCompression ? { compressor: 'ZSTD' } : {}),
        })),
        ...(this.digestFunction === 'SHA256' ? {} : { digest_function: this.digestFunction }),
      },
      this.meta(),
      this.bounded(),
    )
    // A batch call succeeds at the RPC layer while individual blobs fail; a
    // silently dropped input blob would surface later as an unexplained
    // remote execution failure, so surface it here.
    for (const r of res.responses ?? []) {
      const code = r.status?.code ?? 0
      if (code !== 0) {
        throw new Error(
          `reapi: BatchUpdateBlobs rejected ${r.digest?.hash}: code ${code} ${r.status?.message ?? ''}`,
        )
      }
    }
  }

  /**
   * Fetch many small blobs, partitioned to the server's batch budget so one
   * call can never exceed the message cap. Missing entries are omitted. When
   * compression was negotiated the request declares ZSTD acceptable and each
   * response is decompressed per its OWN `compressor` field — a server is
   * free to answer some entries compressed and others not.
   */
  async batchReadBlobs(
    digests: readonly Digest[],
    maxBatchBytes = 0,
  ): Promise<Map<string, Uint8Array>> {
    const out = new Map<string, Uint8Array>()
    if (digests.length === 0) return out
    const budget = maxBatchBytes > 0 ? maxBatchBytes : 4 * 1024 * 1024 - 64 * 1024
    let group: Digest[] = []
    let grouped = 0
    const flush = async (): Promise<void> => {
      if (group.length === 0) return
      const res = await unary<{
        responses?: Array<{
          digest: Digest
          data?: Uint8Array
          compressor?: string | number
          status?: { code?: number }
        }>
      }>(
        this.svc.cas,
        'batchReadBlobs',
        {
          instance_name: this.instance,
          digests: group,
          ...(this.compression ? { acceptable_compressors: ['ZSTD'] } : {}),
          ...(this.digestFunction === 'SHA256' ? {} : { digest_function: this.digestFunction }),
        },
        this.meta(),
        this.bounded(),
      )
      for (const r of res.responses ?? []) {
        if ((r.status?.code ?? 0) !== 0 || r.data === undefined) continue
        const zstd = r.compressor === 'ZSTD' || r.compressor === 1
        out.set(r.digest.hash, zstd ? new Uint8Array(Bun.zstdDecompressSync(r.data)) : r.data)
      }
      group = []
      grouped = 0
    }
    for (const d of digests) {
      if (grouped + d.size_bytes > budget && group.length > 0) await flush()
      group.push(d)
      grouped += d.size_bytes
    }
    await flush()
    return out
  }

  /**
   * Upload blobs, choosing the transport per blob: batched while they fit the
   * server's batch budget, ByteStream for the rest. Only what
   * `FindMissingBlobs` reports absent is sent at all.
   */
  async uploadBlobs(
    blobs: ReadonlyArray<{ digest: Digest; data: Uint8Array }>,
    maxBatchBytes = 0,
  ): Promise<void> {
    if (blobs.length === 0) return
    const missing = new Set(
      (await this.findMissingBlobs(blobs.map((b) => b.digest))).map((d) => d.hash),
    )
    const todo = blobs.filter((b) => missing.has(b.digest.hash))
    // 0 means the server did not say; the gRPC default max message is 4 MB and
    // the request carries framing on top, so leave headroom rather than
    // discovering the limit as a RESOURCE_EXHAUSTED mid-run.
    const budget = maxBatchBytes > 0 ? maxBatchBytes : 4 * 1024 * 1024 - 64 * 1024
    let batch: Array<{ digest: Digest; data: Uint8Array }> = []
    let batched = 0
    for (const b of todo) {
      if (b.digest.size_bytes > budget) {
        await this.writeBlob(b.digest, b.data)
        continue
      }
      if (batched + b.digest.size_bytes > budget) {
        await this.batchUpdateBlobs(batch)
        batch = []
        batched = 0
      }
      batch.push(b)
      batched += b.digest.size_bytes
    }
    await this.batchUpdateBlobs(batch)
  }

  /** The subset of `digests` the server does NOT have — the upload-minimality primitive. */
  async findMissingBlobs(digests: readonly Digest[]): Promise<Digest[]> {
    if (digests.length === 0) return []
    const res = await unary<{ missing_blob_digests?: Digest[] }>(
      this.svc.cas,
      'findMissingBlobs',
      { instance_name: this.instance, blob_digests: digests },
      this.meta(),
      this.bounded(),
    )
    return res.missing_blob_digests ?? []
  }

  /** `GetActionResult`; `null` on NOT_FOUND — a miss is not an error. */
  async getActionResult(action: Digest): Promise<ActionResult | null> {
    try {
      return await unary<ActionResult>(
        this.svc.ac,
        'getActionResult',
        { instance_name: this.instance, action_digest: action },
        this.meta(),
        this.bounded(),
      )
    } catch (err) {
      if ((err as grpc.ServiceError).code === NOT_FOUND) return null
      throw err
    }
  }

  async updateActionResult(action: Digest, result: ActionResult): Promise<void> {
    await unary(
      this.svc.ac,
      'updateActionResult',
      { instance_name: this.instance, action_digest: action, action_result: result },
      this.meta(),
      this.bounded(),
    )
  }

  /**
   * Upload a blob via ByteStream, chunked at `chunkBytes`, RESUMING an
   * interrupted identity upload from the server's committed offset
   * (`QueryWriteStatus`) instead of restarting. A compressed upload restarts
   * under a fresh resource name — compressed write offsets count compressed
   * bytes, and mid-stream resumption of a zstd frame is not a thing a server
   * can honour.
   */
  async writeBlob(digest: Digest, body: Uint8Array): Promise<void> {
    // REAPI carries compression in the RESOURCE NAME:
    //   uploads/{uuid}/compressed-blobs/{compressor}/{hash}/{uncompressed_size}
    // The digest and size stay those of the UNCOMPRESSED bytes — the server
    // decompresses and verifies against them — so only the wire payload
    // changes. vx artifacts are already-compressed tarballs, but source input
    // trees are not, and those are the bulk of a remote-execution upload.
    for (let attempt = 0; ; attempt++) {
      const wire = this.compression ? Bun.zstdCompressSync(body) : body
      const segment = this.compression
        ? `compressed-blobs/zstd/${digest.hash}/${digest.size_bytes}`
        : `blobs/${digest.hash}/${digest.size_bytes}`
      const resource = `${this.instance ? `${this.instance}/` : ''}uploads/${crypto.randomUUID()}/${segment}`
      try {
        await this.writeResource(resource, wire, digest, 0)
        return
      } catch (err) {
        const delay = RETRY_DELAYS_MS[attempt]
        if (delay === undefined || !isRetryable((err as grpc.ServiceError).code)) throw err
        if (!this.compression) {
          // Identity path: ask how far the server got and resume there.
          const status = await this.queryWriteStatus(resource).catch(() => null)
          if (status?.complete === true) return
          if (status !== null && status.committedSize > 0 && status.committedSize < wire.length) {
            try {
              await this.writeResource(resource, wire, digest, status.committedSize)
              return
            } catch {
              // fall through to a fresh attempt
            }
          }
        }
        await Bun.sleep(delay)
      }
    }
  }

  private writeResource(
    resource: string,
    body: Uint8Array,
    digest: Digest,
    startOffset: number,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const stream = (this.svc.bs as unknown as Record<string, Function>)['write']!(
        this.meta(),
        this.bounded(),
        (err: grpc.ServiceError | null, res: { committed_size?: string }) => {
          if (err) return reject(err)
          const committed = Number(res.committed_size ?? 0)
          // For a compressed upload the server reports the COMPRESSED byte
          // count it accepted, so the equality only holds on the identity
          // path; on the compressed path a non-zero commit is the signal.
          const expected = this.compression ? body.length : digest.size_bytes
          if (committed !== expected && !(this.compression && committed > 0)) {
            return reject(
              new Error(`reapi: short write for ${digest.hash}: ${committed}/${expected}`),
            )
          }
          resolve()
        },
      ) as { write(m: unknown): boolean; end(): void; on(e: string, f: (x: unknown) => void): void }
      stream.on('error', reject)
      // Empty blobs still need one message so the server sees finish_write.
      let offset = startOffset
      let first = true
      do {
        const end = Math.min(offset + this.chunkBytes, body.length)
        stream.write({
          resource_name: first ? resource : '',
          write_offset: offset,
          finish_write: end === body.length,
          data: body.subarray(offset, end),
        })
        first = false
        offset = end
      } while (offset < body.length)
      stream.end()
    })
  }

  /** Read a blob via ByteStream; `null` on NOT_FOUND. */
  readBlob(digest: Digest): Promise<Uint8Array | null> {
    const segment = this.compression
      ? `compressed-blobs/zstd/${digest.hash}/${digest.size_bytes}`
      : `blobs/${digest.hash}/${digest.size_bytes}`
    const resource = `${this.instance ? `${this.instance}/` : ''}${segment}`
    const compressed = this.compression
    return new Promise((resolve, reject) => {
      const chunks: Uint8Array[] = []
      const stream = (this.svc.bs as unknown as Record<string, Function>)['read']!(
        { resource_name: resource, read_offset: 0, read_limit: 0 },
        this.meta(),
        this.bounded(),
      ) as { on(e: string, f: (x: never) => void): void }
      stream.on('data', (m: { data: Uint8Array }) => chunks.push(m.data))
      stream.on('error', (err: grpc.ServiceError) =>
        err.code === NOT_FOUND ? resolve(null) : reject(err),
      )
      stream.on('end', () => {
        const total = chunks.reduce((n, c) => n + c.length, 0)
        const out = new Uint8Array(total)
        let at = 0
        for (const c of chunks) {
          out.set(c, at)
          at += c.length
        }
        resolve(compressed ? new Uint8Array(Bun.zstdDecompressSync(out)) : out)
      })
    })
  }

  /**
   * `Execute` — a SERVER-STREAMING call yielding `Operation`s until one is
   * `done`. Resolves with the terminal operation. If the stream drops
   * mid-flight with a transient status, the call RE-ATTACHES to the same
   * operation through `WaitExecution` instead of re-running the action —
   * that is exactly what the RPC exists for.
   *
   * `skip_cache_lookup` is TRUE by design: vx has already decided this is a
   * miss (it owns the cache key and consulted its own layers), so letting the
   * server re-check its ActionCache would be a second, differently-keyed
   * cache deciding whether the user's task runs.
   */
  async execute(
    actionDigest: Digest,
    opts: ExecuteOptions = {},
    signal?: AbortSignal,
  ): Promise<Operation> {
    const req = {
      instance_name: this.instance,
      action_digest: actionDigest,
      skip_cache_lookup: opts.skipCacheLookup ?? true,
      // Ask the server to INLINE stdout/stderr in the ActionResult. Without
      // this every finished action costs two extra CAS round trips just to
      // read what it printed.
      inline_stdout: opts.inlineStdout ?? true,
      inline_stderr: opts.inlineStderr ?? true,
      ...(opts.inlineOutputFiles === undefined
        ? {}
        : { inline_output_files: opts.inlineOutputFiles }),
      ...(opts.priority === undefined ? {} : { execution_policy: { priority: opts.priority } }),
      ...(opts.resultsCachePriority === undefined
        ? {}
        : { results_cache_policy: { priority: opts.resultsCachePriority } }),
      ...(this.digestFunction === 'SHA256' ? {} : { digest_function: this.digestFunction }),
    }
    let operationName = ''
    for (let attempt = 0; ; attempt++) {
      try {
        return operationName === ''
          ? await this.operationStream('execute', req, signal, opts.onStage, (n) => {
              operationName = n
            })
          : await this.operationStream(
              'waitExecution',
              { name: operationName },
              signal,
              opts.onStage,
            )
      } catch (err) {
        const delay = RETRY_DELAYS_MS[attempt]
        if (delay === undefined || !isRetryable((err as grpc.ServiceError).code)) throw err
        await Bun.sleep(delay)
      }
    }
  }

  /** Re-attach to an in-flight operation after a disconnect. */
  waitExecution(
    operationName: string,
    signal?: AbortSignal,
    onStage?: (stage: string) => void,
  ): Promise<Operation> {
    return this.operationStream('waitExecution', { name: operationName }, signal, onStage)
  }

  private operationStream(
    method: string,
    req: unknown,
    signal?: AbortSignal,
    onStage?: (stage: string) => void,
    onName?: (name: string) => void,
  ): Promise<Operation> {
    return new Promise((resolve, reject) => {
      const stream = (this.svc.exec as unknown as Record<string, Function>)[method]!(
        req,
        this.meta(),
      ) as { on(e: string, f: (x: never) => void): void; cancel(): void }
      let last: Operation | undefined
      const onAbort = (): void => {
        stream.cancel()
        reject(new Error('reapi: execution aborted'))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      stream.on('data', (op: Operation) => {
        last = op
        if (op.name !== '' && op.name !== undefined && onName !== undefined) onName(op.name)
        // ExecuteOperationMetadata carries the action's STAGE
        // (QUEUED / EXECUTING / COMPLETED). Surfacing it is the difference
        // between "vx is hung" and "the action is queued behind 40 others".
        if (onStage !== undefined && op.metadata?.value !== undefined) {
          const stage = decodeStage(op.metadata.value)
          if (stage !== undefined) onStage(stage)
        }
      })
      stream.on('error', (err: grpc.ServiceError) => {
        signal?.removeEventListener('abort', onAbort)
        reject(err)
      })
      stream.on('end', () => {
        signal?.removeEventListener('abort', onAbort)
        if (last === undefined)
          return reject(new Error('reapi: execution stream closed with no operation'))
        resolve(last)
      })
    })
  }

  /**
   * `SplitBlob` — ask the server to content-defined-chunk a blob and return
   * the chunk digests. With `FindMissingBlobs` over those chunks, a client
   * transfers only the parts of a large blob it does not already hold. Gated
   * by `split_blob_support`; experimental, so callers must check first.
   */
  async splitBlob(blobDigest: Digest): Promise<{ chunks: Digest[]; chunkingFunction: string }> {
    const res = await unary<{ chunk_digests?: Digest[]; chunking_function?: string }>(
      this.svc.cas,
      'splitBlob',
      {
        instance_name: this.instance,
        blob_digest: blobDigest,
        ...(this.digestFunction === 'SHA256' ? {} : { digest_function: this.digestFunction }),
      },
      this.meta(),
      this.bounded(),
    )
    return { chunks: res.chunk_digests ?? [], chunkingFunction: res.chunking_function ?? 'UNKNOWN' }
  }

  /**
   * `SpliceBlob` — the inverse: hand the server an ordered chunk list and it
   * reassembles the blob in CAS, so the client never uploads the parts it
   * already knows are there. Gated by `splice_blob_support`.
   */
  async spliceBlob(chunkDigests: readonly Digest[], expected?: Digest): Promise<Digest> {
    const res = await unary<{ blob_digest?: Digest }>(
      this.svc.cas,
      'spliceBlob',
      {
        instance_name: this.instance,
        chunk_digests: chunkDigests,
        ...(expected === undefined ? {} : { blob_digest: expected }),
        ...(this.digestFunction === 'SHA256' ? {} : { digest_function: this.digestFunction }),
      },
      this.meta(),
      this.bounded(),
    )
    return res.blob_digest ?? { hash: '', size_bytes: 0 }
  }

  /**
   * `GetTree` — page through a Directory tree. Used to materialise an action's
   * output directories, whose children are not in the ActionResult.
   */
  async getTree(rootDigest: Digest): Promise<Directory[]> {
    const out: Directory[] = []
    let pageToken = ''
    do {
      const res: { directories?: Directory[]; next_page_token?: string } = await unary(
        this.svc.cas,
        'getTree',
        { instance_name: this.instance, root_digest: rootDigest, page_token: pageToken },
        this.meta(),
        this.bounded(),
      )
      out.push(...(res.directories ?? []))
      pageToken = res.next_page_token ?? ''
    } while (pageToken !== '')
    return out
  }

  /**
   * Closing the channel-owning stub tears the connection down; the others
   * borrow it, so closing them too would double-close one channel.
   */
  close(): void {
    this.svc.cas.close()
  }
}

/** google.longrunning.Operation, narrowed to what Execute returns. */
export interface Operation {
  name: string
  done: boolean
  /** `google.rpc.Status` when the EXECUTION ITSELF failed (not a non-zero exit). */
  error?: { code?: number; message?: string }
  /** `ExecuteResponse`, packed in an Any. */
  response?: { type_url?: string; value?: Uint8Array }
  /** `ExecuteOperationMetadata`, packed in an Any. */
  metadata?: { type_url?: string; value?: Uint8Array }
}

export interface ExecuteOptions {
  /** Default TRUE: vx owns the cache decision, so the server must not re-check its own AC. */
  skipCacheLookup?: boolean
  inlineStdout?: boolean
  inlineStderr?: boolean
  /** Output files the server should inline in the result, sparing a fetch. */
  inlineOutputFiles?: readonly string[]
  /** `ExecutionPolicy.priority` — lower runs sooner. */
  priority?: number
  /** `ResultsCachePolicy.priority` — retention hint for the result. */
  resultsCachePriority?: number
  /** QUEUED / EXECUTING / COMPLETED as the operation progresses. */
  onStage?: (stage: string) => void
}

const EXEC_STAGE = ['UNKNOWN', 'CACHE_CHECK', 'QUEUED', 'EXECUTING', 'COMPLETED'] as const

/** `ExecuteOperationMetadata { stage = 1 (enum), action_digest = 2, ... }` */
function decodeStage(buf: Uint8Array): string | undefined {
  let i = 0
  while (i < buf.length) {
    let key = 0
    let shift = 0
    for (;;) {
      const b = buf[i++]
      if (b === undefined) return undefined
      key |= (b & 0x7f) << shift
      if ((b & 0x80) === 0) break
      shift += 7
    }
    const field = key >>> 3
    const wire = key & 7
    if (wire === 0) {
      let v = 0
      let sh = 0
      for (;;) {
        const b = buf[i++]
        if (b === undefined) return undefined
        v |= (b & 0x7f) << sh
        if ((b & 0x80) === 0) break
        sh += 7
      }
      if (field === 1) return EXEC_STAGE[v] ?? `STAGE_${v}`
    } else if (wire === 2) {
      let len = 0
      let sh = 0
      for (;;) {
        const b = buf[i++]
        if (b === undefined) return undefined
        len |= (b & 0x7f) << sh
        if ((b & 0x80) === 0) break
        sh += 7
      }
      i += len
    } else break
  }
  return undefined
}

export interface ExecuteResponse {
  result?: ActionResult
  cached_result?: boolean
  status?: { code?: number; message?: string }
  message?: string
}

/** The subset of REAPI's ActionResult a cache entry uses. */
export interface ActionResult {
  exit_code?: number
  output_files?: Array<{
    path: string
    digest: Digest
    is_executable?: boolean
    contents?: Uint8Array
  }>
  output_directories?: Array<{ path: string; tree_digest: Digest }>
  output_symlinks?: Array<{ path: string; target: string }>
  /** Servers MAY normalise inline stdout/stderr into CAS and return digests instead. */
  stdout_digest?: Digest
  stdout_raw?: Uint8Array
  stderr_digest?: Digest
  stderr_raw?: Uint8Array
  execution_metadata?: {
    worker?: string
    execution_start_timestamp?: unknown
    execution_completed_timestamp?: unknown
  }
}
