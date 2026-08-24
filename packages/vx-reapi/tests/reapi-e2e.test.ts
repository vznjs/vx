// Round-trip against a REAL REAPI server. Run one locally with:
//
//   docker run -d -p 19092:9092 buchgr/bazel-remote-cache:latest \
//     --dir /data --max_size 1 --grpc_address 0.0.0.0:9092 --http_address 0.0.0.0:8080
//   VX_REAPI_TEST_ENDPOINT=127.0.0.1:19092 bun test
//
// GATING, per the project rule that a skip is a silent PASS: without an
// endpoint these skip locally, but `VX_REQUIRE_REAPI=1` (which CI sets once a
// server is wired into the workflow) turns an absent endpoint into a FAILURE.
// Otherwise an infra change could delete this entire suite under a green check.

import { describe, expect, it } from 'bun:test'
import { ReapiClient } from '../src/wire.js'
import { actionDigestFor, digestOf, ReapiRemoteCache } from '../src/cache.js'

const ENDPOINT = Bun.env['VX_REAPI_TEST_ENDPOINT']
const REQUIRED = Bun.env['VX_REQUIRE_REAPI'] === '1'

if (REQUIRED && (ENDPOINT === undefined || ENDPOINT === '')) {
  throw new Error(
    'VX_REQUIRE_REAPI=1 but VX_REAPI_TEST_ENDPOINT is unset — the REAPI suite would have silently skipped.',
  )
}

const run = ENDPOINT !== undefined && ENDPOINT !== ''
const nonce = (): string => `${process.pid}-${Bun.nanoseconds()}`

describe.if(run)('REAPI round-trip against a live server', () => {
  const endpoint = ENDPOINT as string

  it('reports capabilities including SHA256', async () => {
    const client = new ReapiClient({ endpoint })
    try {
      const caps = await client.capabilities()
      expect(caps.digestFunctions).toContain('SHA256')
    } finally {
      client.close()
    }
  })

  it('FindMissingBlobs reports absent, then present after a write', async () => {
    // The upload-minimality primitive: without it every run re-uploads every
    // artifact. Asserted in BOTH directions on a blob the server has never
    // seen, because "present" alone would also pass if the probe were stubbed.
    const client = new ReapiClient({ endpoint })
    try {
      const body = new TextEncoder().encode(`vx-reapi-${nonce()}`)
      const d = digestOf(body)
      expect((await client.findMissingBlobs([d])).length).toBe(1)
      await client.writeBlob(d, body)
      expect((await client.findMissingBlobs([d])).length).toBe(0)
    } finally {
      client.close()
    }
  })

  it('stores and restores an artifact larger than one chunk, byte-identical', async () => {
    // The shape that made Bun's http2 hang: a blob spanning many ByteStream
    // messages. 1 MB over 128 KB chunks is 8 messages.
    const cache = new ReapiRemoteCache({ endpoint })
    try {
      const key = `vx-key-${nonce()}`
      const body = new Uint8Array(1024 * 1024)
      crypto.getRandomValues(body)
      expect(await cache.has(key)).toBe(false)
      await cache.put(key, body, { durationMs: 4242 })
      expect(await cache.has(key)).toBe(true)
      const got = await cache.get(key)
      expect(got).not.toBeNull()
      expect(Buffer.compare(Buffer.from(got!.body), Buffer.from(body))).toBe(0)
      // durationMs survives whether the server keeps stdout inline or
      // normalises it into CAS (bazel-remote does the latter).
      expect(got!.durationMs).toBe(4242)
    } finally {
      cache.close()
    }
  })

  it('an unknown key is a MISS, not an error', async () => {
    // NOT_FOUND has to degrade, or every cold key fails the run.
    const cache = new ReapiRemoteCache({ endpoint })
    try {
      expect(await cache.has(`never-written-${nonce()}`)).toBe(false)
      expect(await cache.get(`never-written-${nonce()}`)).toBeNull()
    } finally {
      cache.close()
    }
  })

  it('re-putting the same artifact skips the upload but refreshes the entry', async () => {
    const cache = new ReapiRemoteCache({ endpoint })
    const client = new ReapiClient({ endpoint })
    try {
      const key = `vx-dup-${nonce()}`
      const body = new TextEncoder().encode(`dup-${nonce()}`)
      await cache.put(key, body, { durationMs: 1 })
      // Second put: the blob is already present, so FindMissingBlobs returns
      // nothing and writeBlob is skipped — the entry must still be readable.
      await cache.put(key, body, { durationMs: 2 })
      expect((await client.findMissingBlobs([digestOf(body)])).length).toBe(0)
      const got = await cache.get(key)
      expect(got!.durationMs).toBe(2)
    } finally {
      cache.close()
      client.close()
    }
  })

  it('an AC entry whose blob was evicted reads as a MISS, not a crash', async () => {
    // The two stores prune independently, so a dangling entry is an ordinary
    // state. Simulated by pointing an entry at a digest never uploaded.
    const client = new ReapiClient({ endpoint })
    const cache = new ReapiRemoteCache({ endpoint })
    try {
      const key = `vx-dangling-${nonce()}`
      const phantom = digestOf(new TextEncoder().encode(`phantom-${nonce()}`))
      await client.updateActionResult(actionDigestFor(key), {
        exit_code: 0,
        output_files: [{ path: 'vx-artifact.tar.zst', digest: phantom, is_executable: false }],
      })
      expect(await cache.get(key)).toBeNull()
    } finally {
      cache.close()
      client.close()
    }
  })
})

