// @vzn/vx-reapi — a vx `cache` plugin backed by any server speaking Bazel's
// Remote Execution API (NativeLink, BuildBuddy, Buildbarn, bazel-remote).
//
// Phase 1 is the remote CACHE only: artifacts live in the CAS, addressed
// through an ActionCache entry derived from the vx cache key. Remote
// EXECUTION (the `executor` capability) is a later phase — see
// docs/design/plugin-executor-reapi-2026-08.md.
//
// Imports core only through the public `@vzn/vx` specifier, like every other
// plugin, so nothing here depends on core's internal layout.

import { readFileSync } from 'node:fs'
import {
  definePlugin,
  LayeredCache,
  type CacheLayer,
  type TaskExecutor,
  type VxPlugin,
  UserError,
} from '@vzn/vx'
import { ReapiRemoteCache } from './cache.js'
import { reapiExecutor } from './executor.js'
import { ReapiClient, type ReapiOptions } from './wire.js'

export { ReapiRemoteCache } from './cache.js'
export {
  acceptsTask,
  globToOutputPath,
  outputPathSets,
  reapiExecutor,
  type OutputPathSets,
  type ReapiExecutorOptions,
} from './executor.js'
export {
  buildInputTree,
  canDigest,
  COMPRESSOR,
  decodeDirectory,
  decodeTree,
  DIGEST_FUNCTION,
  digestWith,
  encodeAction,
  encodeCommand,
  encodeDigest,
  encodeDirectory,
  encodeNodeProperties,
  OUTPUT_DIRECTORY_FORMAT,
  sha256,
  type Blob,
  type DigestFunctionName,
  type InputTree,
  type NodeProperties,
} from './merkle.js'
export {
  assertBunSupportsChunking,
  CHUNK_BYTES,
  MIN_BUN,
  ReapiClient,
  SAFE_CHUNK_BYTES,
  type ExecuteOptions,
  type ExecuteResponse,
  type Operation,
  type ServerCapabilities,
  type ActionResult,
  type Digest,
  type ReapiOptions,
} from './wire.js'

export interface ReapiPluginOptions extends Partial<ReapiOptions> {
  /**
   * Client-side bound on one action, from the EXECUTING transition. See
   * `ReapiExecutorOptions.executeTimeoutMs`; `exec.timeout` wins per task.
   */
  executeTimeoutMs?: number
  /**
   * Endpoint, or omit to read `VX_REAPI_ENDPOINT`. With neither the plugin
   * DECLINES — a declared-but-unconfigured plugin costs nothing and must
   * never fail a run.
   */
  endpoint?: string
  /**
   * Contribute the `executor` capability too, so tasks RUN on the REAPI
   * server rather than only caching there. Default false: remote execution
   * changes where a user's build runs, which is not something a plugin should
   * switch on merely by being configured for caching. `VX_REAPI_EXECUTE=1`
   * also enables it.
   */
  execute?: boolean
  /** REAPI platform properties for remote execution (`container-image`, …). */
  platform?: Record<string, string>
  /** Concurrent remote tasks; becomes the scheduler's pool for this executor. */
  capacity?: number
  /**
   * PEM file of the CA that signed the server's certificate, for a server
   * behind a private CA. Falls back to `VX_REAPI_TLS_CERTIFICATE`. Bazel's
   * `--tls_certificate`.
   */
  tlsCertificate?: string
  /**
   * PEM files of a client certificate and its key, for a server that asks
   * for mutual TLS (`VX_REAPI_TLS_CLIENT_CERTIFICATE` / `_KEY`). Bazel's
   * `--tls_client_certificate` / `--tls_client_key`.
   */
  tlsClientCertificate?: string
  tlsClientKey?: string
}

/**
 * Declare in `vx.workspace.ts`; the local store is the floor beneath it and is
 * read first, so the remote is asked only on a local miss:
 *
 * ```ts
 * plugins: [reapi({ endpoint: 'grpcs://grpc.example.com:443' })]
 * ```
 *
 * Declines when no endpoint is configured, so it is safe to leave declared.
 */
