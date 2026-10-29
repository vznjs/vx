#!/usr/bin/env -S bun --no-env-file --no-install
// `vx-cache-server` on Bun: artifacts in an S3-compatible bucket, nothing
// else, so any number of nodes share one bucket (PROTOCOL.md, README.md).

import { once } from 'node:events'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Readable } from 'node:stream'
import { parseArgs } from 'node:util'
import { oidcAuth, parseAllow, Refusal, statusLine } from '@vzn/vx-devtools'
import { isCount } from './protocol.js'
import { createCacheServer, DEFAULT_LIMITS, limitsFrom } from './server.js'
import type { Blobs } from './store.js'

const USAGE = `usage: vx-cache-server [--port 8080] [--host 0.0.0.0]
  ALLOW           who may take part, space separated, each issuer:owner/repo:workflow
                  (README.md § CI tokens); only their jobs' OIDC tokens are taken
  AUDIENCE        the aud a CI token names: the URL clients reach this server at
  READ_ACCESS     public: a request with no token reads a repository ALLOW names
  S3_BUCKET       the bucket; S3_ENDPOINT, S3_REGION, S3_ACCESS_KEY_ID and
                  S3_SECRET_ACCESS_KEY as Bun's S3 client reads them
  MAX_CHECK_HASHES  lookups one check makes, hashes × scopes (default ${DEFAULT_LIMITS.maxCheckHashes})
  MAX_UPLOAD_BYTES  the largest upload, one artifact (default ${DEFAULT_LIMITS.maxUploadBytes})`

/**
 * An S3-compatible bucket through Bun's S3 client. Reads go through a
 * presigned URL: one request answers a GET's bytes and size, or its 404,
 * and Bun answers `new Response(s3File)` with a redirect a client may not
 * reach.
 */
export function s3Blobs(client: Bun.S3Client): Blobs {
  const ask = async (name: string, method: 'GET' | 'HEAD'): Promise<Response | null> => {
    // Identity: Bun's fetch asks for gzip and inflates it, and a
    // compressed answer's Content-Length is not the artifact's size.
    const res = await fetch(client.presign(name, { method }), {
      method,
      headers: { 'accept-encoding': 'identity' },
    })
    if (res.status === 404) {
      await res.body?.cancel()
      return null
    }
    if (!res.ok) {
      await res.body?.cancel()
      throw new Error(`the bucket answered ${method} ${res.status}`)
    }
    return res
  }
  return {
    async put(name, body, size) {
      let seen = 0
      const counted = body.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            seen += chunk.byteLength
            if (seen > size) throw new Refusal(400, `the body is longer than ${size} bytes`)
            controller.enqueue(chunk)
          },
          flush() {
            if (seen !== size) throw new Refusal(400, `the body is ${seen} bytes, not ${size}`)
          },
        }),
      )
      await client.write(name, new Response(counted))
    },
    async get(name) {
      const res = await ask(name, 'GET')
      if (res === null) return null
      return {
        body: res.body ?? new Blob([]).stream(),
        size: Number(res.headers.get('content-length')),
      }
    },
    async size(name) {
      const res = await ask(name, 'HEAD')
      if (res === null) return null
      // Number(null) is 0: a HEAD naming no length is no size, not an empty artifact.
      const length = res.headers.get('content-length')
      const size = length === null || length.trim() === '' ? Number.NaN : Number(length)
      if (!isCount(size)) throw new Error('the bucket answered HEAD with no Content-Length')
      return size
    },
  }
}

/** A server `listen` started. */
export interface Listening {
  readonly url: URL
  stop(): Promise<void>
}

/** A request that sends no bytes for this long is ended, as Bun.serve's `idleTimeout` did. */
const IDLE_MS = 10_000

/**
 * The handler on node:http, not Bun.serve: Bun.serve (1.4.4) sends a
 * streamed answer chunked and drops its Content-Length, so a download
 * past one chunk came without the length PROTOCOL.md promises; Bun's
 * node:http keeps it. No body limit: the handler refuses an upload past
 * `MAX_UPLOAD_BYTES` by its Content-Length, as a `{ code, message }`. No
 * whole-request deadline either: a big upload at a steady pace takes
 * what it takes, and one that stops is ended after `IDLE_MS`.
 */
export async function listen(
  fetch: (req: Request) => Promise<Response>,
  hostname: string,
  port: number,
  idleMs = IDLE_MS,
): Promise<Listening> {
  const server = createServer({ requestTimeout: 0 }, (req, res) => {
    // An unheard rejection would end the process: every node it serves.
    serve(fetch, req, res).catch(() => res.destroy())
  })
  server.timeout = idleMs
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, hostname, () => {
      server.off('error', reject)
      resolve()
    })
  })
  const bound = (server.address() as AddressInfo).port
  const host = hostname.includes(':') ? `[${hostname}]` : hostname
  return {
    url: new URL(`http://${host}:${bound}/`),
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      }),
  }
}

