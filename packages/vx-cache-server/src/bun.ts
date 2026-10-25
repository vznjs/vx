#!/usr/bin/env -S bun --no-env-file --no-install
// `vx-cache-server` on Bun: blobs in an S3-compatible bucket, the rest in a
// SQLite file (PROTOCOL.md, README.md).

import { Database } from 'bun:sqlite'
import { parseArgs } from 'node:util'
import { parseTokens, tokenAuth } from './auth.js'
import { anyAuth, oidcAuth, parseTrust } from './oidc.js'
import { Refusal } from './protocol.js'
import { createCacheServer, DEFAULT_MAX_ARTIFACT_BYTES } from './server.js'
import type { Blobs, Db } from './store.js'

const USAGE = `usage: vx-cache-server [--db vx-cache.sqlite] [--port 8080] [--host 0.0.0.0]
  TOKENS          who may read and write: read:<sha256> write:<sha256>, space separated
  TRUST           CI OIDC trust rules, a JSON list (README.md § CI tokens)
  AUDIENCE        the aud a CI token names (default: the origin it was sent to)
  S3_BUCKET       the bucket; S3_ENDPOINT, S3_REGION, S3_ACCESS_KEY_ID and
                  S3_SECRET_ACCESS_KEY as Bun's S3 client reads them
  MAX_ARTIFACT_BYTES  the largest artifact stored (default ${DEFAULT_MAX_ARTIFACT_BYTES})`

/** A SQLite file through bun:sqlite. */
export function sqliteDb(path: string): Db {
  const db = new Database(path, { create: true, strict: true })
  db.run('PRAGMA journal_mode = WAL')
  db.run('PRAGMA busy_timeout = 5000')
  return {
    all: async <T>(sql: string, params: readonly unknown[]) =>
      db.query(sql).all(...(params as never[])) as T[],
    run: async (sql, params) => db.query(sql).run(...(params as never[])).changes,
    batch: async (statements) => {
      db.transaction(() => {
        for (const s of statements) db.run(s)
      })()
    },
  }
}

/** An S3-compatible bucket through Bun's S3 client. */
export function s3Blobs(client: Bun.S3Client): Blobs {
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
    // One GET, no HEAD first: its first chunk says whether the bucket holds
    // the blob, so a dropped one is a 404 and not a body cut short. A stream,
    // not the S3File: Bun answers `new Response(s3File)` with a redirect to
    // the bucket, which a client may not reach.
    async get(name) {
      const reader = client.file(name).stream().getReader()
      let first: Awaited<ReturnType<typeof reader.read>>
      try {
        first = await reader.read()
      } catch (err) {
        if ((err as { code?: unknown }).code === 'NoSuchKey') return null
        throw err
      }
      return new ReadableStream<Uint8Array>({
        start(controller) {
          if (first.done) controller.close()
          else controller.enqueue(first.value)
        },
        async pull(controller) {
          const next = await reader.read()
          if (next.done) controller.close()
          else controller.enqueue(next.value)
        },
        cancel: (reason) => reader.cancel(reason),
      })
    },
    async delete(name) {
      await client.delete(name)
    },
  }
}

function main(argv: string[]): void {
  const { values } = parseArgs({
    args: argv,
    options: {
      db: { type: 'string', default: 'vx-cache.sqlite' },
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
  const port = Number(values.port)
  if (!Number.isInteger(port) || port < 0 || port > 65_535)
    fail(`--port: not a port: ${values.port}`)
  const max = env.MAX_ARTIFACT_BYTES === undefined ? undefined : Number(env.MAX_ARTIFACT_BYTES)
  if (max !== undefined && !(Number.isSafeInteger(max) && max > 0)) {
    fail(`MAX_ARTIFACT_BYTES: not a byte count: ${env.MAX_ARTIFACT_BYTES}`)
  }
  let trust
  try {
    trust = parseTrust(env.TRUST ?? '')
  } catch (err) {
    fail(`TRUST: ${(err as Error).message}`)
  }
  const handle = createCacheServer({
    blobs: s3Blobs(new Bun.S3Client({ bucket: env.S3_BUCKET })),
    db: sqliteDb(values.db),
    authorize: anyAuth(
      tokenAuth(parseTokens(env.TOKENS ?? '')),
      trust.length === 0
        ? undefined
        : oidcAuth({ trust, ...(env.AUDIENCE ? { audience: env.AUDIENCE } : {}) }),
    ),
    ...(max === undefined ? {} : { maxArtifactBytes: max }),
  })
  const server = Bun.serve({
    hostname: values.host,
    port,
    maxRequestBodySize: max ?? DEFAULT_MAX_ARTIFACT_BYTES,
    fetch: handle,
  })
  console.log(`vx-cache-server on ${server.url.href}`)
  const stop = (): void => {
    void server.stop().then(() => process.exit(0))
  }
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
    fail(err instanceof Error ? err.message : String(err))
  }
}
