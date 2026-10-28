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
import { isIP } from 'node:net'
import * as grpc from '@grpc/grpc-js'
import {
  definePlugin,
  type RemoteCacheLayer,
  type TaskExecutor,
  type VxPlugin,
  UserError,
  refuseUnknownOptions,
  type PluginOptionKinds,
} from '@vzn/vx'
import { ReapiRemoteCache } from './cache.js'
import { reapiExecutor } from './executor.js'
import { ReapiClient, type ReapiOptions, usesTls } from './wire.js'

// `ReapiRemoteCache` is public for a workspace that composes cache
// layers by hand; the wire, the Merkle encoders and the executor are
// internal (1.0 freezes what this file exports).
export { ReapiRemoteCache } from './cache.js'
export { type ReapiOptions } from './wire.js'

// The connection's wire form, not the plugin's: the plugin reads PEM FILES
// (`tlsCertificate`, …, checked as a pair) and warns through its own
// context, so `reapi({ onWarn })` was dropped without a word and
// `reapi({ tlsClientCertPem })` skipped the pair check. `ReapiRemoteCache`,
// composed by hand, takes them.
export interface ReapiPluginOptions extends Partial<
  Omit<ReapiOptions, 'tlsCaPem' | 'tlsClientCertPem' | 'tlsClientKeyPem' | 'onWarn'>
> {
  /**
   * Client-side bound on one action, from the EXECUTING transition. See
   * `ReapiExecutorOptions.executeTimeoutMs`; `exec.timeout` wins per task.
   */
  executeTimeoutMs?: number
  /**
   * Bound on the time an action waits QUEUED before a worker starts it. See
   * `ReapiExecutorOptions.queueTimeoutMs`; past it the task runs here.
   */
  queueTimeoutMs?: number
  /**
   * Endpoint (`process.env.REAPI_ENDPOINT` in `.vx/workspace.ts`). Unset
   * or empty, the plugin DECLINES — a declared-but-unconfigured plugin costs nothing and must
   * never fail a run. TLS unless it starts `grpc://`, `http://`, `unix:` or
   * `unix-abstract:`, or `tls: false` is set, as Bazel reads a schemeless
   * `--remote_cache`.
   */
  endpoint?: string
  /**
   * Contribute the `executor` capability too, so tasks RUN on the REAPI
   * server rather than only caching there. Default false: remote execution
   * changes where a user's build runs, which is not something a plugin should
   * switch on merely by being configured for caching.
   */
  execute?: boolean
  /** REAPI platform properties for remote execution (`container-image`, …). */
  platform?: Record<string, string>
  /** Concurrent remote tasks; becomes the scheduler's pool for this executor. */
  capacity?: number
  /**
   * PEM file of the CA that signed the server's certificate, for a server
   * behind a private CA. Bazel's `--tls_certificate`.
   */
  tlsCertificate?: string
  /**
   * PEM files of a client certificate and its key, for a server that asks
   * for mutual TLS. Bazel's `--tls_client_certificate` / `--tls_client_key`.
   */
  tlsClientCertificate?: string
  tlsClientKey?: string
}

/**
 * Declare in `.vx/workspace.ts`; the local store is the floor beneath it and is
 * read first, so the remote is asked only on a local miss:
 *
 * ```ts
 * plugins: [reapi({ endpoint: 'grpcs://grpc.example.com:443' })]
 * ```
 *
 * Declines when no endpoint is configured, so it is safe to leave declared.
 */
function connection(options: ReapiPluginOptions): ReapiOptions | undefined {
  const from = '`reapi({ endpoint })`'
  const endpoint = options.endpoint?.trim()
  if (endpoint === undefined || endpoint === '') return undefined
  assertEndpoint(endpoint, from)
  // A secrets file's trailing newline sent a name no blob is under, and
  // every lookup missed in silence.
  const instanceName = options.instanceName?.trim() || undefined
  // A server behind a private CA, or one that asks for a client
  // certificate, was unreachable: TLS used the system roots and no client
  // pair (F-41). Each is a PEM file, read here; one that cannot be read is
  // a setting to fix, refused naming it.
  const pem = (file: string | undefined, name: string): string | undefined => {
    if (file === undefined || file.trim() === '') return undefined
    try {
      return readFileSync(file.trim(), 'utf8')
    } catch (err) {
      throw new UserError(
        `vx/reapi: \`reapi({ ${name} })\` names ${file.trim()}, which cannot be read (${(err as NodeJS.ErrnoException).code ?? String(err)})`,
      )
    }
  }
  const tlsCaPem = pem(options.tlsCertificate, 'tlsCertificate')
  const tlsClientCertPem = pem(options.tlsClientCertificate, 'tlsClientCertificate')
  const tlsClientKeyPem = pem(options.tlsClientKey, 'tlsClientKey')
  // grpc-js refuses either one alone, with a message that names neither
  // setting.
  if ((tlsClientCertPem === undefined) !== (tlsClientKeyPem === undefined)) {
    throw new UserError(
      'vx/reapi: a client certificate and its key go together — set both tlsClientCertificate and tlsClientKey, or neither',
    )
  }
  if (usesTls({ endpoint, tls: options.tls, tlsCaPem, tlsClientCertPem }) && ipTarget(endpoint)) {
    throw new UserError(
      `vx/reapi: ${from} is ${JSON.stringify(endpoint)}, TLS to an IP address, which Bun cannot open (it refuses an IP as the TLS server name) — name the server by host name, or use grpc:// for plaintext`,
    )
  }
  // Never the option as written: a blank one spread here was sent as the
  // instance name.
  const { instanceName: _written, ...rest } = options
  return {
    ...rest,
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
      `vx/reapi: ${from} is ${JSON.stringify(endpoint)}, which is not host[:port] (e.g. grpcs://cache.example.com:443)`,
    )
  }
}

