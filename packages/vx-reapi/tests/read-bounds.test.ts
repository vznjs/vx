// A CAS reply is held to the size its digest declares AS IT ARRIVES (L-3):
// a zstd reply was expanded to its frame's end, and a ByteStream body was
// collected until the server stopped, before the size was ever checked —
// a few KB of zstd, or a body that never ends, took the client's memory.
//
// Offline: a local grpc-js stub plays the hostile CAS.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import path from 'node:path'
import * as grpc from '@grpc/grpc-js'
import * as protoLoader from '@grpc/proto-loader'
import { ReapiClient } from '../src/wire.js'
import { sha256 } from '../src/merkle.js'
import { CHUNKING_SUPPORTED } from './helpers/bun-floor.js'

const PROTO_ROOT = path.resolve(import.meta.dir, '..', 'protos')
const LOAD_OPTIONS: protoLoader.Options = {
  includeDirs: [PROTO_ROOT],
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
}

const GOOD = new TextEncoder().encode('the real bytes')
const GOOD_DIGEST = sha256(GOOD)
const OTHER = new TextEncoder().encode('bytes nobody asked for')
// 256 MiB of zeros: about 8 KB of zstd.
const BOMB = Bun.zstdCompressSync(new Uint8Array(256 * 1024 * 1024))
const MIB = new Uint8Array(1024 * 1024)

/** What the stub answers with; each row sets it. */
let mode: 'flood' | 'bomb' | 'honest-zstd' | 'extra' = 'flood'
let sent = 0
let server: grpc.Server
let endpoint: string

beforeAll(async () => {
  const load = (f: string) => grpc.loadPackageDefinition(protoLoader.loadSync(f, LOAD_OPTIONS))
  const cas = (
    load('build/bazel/remote/execution/v2/remote_execution.proto') as never as {
      build: {
        bazel: {
          remote: { execution: { v2: Record<string, { service: grpc.ServiceDefinition }> } }
        }
      }
    }
  ).build.bazel.remote.execution.v2
  const bs = (
    load('google/bytestream/bytestream.proto') as never as {
      google: { bytestream: Record<string, { service: grpc.ServiceDefinition }> }
    }
  ).google.bytestream
  server = new grpc.Server()
  server.addService(bs['ByteStream']!.service, {
    Read: async (call: grpc.ServerWritableStream<unknown, { data: Uint8Array }>) => {
      sent = 0
      if (mode === 'bomb') call.write({ data: BOMB })
      else if (mode === 'honest-zstd') call.write({ data: Bun.zstdCompressSync(GOOD) })
      else {
        // 64 MiB, a MiB at a time, as fast as the client takes it.
        for (let i = 0; i < 64 && !call.cancelled; i++) {
          sent++
          if (!call.write({ data: MIB })) await new Promise((r) => call.once('drain', r))
        }
      }
      call.end()
    },
  })
  server.addService(cas['ContentAddressableStorage']!.service, {
    BatchReadBlobs: ((
      call: grpc.ServerUnaryCall<{ digests: { hash: string; size_bytes: string }[] }, unknown>,
      cb: (e: unknown, r: unknown) => void,
    ) => {
      const responses =
        mode === 'extra'
          ? [{ digest: sha256(OTHER), data: OTHER, status: { code: 0 } }]
          : call.request.digests.map((d) => ({
              digest: d,
              data: mode === 'bomb' ? BOMB : Bun.zstdCompressSync(GOOD),
              compressor: 'ZSTD',
              status: { code: 0 },
            }))
      cb(null, { responses })
    }) as grpc.UntypedHandleCall,
  })
  endpoint = await new Promise<string>((resolve, reject) =>
    server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (e, p) =>
      e ? reject(e) : resolve(`127.0.0.1:${p}`),
    ),
  )
})

afterAll(() => {
  server.forceShutdown()
})

const client = (compression: boolean): ReapiClient => {
  const c = new ReapiClient({ endpoint })
  ;(c as unknown as { compression: boolean }).compression = compression
  return c
}
const past = `@vzn/vx-reapi: blob integrity failure for ${GOOD_DIGEST.hash.slice(0, 16)}…: served past its declared ${GOOD_DIGEST.size_bytes} bytes`
// Settled by hand: `expect(p).rejects` on a grpc-backed promise can sit
// until the test's timeout (CLAUDE.md, item 827).
const settle = (p: Promise<unknown>): Promise<string> =>
  p.then(
    () => 'resolved',
    (e: Error) => e.message,
  )

describe.if(CHUNKING_SUPPORTED)('CAS reads are bounded by the digest (L-3)', () => {
  it('readBlob refuses a body past its size as it arrives, not at its end', async () => {
    mode = 'flood'
    const c = client(false)
    try {
      expect(await settle(c.readBlob(GOOD_DIGEST))).toBe(past)
      expect(sent).toBeLessThan(64)
    } finally {
      c.close()
    }
  })

  it('readBlobStream errors a body past its size as it arrives', async () => {
    mode = 'flood'
    const c = client(false)
    try {
      const stream = await c.readBlobStream(GOOD_DIGEST)
      expect(await settle(new Response(stream).bytes())).toBe(past)
      expect(sent).toBeLessThan(64)
    } finally {
      c.close()
    }
  })

  it('a compressed ByteStream reply stops decoding at the size', async () => {
    mode = 'bomb'
    const c = client(true)
    try {
      expect(await settle(c.readBlob(GOOD_DIGEST))).toBe(past)
    } finally {
      c.close()
    }
  })

  it('a compressed batch entry stops decoding at the size', async () => {
    mode = 'bomb'
    const c = client(false)
    try {
      expect(await settle(c.batchReadBlobs([GOOD_DIGEST]))).toBe(past)
    } finally {
      c.close()
    }
  })

  it('a batch entry for a digest not asked for is dropped', async () => {
    mode = 'extra'
    const c = client(false)
    try {
      expect([...(await c.batchReadBlobs([GOOD_DIGEST])).keys()]).toEqual([])
    } finally {
      c.close()
    }
  })

  it('CONTROL: an honest compressed reply decodes on both paths', async () => {
    mode = 'honest-zstd'
    const c = client(true)
    try {
      expect(new TextDecoder().decode((await c.readBlob(GOOD_DIGEST))!)).toBe('the real bytes')
      const batch = await c.batchReadBlobs([GOOD_DIGEST])
      expect(new TextDecoder().decode(batch.get(GOOD_DIGEST.hash)!)).toBe('the real bytes')
    } finally {
      c.close()
    }
  })
})
