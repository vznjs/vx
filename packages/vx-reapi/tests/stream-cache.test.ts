// The cache layer's streamed paths against an in-process REAPI server: a
// grpc-js stub holding the AC and CAS in maps, recording every ByteStream
// message it is sent. `put` hands the client a Blob and `get` hands core a
// Response over the ByteStream read, so a large artifact never sits whole in
// memory (streaming-remote-2026-09). Offline: no docker, no service job.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import path from 'node:path'
import * as grpc from '@grpc/grpc-js'
import * as protoLoader from '@grpc/proto-loader'
import { createHash } from 'node:crypto'
import { ReapiRemoteCache, actionDigestFor, digestOf, execDigestFor } from '../src/cache.js'
import { CHUNK_BYTES } from '../src/wire.js'
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

type Services = Record<string, { service: grpc.ServiceDefinition }>
interface WireDigest {
  hash: string
  size_bytes: string
}

const blobs = new Map<string, Uint8Array>()
const actions = new Map<string, unknown>()
/** The `data` length of every message of every ByteStream Write, one array per call. */
const writes: number[][] = []
let cancelledWrites = 0
/** While set, a Write stops reading after its first message until this settles. */
let holdWrites: Promise<void> | undefined

let server: grpc.Server
let endpoint: string

function hashOf(resource: string): string {
  const m = /blobs\/([0-9a-f]{64})\/\d+$/.exec(resource)
  if (!m) throw new Error(`unexpected resource ${resource}`)
  return m[1]!
}