/** One request through `fetch`, its answer written back at the pace the client takes it. */
async function serve(
  fetch: (req: Request) => Promise<Response>,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const gone = new AbortController()
  res.once('close', () => gone.abort())
  const headers = new Headers()
  for (let i = 0; i < req.rawHeaders.length; i += 2)
    headers.append(req.rawHeaders[i]!, req.rawHeaders[i + 1]!)
  const bodied = req.method !== 'GET' && req.method !== 'HEAD'
  let answer: Response
  try {
    answer = await fetch(
      new Request(`http://${req.headers.host ?? 'localhost'}${req.url ?? '/'}`, {
        method: req.method ?? 'GET',
        headers,
        signal: gone.signal,
        ...(bodied ? { body: Readable.toWeb(req) as ReadableStream, duplex: 'half' as const } : {}),
      }),
    )
  } catch (err) {
    // The handler answers every refusal itself: only a request it was never handed lands here.
    answer = Response.json(
      { code: 'bad_request', message: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    )
  }
  res.statusCode = answer.status
  answer.headers.forEach((value, name) => res.setHeader(name, value))
  if (answer.body === null || req.method === 'HEAD') {
    await answer.body?.cancel()
    res.end()
    return
  }
  try {
    for await (const chunk of answer.body) {
      if (!res.write(chunk)) await once(res, 'drain', { signal: gone.signal })
    }
    res.end()
  } catch {
    // quiet: a client gone or a bucket cut mid-body; the cut connection says it, never a short answer whole
    res.destroy()
  }
}

async function main(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      port: { type: 'string', default: '8080' },
      host: { type: 'string', default: '0.0.0.0' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  })
  if (values.help) {
    console.log(USAGE)
    return
  }
  const env = Bun.env
  if (env.S3_BUCKET === undefined || env.S3_BUCKET === '') fail(`set S3_BUCKET\n${USAGE}`)
  // Digits only: Number('') is 0, a random port for `--port "$PORT"` with
  // PORT unset, and Number read 0x50 as 80 and 1e1 as 10.
  const port = /^\d+$/.test(values.port) ? Number(values.port) : Number.NaN
  if (!Number.isInteger(port) || port < 0 || port > 65_535)
    fail(`--port: not a port: ${values.port}`)
  // '' names no address: Bun.serve read it as localhost, unreachable from another host or container.
  if (values.host.trim() === '') fail(`--host: needs an address, got '${values.host}'`)
  let allow
  let limits
  try {
    allow = parseAllow(env.ALLOW ?? '')
  } catch (err) {
    fail(`ALLOW: ${(err as Error).message}`)
  }
  // An empty one started a server that refused every request.
  if (allow.length === 0) fail(`set ALLOW\n${USAGE}`)
  try {
    limits = { ...DEFAULT_LIMITS, ...limitsFrom(env) }
  } catch (err) {
    fail((err as Error).message)
  }
  const client = new Bun.S3Client({ bucket: env.S3_BUCKET })
  try {
    // Signs offline: refuses missing credentials now, not every request 502.
    client.presign('vx-cache-server')
  } catch (err) {
    fail(`S3: ${(err as Error).message}`)
  }
  // Unset, the audience would be the origin a request names: its Host
  // header, which the client picks. Workers know their own hostnames.
  const audience = env.AUDIENCE?.trim() ?? ''
  if (audience === '')
    fail(`set AUDIENCE: the aud a CI token names, the URL clients reach this server at\n${USAGE}`)
  const handle = createCacheServer({
    blobs: s3Blobs(client),
    authorize: oidcAuth({
      allow,
      readAccess: env.READ_ACCESS,
      audience,
    }),
    limits,
  })
  const server = await listen(handle, values.host, port)
  process.stdout.write(statusLine('ok', 'vx-cache-server', `listening on ${server.url.href}`))
  const stop = (): void => void server.stop().then(() => process.exit(0))
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

function fail(message: string): never {
  process.stderr.write(statusLine('err', 'vx-cache-server', message))
  process.exit(2)
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    // parseArgs names the flag it refused, not the ones there are.
    const usage = (err as { code?: string }).code?.startsWith('ERR_PARSE_ARGS') ? `\n${USAGE}` : ''
    fail(`${err instanceof Error ? err.message : String(err)}${usage}`)
  })
}