function connection(options: ReapiPluginOptions): ReapiOptions | undefined {
  // `process.env`, not `Bun.env`, for core's reason (exec/sandbox-runtime.ts):
  // an embedder that replaces the env object leaves `Bun.env` on the old one.
  const from = options.endpoint !== undefined ? '`reapi({ endpoint })`' : 'VX_REAPI_ENDPOINT'
  const endpoint = (options.endpoint ?? process.env['VX_REAPI_ENDPOINT'])?.trim()
  if (endpoint === undefined || endpoint === '') return undefined
  assertEndpoint(endpoint, from)
  const instanceName = options.instanceName ?? process.env['VX_REAPI_INSTANCE']
  // A server behind a private CA, or one that asks for a client
  // certificate, was unreachable: TLS used the system roots and no client
  // pair (F-41). Each is a PEM file, read here; one that cannot be read is
  // a setting to fix, refused naming it.
  const pem = (
    option: string | undefined,
    name: string,
    fromEnv: string | undefined,
    env: string,
  ): string | undefined => {
    const file = option ?? fromEnv?.trim()
    if (file === undefined || file === '') return undefined
    try {
      return readFileSync(file, 'utf8')
    } catch (err) {
      const from = option !== undefined ? `\`reapi({ ${name} })\`` : env
      throw new UserError(
        `vx/reapi: ${from} names ${file}, which cannot be read (${(err as NodeJS.ErrnoException).code ?? String(err)})`,
      )
    }
  }
  const tlsCaPem = pem(
    options.tlsCertificate,
    'tlsCertificate',
    process.env['VX_REAPI_TLS_CERTIFICATE'],
    'VX_REAPI_TLS_CERTIFICATE',
  )
  const tlsClientCertPem = pem(
    options.tlsClientCertificate,
    'tlsClientCertificate',
    process.env['VX_REAPI_TLS_CLIENT_CERTIFICATE'],
    'VX_REAPI_TLS_CLIENT_CERTIFICATE',
  )
  const tlsClientKeyPem = pem(
    options.tlsClientKey,
    'tlsClientKey',
    process.env['VX_REAPI_TLS_CLIENT_KEY'],
    'VX_REAPI_TLS_CLIENT_KEY',
  )
  // grpc-js refuses either one alone, with a message that names neither
  // setting.
  if ((tlsClientCertPem === undefined) !== (tlsClientKeyPem === undefined)) {
    throw new UserError(
      'vx/reapi: a client certificate and its key go together — set both tlsClientCertificate and tlsClientKey (VX_REAPI_TLS_CLIENT_CERTIFICATE / VX_REAPI_TLS_CLIENT_KEY), or neither',
    )
  }
  return {
    ...options,
    endpoint,
    ...(instanceName === undefined ? {} : { instanceName }),
    ...(tlsCaPem === undefined ? {} : { tlsCaPem }),
    ...(tlsClientCertPem === undefined ? {} : { tlsClientCertPem }),
    ...(tlsClientKeyPem === undefined ? {} : { tlsClientKeyPem }),
  }
}

/**
 * A malformed endpoint failed each request on its own, far from the setting:
 * `http://` failed the run with grpc's `Could not parse target name ""`, and
 * `host:notaport` or a lone space degraded every request to a miss (F-14).
 * Refused once, naming where it came from.
 */
function assertEndpoint(endpoint: string, from: string): void {
  // A grpc-js resolver target (`unix:/run/cas.sock`, `dns:///host:443`) is
  // grpc's to parse.
  if (/^(unix|unix-abstract|dns|ipv4|ipv6):/.test(endpoint)) return
  const target = endpoint.replace(/^(https?|grpcs?):\/\//, '')
  const m = /^(\[[^\]]+\]|[^:/\s]+)(?::(\d+))?$/.exec(target)
  const port = m?.[2] === undefined ? undefined : Number(m[2])
  if (m === null || (port !== undefined && (port < 1 || port > 65_535))) {
    throw new UserError(
      `vx/reapi: ${from} is ${JSON.stringify(endpoint)}, which is not host[:port] (e.g. cache.example.com:443 or grpcs://cache.example.com)`,
    )
  }
}

