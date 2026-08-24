// Download integrity: a CAS response whose bytes do NOT match the digest
// they were requested under must be REFUSED, not stored. Without the check,
// a corrupt or poisoned remote's bytes land in the local content-addressed
// store under a trusted name — wrong bytes served forever under a green
// hit, the worst failure class there is. Bazel's client verifies its
// downloads; so does this one, as of the pin below.
//
// Offline: a local grpc-js stub server plays the lying CAS. No docker.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import path from 'node:path'
import * as grpc from '@grpc/grpc-js'
import * as protoLoader from '@grpc/proto-loader'
import { ReapiClient } from '../src/wire.js'
import { sha256 } from '../src/merkle.js'

const PROTO_ROOT = path.resolve(import.meta.dir, '..', 'protos')
const LOAD_OPTIONS: protoLoader.Options = {
  includeDirs: [PROTO_ROOT],
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
}

const GOOD = new TextEncoder().encode('the real artifact bytes')
const EVIL = new TextEncoder().encode('EVIL bytes, same length!')
const GOOD_DIGEST = sha256(GOOD)

let server: grpc.Server
let endpoint: string

beforeAll(async () => {
  const v2def = protoLoader.loadSync(
    'build/bazel/remote/execution/v2/remote_execution.proto',
    LOAD_OPTIONS,
  )
  const bsdef = protoLoader.loadSync('google/bytestream/bytestream.proto', LOAD_OPTIONS)
  const v2 = grpc.loadPackageDefinition(v2def) as never as Record<string, never>
  const bs = grpc.loadPackageDefinition(bsdef) as never as Record<string, never>
  const casSvc = (
    v2 as never as {
      build: {
        bazel: {
          remote: { execution: { v2: Record<string, { service: grpc.ServiceDefinition }> } }
        }
      }
    }
  ).build.bazel.remote.execution.v2
  const bsSvc = (
    bs as never as { google: { bytestream: Record<string, { service: grpc.ServiceDefinition }> } }
  ).google.bytestream

  server = new grpc.Server()
  // The lying ByteStream: whatever digest is asked for, EVIL comes back
  // (right length, wrong content) — the shape only a hash check can catch.
  server.addService(bsSvc['ByteStream']!.service, {
    Read: (call: grpc.ServerWritableStream<{ resource_name: string }, { data: Uint8Array }>) => {
      call.write({ data: EVIL })
      call.end()
    },
  })
  // The lying batch read: same story, response echoes the requested digest.
  server.addService(casSvc['ContentAddressableStorage']!.service, {
    BatchReadBlobs: ((
      call: grpc.ServerUnaryCall<{ digests: { hash: string; size_bytes: string }[] }, unknown>,
      cb: (e: unknown, r: unknown) => void,
    ) => {
      cb(null, {
        responses: call.request.digests.map((d) => ({
          digest: d,
          data: EVIL,
          status: { code: 0 },
        })),
      })
    }) as grpc.UntypedHandleCall,
  })
  await new Promise<void>((resolve, reject) => {
    server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (err, port) => {
      if (err) return reject(err)
      endpoint = `127.0.0.1:${port}`
      resolve()
    })
  })
})

afterAll(() => {
  server.forceShutdown()
})

describe('CAS download integrity', () => {
  it('readBlob refuses bytes that do not hash to the requested digest', async () => {
    const client = new ReapiClient({ endpoint })
    try {
      await expect(client.readBlob(GOOD_DIGEST)).rejects.toThrow(/integrity|digest/i)
    } finally {
      client.close()
    }
  })

  it('batchReadBlobs refuses a lying entry', async () => {
    const client = new ReapiClient({ endpoint })
    try {
      await expect(client.batchReadBlobs([GOOD_DIGEST])).rejects.toThrow(/integrity|digest/i)
    } finally {
      client.close()
    }
  })

  it('CONTROL: honest bytes pass both paths', async () => {
    // A second stub that answers truthfully proves the check discriminates
    // rather than refusing everything.
    const honest = new grpc.Server()
    const v2def = protoLoader.loadSync(
      'build/bazel/remote/execution/v2/remote_execution.proto',
      LOAD_OPTIONS,
    )
    const bsdef = protoLoader.loadSync('google/bytestream/bytestream.proto', LOAD_OPTIONS)
    const casSvc = (
      grpc.loadPackageDefinition(v2def) as never as {
        build: {
          bazel: {
            remote: { execution: { v2: Record<string, { service: grpc.ServiceDefinition }> } }
          }
        }
      }
    ).build.bazel.remote.execution.v2
    const bsSvc = (
      grpc.loadPackageDefinition(bsdef) as never as {
        google: { bytestream: Record<string, { service: grpc.ServiceDefinition }> }
      }
    ).google.bytestream
    honest.addService(bsSvc['ByteStream']!.service, {
      Read: (call: grpc.ServerWritableStream<{ resource_name: string }, { data: Uint8Array }>) => {
        call.write({ data: GOOD })
        call.end()
      },
    })
    honest.addService(casSvc['ContentAddressableStorage']!.service, {
      BatchReadBlobs: ((
        call: grpc.ServerUnaryCall<{ digests: { hash: string; size_bytes: string }[] }, unknown>,
        cb: (e: unknown, r: unknown) => void,
      ) => {
        cb(null, {
          responses: call.request.digests.map((d) => ({
            digest: d,
            data: GOOD,
            status: { code: 0 },
          })),
        })
      }) as grpc.UntypedHandleCall,
    })
    const port = await new Promise<number>((resolve, reject) => {
      honest.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (e, p) =>
        e ? reject(e) : resolve(p),
      )
    })
    const client = new ReapiClient({ endpoint: `127.0.0.1:${port}` })
    try {
      const one = await client.readBlob(GOOD_DIGEST)
      expect(one).not.toBeNull()
      expect(Buffer.compare(Buffer.from(one!), Buffer.from(GOOD))).toBe(0)
      const batch = await client.batchReadBlobs([GOOD_DIGEST])
      expect(Buffer.compare(Buffer.from(batch.get(GOOD_DIGEST.hash)!), Buffer.from(GOOD))).toBe(0)
    } finally {
      client.close()
      honest.forceShutdown()
    }
  })
})