/**
 * The endpoint names its server by IP address. grpc-js sends the host as
 * the TLS server name, and Bun's TLS throws on an IP there (Node only
 * warns), so every request failed and the remote was never reached.
 */
function ipTarget(endpoint: string): boolean {
  if (/^ipv[46]:/.test(endpoint)) return true
  const host = endpoint
    .replace(/^(https?|grpcs?|dns):\/*/, '')
    .replace(/:\d+$/, '')
    .replace(/^\[(.*)\]$/, '$1')
  return isIP(host) !== 0
}

/** Each option `ReapiPluginOptions` names, with its kind: derived from the type, so the two cannot drift. */
const REAPI_PLUGIN_KEYS: PluginOptionKinds<ReapiPluginOptions> = {
  executeTimeoutMs: 'number',
  queueTimeoutMs: 'number',
  endpoint: 'string',
  execute: 'boolean',
  platform: 'object',
  capacity: 'number',
  tlsCertificate: 'string',
  tlsClientCertificate: 'string',
  tlsClientKey: 'string',
  instanceName: 'string',
  headers: 'object',
  tls: 'boolean',
  toolName: 'string',
  toolVersion: 'string',
  correlatedInvocationsId: 'string',
  callTimeoutMs: 'number',
  metaTimeoutMs: 'number',
  chunkBytes: 'number',
}

/**
 * `headers` and `platform` map names to strings. A value read from an unset
 * variable (`process.env.KEY!`) is undefined: the header check read it as
 * the text "undefined", and grpc-js then spun on every call until its
 * deadline (15 s each, no word of why), and a platform value reached the
 * worker as "undefined".
 */
function refuseNonStringValues(name: 'headers' | 'platform', map: object | undefined): void {
  for (const [key, value] of Object.entries(map ?? {})) {
    if (typeof value === 'string') continue
    throw new UserError(
      `reapi() option "${name}" must map each name to a string — ${JSON.stringify(key)} is ${JSON.stringify(value) ?? String(value)} (an unset environment variable?)`,
    )
  }
}

export function reapi(options: ReapiPluginOptions = {}): VxPlugin {
  refuseUnknownOptions('reapi()', options, REAPI_PLUGIN_KEYS)
  refuseNonStringValues('headers', options.headers)
  refuseNonStringValues('platform', options.platform)
  let executorClient: ReapiClient | undefined
  let remoteCache: ReapiRemoteCache | undefined
  return definePlugin(import.meta, {
    async executor(ctx): Promise<TaskExecutor | undefined> {
      // Before the connection: with execute off, an unreadable PEM is the
      // cache hook's to refuse, never a failure "in executor".
      if (options.execute !== true) return undefined
      const conn = connection(options)
      if (conn === undefined) return undefined
      executorClient = new ReapiClient({ ...conn, onWarn: (m) => ctx.warn(m) })
      // Negotiate once: turns zstd transfer compression on when the server
      // advertises it. The digest function stays SHA256 (see wire.negotiate).
      // An unreachable or wrong endpoint surfaces here, and the raw gRPC
      // string ("14 UNAVAILABLE … Resolution note:") names neither the
      // plugin's setting nor anything to do about it. Core turns a throwing
      // factory into a UserError and ABORTS — deliberately, an executor is
      // load-bearing — so this is the message a user acts on.
      // Both asks: a failed second one escaped as the raw status, naming
      // neither the server nor the setting.
      let caps: Awaited<ReturnType<ReapiClient['capabilities']>>
      try {
        await executorClient.negotiate()
        caps = await executorClient.capabilities()
      } catch (err) {
        executorClient.close()
        executorClient = undefined
        const why = err instanceof Error ? err.message : String(err)
        // A server that answered with a refusal was reached: the endpoint
        // advice sent the user to check everything but the token.
        const code = (err as { code?: unknown } | null)?.code
        if (code === grpc.status.UNAUTHENTICATED || code === grpc.status.PERMISSION_DENIED) {
          throw new Error(
            `the REAPI server at ${conn.endpoint} refused the credentials for remote execution: ${why} — check the token in \`headers\`, or drop \`execute\` to use it as a cache only`,
          )
        }
        throw new Error(
          `cannot reach the REAPI server at ${conn.endpoint} for remote execution: ${why} — check the endpoint, that the server is running, and that this host can reach it, or drop \`execute\` to use it as a cache only`,
        )
      }
      // A cache-only deployment (bazel-remote) advertises no execution
      // capability. Offering it work would hang the run on a server that will
      // never answer, so DECLINE loudly and let the local executor take over.
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
        ...(options.queueTimeoutMs === undefined ? {} : { queueTimeoutMs: options.queueTimeoutMs }),
        warn: (m) => ctx.warn(m),
      })
    },
    teardown(): void {
      executorClient?.close()
      executorClient = undefined
      // The cache layer holds a client too, and `RemoteCacheLayer` has no
      // close hook for core to call — core closes only its
      // LOCAL handle. Closing it here is lifecycle hygiene rather than a
      // measured fix: @grpc/grpc-js pools subchannels per target, so 20
      // unclosed clients were MEASURED to share one connection. It matters
      // for `vx watch`, which installs and tears down plugins once per
      // re-run, and it keeps the resource owned by whoever created it.
      remoteCache?.close()
      remoteCache = undefined
    },
    cache(ctx): RemoteCacheLayer | undefined {
      const conn = connection(options)
      if (conn === undefined) return undefined
      // Only the wire: core layers it over the local store (reads try local,
      // then remote, hydrating local on a hit; uploads drain in the background).
      remoteCache = new ReapiRemoteCache({ ...conn, onWarn: (m) => ctx.warn(m) })
      return remoteCache
    },
  })
}