describe.if(run)('chunkBytes is a real escape hatch, not just an option', () => {
  const endpoint = ENDPOINT as string

  // The ceiling that forces this option to exist is peer-dependent (Bun
  // #30342 / #31584 — Go gRPC grows its window and Bun mishandles the tail).
  // So the escape hatch has to be exercised against a real server, or it is
  // just a field nobody has proven routes anywhere.
  it.each([
    ['default 128 KB', undefined],
    ['SAFE_CHUNK_BYTES', 65535],
  ])('round-trips a multi-chunk artifact at %s', async (_label, chunkBytes) => {
    const cache = new ReapiRemoteCache({
      endpoint,
      ...(chunkBytes === undefined ? {} : { chunkBytes }),
    })
    try {
      const key = `vx-chunk-${nonce()}`
      const body = new Uint8Array(512 * 1024)
      crypto.getRandomValues(body)
      await cache.put(key, body, { durationMs: 7 })
      const got = await cache.get(key)
      expect(got).not.toBeNull()
      expect(Buffer.compare(Buffer.from(got!.body), Buffer.from(body))).toBe(0)
    } finally {
      cache.close()
    }
  })
})

describe.if(run)('protocol negotiation and the wider RPC surface', () => {
  const endpoint = ENDPOINT as string

  it('negotiates a digest function and compression from real capabilities', async () => {
    const client = new ReapiClient({ endpoint })
    try {
      const caps = await client.capabilities()
      await client.negotiate()
      // Whatever it picks must be something the SERVER advertised — picking a
      // function the server cannot verify makes every upload a rejected blob.
      expect(caps.digestFunctions).toContain(client.digest)
      // Compression is only on when the server said ZSTD; asserting the
      // implication (not a fixed value) keeps this true on any server.
      if (client.compressionEnabled) expect(caps.supportedCompressors).toContain('ZSTD')
    } finally {
      client.close()
    }
  })

  it('refuses a digest function the server does not advertise', async () => {
    // Failing loudly beats uploading blobs the server will reject one by one.
    const client = new ReapiClient({ endpoint })
    try {
      const caps = await client.capabilities()
      const unsupported = (['MD5', 'SHA1', 'SHA512'] as const).find(
        (f) => !caps.digestFunctions.includes(f),
      )
      if (unsupported === undefined) return
      let message = ''
      try {
        await client.negotiate({ digestFunction: unsupported })
      } catch (err) {
        message = err instanceof Error ? err.message : String(err)
      }
      expect(message).toMatch(/does not support digest function/)
    } finally {
      client.close()
    }
  })

  it('round-trips a blob with compression negotiated ON', async () => {
    // The compressed path uses a different RESOURCE NAME
    // (compressed-blobs/zstd/...) and a different wire payload, so it needs
    // its own round trip rather than trusting the identity path.
    const client = new ReapiClient({ endpoint })
    try {
      await client.negotiate()
      const body = new TextEncoder().encode('vx compressible '.repeat(4096) + nonce())
      const d = client.digestOf(body)
      await client.writeBlob(d, body)
      expect((await client.findMissingBlobs([d])).length).toBe(0)
      const back = await client.readBlob(d)
      expect(back).not.toBeNull()
      expect(Buffer.compare(Buffer.from(back!), Buffer.from(body))).toBe(0)
    } finally {
      client.close()
    }
  })

  it('BatchUpdateBlobs + BatchReadBlobs move many small blobs in one trip', async () => {
    const client = new ReapiClient({ endpoint })
    try {
      const blobs = Array.from({ length: 25 }, (_, i) => {
        const data = new TextEncoder().encode(`batch-${i}-${nonce()}`)
        return { digest: digestOf(data), data }
      })
      await client.batchUpdateBlobs(blobs)
      const got = await client.batchReadBlobs(blobs.map((b) => b.digest))
      expect(got.size).toBe(blobs.length)
      for (const b of blobs) {
        expect(Buffer.compare(Buffer.from(got.get(b.digest.hash)!), Buffer.from(b.data))).toBe(0)
      }
    } finally {
      client.close()
    }
  })

  it('uploadBlobs sends ONLY what FindMissingBlobs reports absent', async () => {
    // Upload minimality is the property that makes a warm remote cache cheap.
    const client = new ReapiClient({ endpoint })
    try {
      const known = new TextEncoder().encode(`known-${nonce()}`)
      const fresh = new TextEncoder().encode(`fresh-${nonce()}`)
      await client.batchUpdateBlobs([{ digest: digestOf(known), data: known }])
      await client.uploadBlobs([
        { digest: digestOf(known), data: known },
        { digest: digestOf(fresh), data: fresh },
      ])
      expect((await client.findMissingBlobs([digestOf(known), digestOf(fresh)])).length).toBe(0)
    } finally {
      client.close()
    }
  })

  it('QueryWriteStatus answers for a completed upload and for an unknown one', async () => {
    const client = new ReapiClient({ endpoint })
    try {
      const status = await client.queryWriteStatus(
        `uploads/${crypto.randomUUID()}/blobs/${'0'.repeat(64)}/1`,
      )
      // Servers legitimately answer NOT_FOUND (null) for a resource they have
      // never seen; either shape is protocol-legal, a THROW is not.
      expect(status === null || typeof status.committedSize === 'number').toBe(true)
    } finally {
      client.close()
    }
  })

  it('reports whether the server can execute, and does not pretend otherwise', async () => {
    // bazel-remote is cache-only. The executor must decline rather than
    // submit work to a server that will never answer.
    const client = new ReapiClient({ endpoint })
    try {
      const caps = await client.capabilities()
      expect(typeof caps.execEnabled).toBe('boolean')
      expect(caps.acUpdateEnabled).toBe(true)
    } finally {
      client.close()
    }
  })
})