export function reapi(options: ReapiPluginOptions = {}): VxPlugin {
  let executorClient: ReapiClient | undefined
  let remoteCache: ReapiRemoteCache | undefined
  return definePlugin(import.meta, {
    async executor(ctx): Promise<TaskExecutor | undefined> {
      const wanted = options.execute === true || process.env['VX_REAPI_EXECUTE'] === '1'
      const conn = connection(options)
      if (!wanted || conn === undefined) return undefined
      executorClient = new ReapiClient({ ...conn, onWarn: (m) => ctx.warn(m) })
      // Negotiate once: turns zstd transfer compression on when the server
      // advertises it. The digest function stays SHA256 (see wire.negotiate).
      // An unreachable or wrong endpoint surfaces here, and the raw gRPC
      // string ("14 UNAVAILABLE … Resolution note:") names neither the
      // plugin's setting nor anything to do about it. Core turns a throwing
      // factory into a UserError and ABORTS — deliberately, an executor is
      // load-bearing — so this is the message a user acts on.
      try {
        await executorClient.negotiate()
      } catch (err) {
        executorClient.close()
        executorClient = undefined
        const why = err instanceof Error ? err.message : String(err)
        throw new Error(
          `cannot reach the REAPI server at ${conn.endpoint} for remote execution: ${why} — check the endpoint, that the server is running, and that this host can reach it, or drop \`execute\` to use it as a cache only`,
        )
      }
      // A cache-only deployment (bazel-remote) advertises no execution
      // capability. Offering it work would hang the run on a server that will
      // never answer, so DECLINE loudly and let the local executor take over.
      const caps = await executorClient.capabilities()
      if (!caps.execEnabled) {
        ctx.warn(
          `vx/reapi: ${conn.endpoint} does not advertise remote execution (cache only) — tasks will run locally`,
        )
        executorClient.close()
        executorClient = undefined
        return undefined
      }
      return reapiExecutor(executorClient, {
        ...(options.platform === undefined ? {} : { platform: options.platform }),
        ...(options.capacity === undefined ? {} : { capacity: options.capacity }),
        ...(options.executeTimeoutMs === undefined
          ? {}
          : { executeTimeoutMs: options.executeTimeoutMs }),
        warn: (m) => ctx.warn(m),
      })
    },
    teardown(): void {
      executorClient?.close()
      executorClient = undefined
      // The cache layer holds a client too, and `RemoteCacheLayer` has no
      // close hook for core to call — `LayeredCache.close()` closes only the
      // LOCAL handle. Closing it here is lifecycle hygiene rather than a
      // measured fix: @grpc/grpc-js pools subchannels per target, so 20
      // unclosed clients were MEASURED to share one connection. It matters
      // for `vx watch`, which installs and tears down plugins once per
      // re-run, and it keeps the resource owned by whoever created it.
      remoteCache?.close()
      remoteCache = undefined
    },
    cache(ctx): CacheLayer | undefined {
      const conn = connection(options)
      if (conn === undefined) return undefined
      const remote = new ReapiRemoteCache({ ...conn, onWarn: (m) => ctx.warn(m) })
      remoteCache = remote
      // Compose over the local handle the host opened: reads try local, then
      // remote (hydrating local on a remote hit); writes go local immediately
      // and the remote upload drains in the background. All of that is core's
      // LayeredCache — this plugin supplies only the wire.
      return new LayeredCache(ctx.localCache, remote, {
        policy: ctx.policy,
        onRemoteError: (err) => ctx.warn(`vx/reapi: ${err.message}`),
      })
    },
  })
}