beforeAll(async () => {
  const v2 = (
    grpc.loadPackageDefinition(
      protoLoader.loadSync('build/bazel/remote/execution/v2/remote_execution.proto', LOAD_OPTIONS),
    ) as never as { build: { bazel: { remote: { execution: { v2: Services } } } } }
  ).build.bazel.remote.execution.v2
  const bs = (
    grpc.loadPackageDefinition(
      protoLoader.loadSync('google/bytestream/bytestream.proto', LOAD_OPTIONS),
    ) as never as { google: { bytestream: Services } }
  ).google.bytestream

  server = new grpc.Server()
  server.addService(v2['ActionCache']!.service, {
    GetActionResult: ((
      call: grpc.ServerUnaryCall<{ action_digest: WireDigest }, unknown>,
      cb: grpc.sendUnaryData<unknown>,
    ) => {
      const found = actions.get(call.request.action_digest.hash)
      if (found === undefined) cb({ code: grpc.status.NOT_FOUND, details: 'no action' })
      else cb(null, found)
    }) as grpc.UntypedHandleCall,
    UpdateActionResult: ((
      call: grpc.ServerUnaryCall<{ action_digest: WireDigest; action_result: unknown }, unknown>,
      cb: grpc.sendUnaryData<unknown>,
    ) => {
      actions.set(call.request.action_digest.hash, call.request.action_result)
      cb(null, call.request.action_result)
    }) as grpc.UntypedHandleCall,
  })
  server.addService(v2['ContentAddressableStorage']!.service, {
    FindMissingBlobs: ((
      call: grpc.ServerUnaryCall<{ blob_digests: WireDigest[] }, unknown>,
      cb: grpc.sendUnaryData<unknown>,
    ) => {
      cb(null, {
        missing_blob_digests: call.request.blob_digests.filter((d) => !blobs.has(d.hash)),
      })
    }) as grpc.UntypedHandleCall,
  })
  server.addService(bs['ByteStream']!.service, {
    Write: ((
      call: grpc.ServerReadableStream<
        { resource_name: string; write_offset: string; data: Uint8Array },
        unknown
      >,
      cb: grpc.sendUnaryData<unknown>,
    ) => {
      const sizes: number[] = []
      writes.push(sizes)
      const parts: Uint8Array[] = []
      let resource = ''
      let offset = 0
      call.on('data', (m) => {
        if (resource === '') {
          resource = m.resource_name
          const hold = holdWrites
          if (hold !== undefined) {
            call.pause()
            void hold.then(() => call.resume())
          }
        }
        if (Number(m.write_offset) !== offset) {
          cb({ code: grpc.status.INVALID_ARGUMENT, details: `offset ${m.write_offset}/${offset}` })
        }
        sizes.push(m.data.length)
        parts.push(m.data)
        offset += m.data.length
      })
      call.on('cancelled', () => {
        cancelledWrites++
      })
      call.on('end', () => {
        // A write cancelled before its first message reached the server.
        if (resource === '') return cb({ code: grpc.status.CANCELLED, details: 'empty write' })
        blobs.set(hashOf(resource), Buffer.concat(parts))
        cb(null, { committed_size: String(offset) })
      })
    }) as grpc.UntypedHandleCall,
    Read: ((call: grpc.ServerWritableStream<{ resource_name: string }, unknown>) => {
      const blob = blobs.get(hashOf(call.request.resource_name))
      if (blob === undefined) {
        call.emit('error', { code: grpc.status.NOT_FOUND, details: 'no blob' })
        return
      }
      for (let at = 0; at < blob.length; at += 64 * 1024) {
        call.write({ data: blob.subarray(at, at + 64 * 1024) })
      }
      call.end()
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

function random(bytes: number): Uint8Array {
  const out = new Uint8Array(bytes)
  for (let at = 0; at < bytes; at += 65536) crypto.getRandomValues(out.subarray(at, at + 65536))
  return out
}

/** A Blob that can only be streamed: reading it whole is the defect. */
function streamOnly(bytes: Uint8Array): Blob {
  const refuse = () => {
    throw new Error('the Blob was read whole')
  }
  return Object.assign(new Blob([bytes]), { bytes: refuse, arrayBuffer: refuse, text: refuse })
}

describe.if(CHUNKING_SUPPORTED)('the REAPI cache layer streams against a fake server', () => {
  it('a blob past the batch limit round-trips through the stream path, in CHUNK_BYTES messages', async () => {
    const body = random(5 * 1024 * 1024)
    const cache = new ReapiRemoteCache({ endpoint })
    try {
      const before = writes.length
      await cache.put('k-large', streamOnly(body), { durationMs: 11 })
      const sent = writes.slice(before)
      expect(sent.length).toBe(1)
      expect(sent[0]!.length).toBe(Math.ceil(body.length / CHUNK_BYTES))
      expect(sent[0]!.every((n) => n === CHUNK_BYTES)).toBe(true)
      const got = await cache.get('k-large')
      expect(got!.body).toBeInstanceOf(Response)
      expect(got!.durationMs).toBe(11)
      expect(Buffer.compare(Buffer.from(await got!.body.bytes()), Buffer.from(body))).toBe(0)
    } finally {
      cache.close()
    }
  })

  it('a blob under the batch limit still round-trips', async () => {
    const body = random(1024 * 1024 + 7)
    const cache = new ReapiRemoteCache({ endpoint })
    try {
      await cache.put('k-small', new Blob([body]), { durationMs: 3 })
      const got = await cache.get('k-small')
      expect(Buffer.compare(Buffer.from(await got!.body.bytes()), Buffer.from(body))).toBe(0)
    } finally {
      cache.close()
    }
  })

  it('a streamed upload reads its Blob only as fast as the server takes it', async () => {
    // The drain wait is the whole memory bound: a writer that ignores it
    // reads the Blob to its end into grpc's send buffer while the server
    // sits on the first message.
    const body = random(32 * 1024 * 1024)
    let pulled = 0
    const counted = Object.assign(new Blob([body]), {
      stream: () =>
        new Blob([body]).stream().pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, c) {
              pulled += chunk.length
              c.enqueue(chunk)
            },
          }),
        ),
    })
    let release!: () => void
    holdWrites = new Promise<void>((r) => {
      release = r
    })
    const cache = new ReapiRemoteCache({ endpoint })
    try {
      const put = cache.put('k-held', counted, { durationMs: 1 })
      // The digest pass reads it all once; count only the upload's read.
      while (pulled < body.length) await Bun.sleep(5)
      const digestPass = pulled
      let last = -1
      for (let quiet = 0; quiet < 10; await Bun.sleep(20)) {
        quiet = pulled === last ? quiet + 1 : 0
        last = pulled
      }
      expect(pulled - digestPass).toBeLessThan(8 * 1024 * 1024)
      release()
      await put
      expect(blobs.get(digestOf(body).hash)?.length).toBe(body.length)
    } finally {
      holdWrites = undefined
      release()
      cache.close()
    }
  })

  it('an AC entry whose blob is gone reads as a miss before any stream is handed over', async () => {
    const cache = new ReapiRemoteCache({ endpoint })
    try {
      actions.set(actionDigestFor('k-dangling').hash, {
        exit_code: 0,
        output_files: [
          {
            path: 'vx-artifact.tar.zst',
            digest: digestOf(new TextEncoder().encode('never uploaded')),
            is_executable: false,
          },
        ],
      })
      expect(await cache.get('k-dangling')).toBeNull()
    } finally {
      cache.close()
    }
  })

  it('a Blob that fails mid-upload rejects the put and cancels the half-sent write', async () => {
    const body = random(5 * 1024 * 1024)
    // The digest pass reads the stream first and must see it whole; the
    // upload's read is the one that fails, so the write is half-sent.
    let reads = 0
    const failed = Object.assign(new Blob([body]), {
      stream: () =>
        reads++ === 0
          ? new Blob([body]).stream()
          : new ReadableStream<Uint8Array>({
              start(c) {
                c.enqueue(body.subarray(0, 512 * 1024))
                c.error(new Error('artifact pruned'))
              },
            }),
    })
    const cache = new ReapiRemoteCache({ endpoint })
    try {
      const cancelledBefore = cancelledWrites
      await expect(cache.put('k-pruned', failed, { durationMs: 1 })).rejects.toThrow(
        'artifact pruned',
      )
      // Well inside the call's 30 s deadline, which would end an uncancelled write too.
      const deadline = Date.now() + 3_000
      while (cancelledWrites === cancelledBefore && Date.now() < deadline) await Bun.sleep(5)
      expect(cancelledWrites).toBe(cancelledBefore + 1)
      expect(blobs.has(digestOf(body).hash)).toBe(false)
    } finally {
      cache.close()
    }
  })
})

// Item 818's sweep of cache.ts: each row fails with one line undone.
describe('the REAPI cache layer, exactly', () => {
  const ARTIFACT = 'vx-artifact.tar.zst'
  const bytes = (s: string) => new TextEncoder().encode(s)
  const store = (s: string) => {
    const b = bytes(s)
    blobs.set(digestOf(b).hash, b)
    return digestOf(b)
  }
  const entry = (key: string, result: Record<string, unknown>) =>
    actions.set(actionDigestFor(key).hash, { exit_code: 0, ...result })
  const withCache = async <T>(f: (c: ReapiRemoteCache) => Promise<T>): Promise<T> => {
    const cache = new ReapiRemoteCache({ endpoint })
    try {
      return await f(cache)
    } finally {
      cache.close()
    }
  }

  it('the execution record has its own address, apart from the artifact’s', () => {
    const sha = (s: string) => createHash('sha256').update(s).digest('hex')
    expect(execDigestFor('k')).toEqual({ hash: sha('vx-reapi-exec-v1\0k'), size_bytes: 18 })
    expect(actionDigestFor('k')).toEqual({ hash: sha('vx-reapi-v1\0k'), size_bytes: 13 })
  })

  it('has and get find the artifact by its path, not by its place in the list', async () => {
    const other = digestOf(bytes('not uploaded'))
    const real = store('the artifact')
    entry('k-order', {
      output_files: [
        { path: 'other', digest: other, is_executable: false },
        { path: ARTIFACT, digest: real, is_executable: false },
      ],
    })
    await withCache(async (c) => {
      expect(await c.has('k-order')).toBe(true)
      store('decoy')
      entry('k-order-get', {
        output_files: [
          { path: 'other', digest: store('decoy'), is_executable: false },
          { path: ARTIFACT, digest: real, is_executable: false },
        ],
      })
      expect(await (await c.get('k-order-get'))!.body.text()).toBe('the artifact')
    })
  })

  it('has is false for an entry whose blob is gone', async () => {
    entry('k-gone', {
      output_files: [{ path: ARTIFACT, digest: digestOf(bytes('evicted')), is_executable: false }],
    })
    expect(await withCache((c) => c.has('k-gone'))).toBe(false)
  })

  it('a duration that is not a number is none; one normalised into CAS is read from there', async () => {
    const artifact = store('a')
    entry('k-strdur', {
      output_files: [{ path: ARTIFACT, digest: artifact, is_executable: false }],
      stdout_raw: bytes('{"durationMs":"5"}'),
    })
    entry('k-casdur', {
      output_files: [{ path: ARTIFACT, digest: artifact, is_executable: false }],
      stdout_raw: new Uint8Array(0),
      stdout_digest: store('{"durationMs":42}'),
    })
    await withCache(async (c) => {
      expect((await c.get('k-strdur'))!.durationMs).toBeUndefined()
      expect((await c.get('k-casdur'))!.durationMs).toBe(42)
    })
  })

  it('a put of a blob the server has uploads nothing, and records the one output file', async () => {
    const body = bytes('same bytes')
    await withCache(async (c) => {
      await c.put('k-dup-1', new Blob([body]), { durationMs: 1 })
      const before = writes.length
      await c.put('k-dup-2', new Blob([body]), { durationMs: 1 })
      expect(writes.length).toBe(before)
    })
    const recorded = actions.get(actionDigestFor('k-dup-2').hash) as {
      output_files: { path: string; is_executable: boolean }[]
    }
    expect(recorded.output_files.map((f) => [f.path, f.is_executable])).toEqual([[ARTIFACT, false]])
  })

  it('close ends the client: a call after it fails', async () => {
    const cache = new ReapiRemoteCache({ endpoint })
    cache.close()
    await expect(cache.has('k-closed')).rejects.toThrow()
  })
})
