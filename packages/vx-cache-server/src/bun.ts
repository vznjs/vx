#!/usr/bin/env -S bun --no-env-file --no-install
// `vx-cache-server` on Bun: artifacts in an S3-compatible bucket, nothing
// else, so any number of nodes share one bucket (PROTOCOL.md, README.md).

import { parseArgs } from 'node:util'
import { oidcAuth, parseAllow } from '@vzn/vx-devtools'
import { Refusal } from '@vzn/vx-devtools'
import { createCacheServer, DEFAULT_LIMITS, limitsFrom } from './server.js'
import type { Blobs } from './store.js'

const USAGE = `usage: vx-cache-server [--port 8080] [--host 0.0.0.0]
  ALLOW           who may take part, space separated, each issuer:owner/repo:workflow
                  (README.md § CI tokens); only their jobs' OIDC tokens are taken
  AUDIENCE        the aud a CI token names: the URL clients reach this server at
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
    const res = await fetch(client.presign(name, { method }), { method })
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
      return res === null ? null : Number(res.headers.get('content-length'))
    },
  }
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
  // Number('') is 0: `--port "$PORT"` with PORT unset bound a random port.
  const port = values.port.trim() === '' ? Number.NaN : Number(values.port)
  if (!Number.isInteger(port) || port < 0 || port > 65_535)
    fail(`--port: not a port: ${values.port}`)
  let allow
  let limits
  try {
    allow = parseAllow(env.ALLOW ?? '')
  } catch (err) {
    fail(`ALLOW: ${(err as Error).message}`)
  }
  try {
    limits = { ...DEFAULT_LIMITS, ...limitsFrom(env) }
  } catch (err) {
    fail((err as Error).message)
  }
  // Unset, the audience would be the origin a request names: its Host
  // header, which the client picks. Workers know their own hostnames.
  const audience = env.AUDIENCE?.trim() ?? ''
  if (audience === '')
    fail(`set AUDIENCE: the aud a CI token names, the URL clients reach this server at\n${USAGE}`)
  const handle = createCacheServer({
    blobs: s3Blobs(new Bun.S3Client({ bucket: env.S3_BUCKET })),
    authorize: oidcAuth({
      allow,
      readAccess: env.READ_ACCESS,
      audience,
    }),
    limits,
  })
  const server = Bun.serve({
    hostname: values.host,
    port,
    // The handler measures every body itself, as `{ code, message }`: an
    // upload by its Content-Length before a byte is read, a check as it
    // arrives. Bun's cap, set to the upload limit, refused a check longer
    // than a small one, 413 with no body.
    maxRequestBodySize: Number.MAX_SAFE_INTEGER,
    fetch: handle,
  })
  console.log(`vx-cache-server on ${server.url.href}`)
  const stop = (): void => void server.stop().then(() => process.exit(0))
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`)
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
