#!/usr/bin/env -S bun --no-env-file --no-install
// `vx-cache-server` on Bun: artifacts in an S3-compatible bucket, nothing
// else, so any number of nodes share one bucket (PROTOCOL.md, README.md).

import { parseArgs } from 'node:util'
import { oidcAuth, parseAllow, Refusal, statusLine } from '@vzn/vx-devtools'
import { isCount } from './protocol.js'
import { createCacheServer, DEFAULT_LIMITS, limitsFrom } from './server.js'
import type { Blobs } from './store.js'

const USAGE = `usage: vx-cache-server [--port 8080] [--host 0.0.0.0]
  ALLOW           who may take part, space separated, each issuer:owner/repo:workflow
                  (README.md § CI tokens); only their jobs' OIDC tokens are taken
  AUDIENCE        the aud a CI token names (default: the origin it was sent to)
  READ_ACCESS     public: a request with no token reads a repository ALLOW names
  S3_BUCKET       the bucket; S3_ENDPOINT, S3_REGION, S3_ACCESS_KEY_ID and
                  S3_SECRET_ACCESS_KEY as Bun's S3 client reads them
  MAX_CHECK_HASHES       keys one check names (default ${DEFAULT_LIMITS.maxCheckHashes})
  MAX_UPLOAD_BYTES     the largest upload, one artifact (default ${DEFAULT_LIMITS.maxUploadBytes})`

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

/**
 * The handler on Bun.serve. Bun's own body limit is lifted: the handler
 * refuses an upload past `MAX_UPLOAD_BYTES` by its Content-Length, as a
 * `{ code, message }`, where Bun's 413 had no body and the client warned
 * with no reason.
 */
export function listen(
  fetch: (req: Request) => Promise<Response>,
  hostname: string,
  port: number,
): Bun.Server<undefined> {
  return Bun.serve({ hostname, port, maxRequestBodySize: Number.MAX_SAFE_INTEGER, fetch })
}

function main(argv: string[]): void {
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
  const handle = createCacheServer({
    blobs: s3Blobs(client),
    authorize: oidcAuth({
      allow,
      readAccess: env.READ_ACCESS,
      ...(env.AUDIENCE ? { audience: env.AUDIENCE } : {}),
    }),
    limits,
  })
  const server = listen(handle, values.host, port)
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
  try {
    main(process.argv.slice(2))
  } catch (err) {
    // parseArgs names the flag it refused, not the ones there are.
    const usage = (err as { code?: string }).code?.startsWith('ERR_PARSE_ARGS') ? `\n${USAGE}` : ''
    fail(`${err instanceof Error ? err.message : String(err)}${usage}`)
  }
}