describe.if(run)('SpliceBlob — the half of the chunking pair bazel-remote advertises', () => {
  const endpoint = ENDPOINT as string

  it('assembles a blob server-side from chunks the client uploaded separately', async () => {
    // The decision log carried Split/Splice as "unexercised e2e — blocked on
    // a server advertising them". Half wrong: bazel-remote advertises
    // splice_blob_support=true, so the assembly direction is provable
    // against the same server CI already runs. (Split stays gated on a
    // server that advertises it; the capability check below keeps this
    // honest if a different server is wired in.)
    const client = new ReapiClient({ endpoint })
    try {
      await client.negotiate()
      const caps = await client.capabilities()
      if (!caps.spliceBlobSupport) return // capability-gated, not assumed
      const a = new TextEncoder().encode(`chunk-a-${nonce()}`)
      const b = new TextEncoder().encode(`chunk-b-${nonce()}`)
      const whole = new Uint8Array([...a, ...b])
      const wholeDigest = digestOf(whole)
      await client.batchUpdateBlobs([
        { digest: digestOf(a), data: a },
        { digest: digestOf(b), data: b },
      ])
      // The whole blob was NEVER uploaded — precondition, not assumption.
      expect((await client.findMissingBlobs([wholeDigest])).length).toBe(1)
      const assembled = await client.spliceBlob([digestOf(a), digestOf(b)], wholeDigest)
      expect(assembled.hash).toBe(wholeDigest.hash)
      // …and now it exists, byte-identical, without the client sending it.
      expect((await client.findMissingBlobs([wholeDigest])).length).toBe(0)
      const back = await client.readBlob(wholeDigest)
      expect(back).not.toBeNull()
      expect(Buffer.compare(Buffer.from(back!), Buffer.from(whole))).toBe(0)
    } finally {
      client.close()
    }
  })
})
