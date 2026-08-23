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

import { LayeredCache, type CacheLayer, type VxPlugin } from '@vzn/vx'
import { ReapiRemoteCache } from './cache.js'
import type { ReapiOptions } from './wire.js'

export { actionDigestFor, digestOf, ReapiRemoteCache } from './cache.js'
export {
  assertBunSupportsChunking,
  CHUNK_BYTES,
  MIN_BUN,
  ReapiClient,
  SAFE_CHUNK_BYTES,
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
export function reapi(options: ReapiPluginOptions = {}): VxPlugin {
  return {
    name: REAPI_PLUGIN,
    cache(ctx): CacheLayer | undefined {
      const endpoint = options.endpoint ?? Bun.env['VX_REAPI_ENDPOINT']
      if (endpoint === undefined || endpoint === '') return undefined
      const remote = new ReapiRemoteCache({
        ...options,
        endpoint,
        ...(options.instanceName === undefined && Bun.env['VX_REAPI_INSTANCE'] !== undefined
          ? { instanceName: Bun.env['VX_REAPI_INSTANCE'] }
          : {}),
      })
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
