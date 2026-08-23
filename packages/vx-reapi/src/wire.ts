// The gRPC surface of the Bazel Remote Execution API that a remote CACHE
// needs: ContentAddressableStorage, ActionCache, ByteStream, Capabilities.
// `@grpc/proto-loader` parses the vendored protos (28ms) and `@grpc/grpc-js`
// carries the calls.

import * as grpc from '@grpc/grpc-js'
import * as protoLoader from '@grpc/proto-loader'
import path from 'node:path'

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
}

function loadServices(target: string, creds: grpc.ChannelCredentials): ServiceClients {
  const reapi = grpc.loadPackageDefinition(
    protoLoader.loadSync('build/bazel/remote/execution/v2/remote_execution.proto', LOAD_OPTIONS),
  ) as unknown as {
    build: {
      bazel: { remote: { execution: { v2: Record<string, new (...a: unknown[]) => grpc.Client> } } }
    }
  }
  const bytestream = grpc.loadPackageDefinition(
    protoLoader.loadSync('google/bytestream/bytestream.proto', LOAD_OPTIONS),
  ) as unknown as { google: { bytestream: Record<string, new (...a: unknown[]) => grpc.Client> } }
  const v2 = reapi.build.bazel.remote.execution.v2
  return {
    cas: new v2['ContentAddressableStorage']!(target, creds),
    ac: new v2['ActionCache']!(target, creds),
    caps: new v2['Capabilities']!(target, creds),
    bs: new bytestream.google.bytestream['ByteStream']!(target, creds),
  }
}

/** Promisified unary call. Rejects with the gRPC error (`err.code` is the status). */
function unary<T>(
  client: grpc.Client,
  method: string,
  req: unknown,
  meta: grpc.Metadata,
): Promise<T> {
  return new Promise((resolve, reject) => {
    ;(client as unknown as Record<string, Function>)[method]!(
      req,
      meta,
      (err: grpc.ServiceError | null, res: T) => (err ? reject(err) : resolve(res)),
    )
  })
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
    this.chunkBytes = opts.chunkBytes ?? CHUNK_BYTES
    if (!Number.isInteger(this.chunkBytes) || this.chunkBytes < 1) {
      throw new Error(
        `@vzn/vx-reapi: chunkBytes must be a positive integer (got ${this.chunkBytes})`,
      )
    }
  }

  private meta(): grpc.Metadata {
    const m = new grpc.Metadata()
    for (const [k, v] of Object.entries(this.headers)) m.set(k, v)
    return m
  }

  /** `GetCapabilities` — used by `vx info`-style probes and to verify a connection. */
  async capabilities(): Promise<{ digestFunctions: string[]; maxBatchBytes: number }> {
    const res = await unary<{
      cache_capabilities?: { digest_functions?: string[]; max_batch_total_size_bytes?: string }
    }>(this.svc.caps, 'getCapabilities', { instance_name: this.instance }, this.meta())
    return {
      digestFunctions: res.cache_capabilities?.digest_functions ?? [],
      maxBatchBytes: Number(res.cache_capabilities?.max_batch_total_size_bytes ?? 0),
    }
  }

  /** The subset of `digests` the server does NOT have — the upload-minimality primitive. */
  async findMissingBlobs(digests: readonly Digest[]): Promise<Digest[]> {
    if (digests.length === 0) return []
    const res = await unary<{ missing_blob_digests?: Digest[] }>(
      this.svc.cas,
      'findMissingBlobs',
      { instance_name: this.instance, blob_digests: digests },
      this.meta(),
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
    )
  }

  /**
   * Upload a blob via ByteStream, chunked at CHUNK_BYTES. Resolves once the
   * server commits the full length; a short commit is an error rather than a
   * silent partial upload.
   */
  writeBlob(digest: Digest, body: Uint8Array): Promise<void> {
    const resource = `${this.instance ? `${this.instance}/` : ''}uploads/${crypto.randomUUID()}/blobs/${digest.hash}/${digest.size_bytes}`
    return new Promise((resolve, reject) => {
      const stream = (this.svc.bs as unknown as Record<string, Function>)['write']!(
        this.meta(),
        (err: grpc.ServiceError | null, res: { committed_size?: string }) => {
          if (err) return reject(err)
          const committed = Number(res.committed_size ?? 0)
          if (committed !== digest.size_bytes) {
            return reject(
              new Error(`reapi: short write for ${digest.hash}: ${committed}/${digest.size_bytes}`),
            )
          }
          resolve()
        },
      ) as { write(m: unknown): boolean; end(): void; on(e: string, f: (x: unknown) => void): void }
      stream.on('error', reject)
      // Empty blobs still need one message so the server sees finish_write.
      let offset = 0
      do {
        const end = Math.min(offset + this.chunkBytes, body.length)
        stream.write({
          resource_name: offset === 0 ? resource : '',
          write_offset: offset,
          finish_write: end === body.length,
          data: body.subarray(offset, end),
        })
        offset = end
      } while (offset < body.length)
      stream.end()
    })
  }

  /** Read a blob via ByteStream; `null` on NOT_FOUND. */
  readBlob(digest: Digest): Promise<Uint8Array | null> {
    const resource = `${this.instance ? `${this.instance}/` : ''}blobs/${digest.hash}/${digest.size_bytes}`
    return new Promise((resolve, reject) => {
      const chunks: Uint8Array[] = []
      const stream = (this.svc.bs as unknown as Record<string, Function>)['read']!(
        { resource_name: resource, read_offset: 0, read_limit: 0 },
        this.meta(),
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
        resolve(out)
      })
    })
  }

  close(): void {
    for (const c of Object.values(this.svc)) c.close()
  }
}

/** The subset of REAPI's ActionResult a cache entry uses. */
export interface ActionResult {
  exit_code?: number
  output_files?: Array<{ path: string; digest: Digest; is_executable?: boolean }>
  /** Servers MAY normalise inline stdout into a CAS blob and return this instead. */
  stdout_digest?: Digest
  stdout_raw?: Uint8Array
  execution_metadata?: {
    execution_start_timestamp?: unknown
    execution_completed_timestamp?: unknown
  }
}
