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

import { LayeredCache, type CacheLayer, type TaskExecutor, type VxPlugin } from '@vzn/vx'
import { ReapiRemoteCache } from './cache.js'
import { reapiExecutor } from './executor.js'
import { ReapiClient, type ReapiOptions } from './wire.js'

export { actionDigestFor, digestOf, ReapiRemoteCache } from './cache.js'
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
  DigestCache,
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

export const REAPI_PLUGIN = 'vx/reapi'

export interface ReapiPluginOptions extends Partial<ReapiOptions> {
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
}

/**
 * Declare in `vx.workspace.ts`, BEFORE `localCachePlugin()` so a remote hit is
 * consulted first:
 *
 * ```ts
 * plugins: [reapi({ endpoint: 'grpc.example.com:443' }), localExecutorPlugin(), localCachePlugin()]
 * ```
 *
 * Declines when no endpoint is configured, so it is safe to leave declared.
 */
function connection(options: ReapiPluginOptions): ReapiOptions | undefined {
  const endpoint = options.endpoint ?? Bun.env['VX_REAPI_ENDPOINT']
  if (endpoint === undefined || endpoint === '') return undefined
  const instanceName = options.instanceName ?? Bun.env['VX_REAPI_INSTANCE']
  return {
    ...options,
    endpoint,
    ...(instanceName === undefined ? {} : { instanceName }),
  }
}

export function reapi(options: ReapiPluginOptions = {}): VxPlugin {
  let executorClient: ReapiClient | undefined
  let remoteCache: ReapiRemoteCache | undefined
  return {
    name: REAPI_PLUGIN,
    async executor(ctx): Promise<TaskExecutor | undefined> {
      const wanted = options.execute === true || Bun.env['VX_REAPI_EXECUTE'] === '1'
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
  }
}
