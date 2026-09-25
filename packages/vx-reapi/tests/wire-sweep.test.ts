// Item 823's sweep of wire.ts (setup, metadata, CAS and ByteStream): each
// row fails with one line of the client undone. Driven through the offline
// fake (helpers/fake-reapi.ts), which records what the client sent.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import path from 'node:path'
import * as grpc from '@grpc/grpc-js'
import protobuf from 'protobufjs'
import {
  assertBunSupportsChunking,
  ReapiClient,
  SAFE_CHUNK_BYTES,
  type Digest,
} from '../src/wire.js'
import { CHUNKING_SUPPORTED } from './helpers/bun-floor.js'
import { startFakeReapi, type FakeReapi } from './helpers/fake-reapi.js'

let fake: FakeReapi
beforeAll(async () => {
  fake = await startFakeReapi()
})
afterAll(() => fake.stop())
beforeEach(() => {
  fake.caps.compressors = []
  fake.caps.batchCompressors = []
  fake.caps.acUpdateEnabled = true
  fake.caps.maxBatchBytes = 4 * 1024 * 1024
  fake.reportComplete = false
  fake.holdReads = false
  fake.rejectBatch.clear()
})

const bytes = (s: string) => new TextEncoder().encode(s)
const fill = (n: number, v = 1) => new Uint8Array(n).fill(v)
async function using<T>(
  opts: Record<string, unknown>,
  f: (c: ReapiClient) => Promise<T>,
): Promise<T> {
  const c = new ReapiClient({ endpoint: fake.endpoint, ...opts })
  try {
    return await f(c)
  } finally {
    c.close()
  }
}
/** The calls `f` made, by method name. */
async function callsOf(f: () => Promise<unknown>): Promise<string[]> {
  const mark = fake.calls.length
  await f()
  return fake.calls.slice(mark).map((c) => c.method)
}

const pb = new protobuf.Root()
pb.resolvePath = (_o, t) =>
  t.startsWith('google/protobuf/')
    ? path.join(
        path.dirname(
          Bun.resolveSync('protobufjs/google/protobuf/descriptor.proto', import.meta.dir),
        ),
        path.basename(t),
      )
    : path.join(import.meta.dir, '..', 'protos', t)
await pb.load('build/bazel/remote/execution/v2/remote_execution.proto')

describe('the Bun floor', () => {
  it('a patch release of the floor passes', () => {
    expect(() => assertBunSupportsChunking('1.4.0')).not.toThrow()
  })
})

describe.if(CHUNKING_SUPPORTED)('what every call carries', () => {
  it('RequestMetadata is protobuf’s own encoding, empty fields omitted; headers ride along', async () => {
    await using(
      {
        toolName: 'n'.repeat(128),
        toolVersion: '9.9',
        correlatedInvocationsId: 'corr',
        headers: { 'x-auth': 'k' },
      },
      async (c) => {
        c.toolInvocationId = 'inv'
        await c.findMissingBlobs([c.digestOf(bytes('m'))])
      },
    )
    const call = fake.calls.at(-1)!
    const sent = call.metadata.get(
      'build.bazel.remote.execution.v2.requestmetadata-bin',
    )[0] as Buffer
    const T = pb.lookupType('build.bazel.remote.execution.v2.RequestMetadata')
    const expected = T.encode(
      T.fromObject({
        toolDetails: { toolName: 'n'.repeat(128), toolVersion: '9.9' },
        toolInvocationId: 'inv',
        correlatedInvocationsId: 'corr',
      }),
    ).finish()
    expect(Buffer.from(sent).toString('hex')).toBe(Buffer.from(expected).toString('hex'))
    expect(call.metadata.get('x-auth')).toEqual(['k'])
  })

  it('an instance name reaches batch reads and ByteStream resources', async () => {
    const d = fake.put(bytes('scoped'))
    await using({ instanceName: 'inst' }, async (c) => {
      await c.batchReadBlobs([d])
      await c.readBlob(d)
    })
    const [batch, read] = fake.calls.slice(-2)
    expect(batch!.request['instance_name']).toBe('inst')
    expect(read!.request['resource_name']).toBe(`inst/blobs/${d.hash}/${d.size_bytes}`)
  })

  it('a grpc:// endpoint is plain; a grpcs:// one is TLS', async () => {
    await using({ endpoint: `grpc://${fake.endpoint}` }, async (c) => {
      expect((await c.capabilities()).execEnabled).toBe(true)
    })
    await using({ endpoint: `grpcs://${fake.endpoint}`, callTimeoutMs: 3000 }, async (c) => {
      await expect(c.capabilities()).rejects.toThrow()
    })
  })
})

describe.if(CHUNKING_SUPPORTED)('capabilities and negotiation', () => {
  it('reads update_enabled and the batch compressors apart from the stream ones', async () => {
    fake.caps.acUpdateEnabled = false
    fake.caps.compressors = ['ZSTD']
    const caps = await using({}, (c) => c.capabilities())
    expect([caps.acUpdateEnabled, caps.supportedBatchCompressors]).toEqual([false, []])
  })

  it('a digest function the server lacks is refused; compression can be declined', async () => {
    fake.caps.compressors = ['ZSTD']
    await using({}, async (c) => {
      await expect(c.negotiate({ digestFunction: 'SHA512' })).rejects.toThrow(
        '@vzn/vx-reapi: server does not support digest function SHA512 (has SHA256)',
      )
      await c.negotiate({ compression: false })
      expect(c.compressionEnabled).toBe(false)
    })
  })

  it('batch uploads compress only when the server takes zstd there', async () => {
    fake.caps.compressors = ['ZSTD']
    const compressorOf = async () => {
      await using({}, async (c) => {
        await c.negotiate()
        const data = bytes(`batch ${fake.calls.length}`)
        await c.batchUpdateBlobs([{ digest: c.digestOf(data), data }])
      })
      return (fake.calls.at(-1)!.request['requests'] as { compressor: string }[])[0]!.compressor
    }
    expect(await compressorOf()).toBe('IDENTITY')
    fake.caps.batchCompressors = ['ZSTD']
    expect(await compressorOf()).toBe('ZSTD')
  })

  it('an advertised batch size past the safe ceiling is clamped to it', async () => {
    fake.caps.maxBatchBytes = 64 * 1024 * 1024
    const blobs = [fill(3 * 1024 * 1024, 5), fill(3 * 1024 * 1024, 6)]
    const methods = await callsOf(() =>
      using({}, async (c) => {
        await c.negotiate()
        await c.uploadBlobs(blobs.map((data) => ({ digest: c.digestOf(data), data })))
      }),
    )
    expect(methods.filter((m) => m === 'BatchUpdateBlobs')).toHaveLength(2)
  })
})

describe.if(CHUNKING_SUPPORTED)('batches', () => {
  it('a blob the batch refuses is an error naming it', async () => {
    const data = bytes('refused')
    await using({}, async (c) => {
      const d = c.digestOf(data)
      fake.rejectBatch.add(d.hash)
      await expect(c.batchUpdateBlobs([{ digest: d, data }])).rejects.toThrow(
        `reapi: BatchUpdateBlobs rejected ${d.hash}: code 3 rejected`,
      )
    })
  })

  it('under zstd, a batch read says it accepts zstd', async () => {
    fake.caps.compressors = ['ZSTD']
    const d = fake.put(bytes('accepted'))
    await using({}, async (c) => {
      await c.negotiate()
      await c.batchReadBlobs([d])
    })
    expect(fake.calls.at(-1)!.request['acceptable_compressors']).toEqual(['ZSTD'])
  })

  it('a missing blob in a batch read is absent, not an error', async () => {
    await using({}, async (c) => {
      expect((await c.batchReadBlobs([c.digestOf(bytes('never'))])).size).toBe(0)
    })
  })

  it('reads: the framing counts, a blob past the budget streams, and a full group flushes', async () => {
    const a = fake.put(fill(900, 1))
    const b = fake.put(fill(600, 2))
    const c2 = fake.put(fill(600, 3))
    const methods = await callsOf(() =>
      using({}, async (c) => {
        const got = await c.batchReadBlobs([a, b, c2], 1000)
        expect([...got.keys()].sort()).toEqual([a.hash, b.hash, c2.hash].sort())
      }),
    )
    expect(methods).toEqual(['Read', 'BatchReadBlobs', 'BatchReadBlobs'])
  })

  it('uploads: only the missing go, a large one streams, and a full batch flushes', async () => {
    const have = fill(100, 7)
    fake.put(have)
    const small = [fill(600, 8), fill(600, 9)]
    const large = fill(2000, 10)
    await using({}, async (c) => {
      const blobs = [have, ...small, large].map((data) => ({ digest: c.digestOf(data), data }))
      const mark = fake.calls.length
      await c.uploadBlobs(blobs, 1000)
      const calls = fake.calls.slice(mark)
      expect(calls.map((x) => x.method)).toEqual([
        'FindMissingBlobs',
        'BatchUpdateBlobs',
        'Write',
        'BatchUpdateBlobs',
      ])
      const sent = calls
        .filter((x) => x.method === 'BatchUpdateBlobs')
        .flatMap((x) =>
          (x.request['requests'] as { digest: { hash: string } }[]).map((r) => r.digest.hash),
        )
      expect(sent).not.toContain(blobs[0]!.digest.hash)
    })
  })
})

describe.if(CHUNKING_SUPPORTED)('integrity and errors', () => {
  const lying = (): Digest => {
    // The right size, the wrong bytes, under the asked-for digest.
    const asked = fake.put(bytes('the real bytes'))
    fake.blobs.set(asked.hash, bytes('a forged copy!'))
    return asked
  }

  it('readBlob and batchReadBlobs refuse bytes that do not hash to the digest', async () => {
    await using({}, async (c) => {
      await expect(c.readBlob(lying())).rejects.toThrow('blob integrity failure: bytes hash to')
      await expect(c.batchReadBlobs([lying()])).rejects.toThrow('blob integrity failure')
    })
  })

  it('readBlob refuses a blob of the wrong size', async () => {
    const asked = fake.put(bytes('four'))
    fake.blobs.set(asked.hash, bytes('five!'))
    await using({}, async (c) => {
      await expect(c.readBlob(asked)).rejects.toThrow('size 5 != declared 4')
    })
  })

  it('RESOURCE_EXHAUSTED is retried as UNAVAILABLE is', async () => {
    fake.fail('FindMissingBlobs', grpc.status.RESOURCE_EXHAUSTED)
    const methods = await callsOf(() =>
      using({}, (c) => c.findMissingBlobs([c.digestOf(bytes('re'))])),
    )
    expect(methods).toEqual(['FindMissingBlobs', 'FindMissingBlobs'])
  })

  it('a refusal other than NOT_FOUND is an error, not a miss', async () => {
    await using({}, async (c) => {
      const d = fake.put(bytes('denied'))
      fake.fail('GetActionResult', grpc.status.PERMISSION_DENIED)
      await expect(c.getActionResult(d)).rejects.toThrow('PERMISSION_DENIED')
      fake.fail('Read', grpc.status.PERMISSION_DENIED)
      await expect(c.readBlob(d)).rejects.toThrow('PERMISSION_DENIED')
      fake.fail('Read', grpc.status.PERMISSION_DENIED)
      await expect(c.readBlobStream(d)).rejects.toThrow('PERMISSION_DENIED')
    })
  })

  it('a cancelled read stream cancels the call', async () => {
    const d = fake.put(fill(512 * 1024, 4))
    fake.holdReads = true
    await using({}, async (c) => {
      const before = fake.readsCancelled
      const reader = (await c.readBlobStream(d))!.getReader()
      await reader.read()
      await reader.cancel()
      const deadline = Date.now() + 3000
      while (fake.readsCancelled === before && Date.now() < deadline) await Bun.sleep(5)
      expect(fake.readsCancelled).toBe(before + 1)
    })
  })
})

describe.if(CHUNKING_SUPPORTED)('writes', () => {
  it('an empty blob is one finishing message', async () => {
    await using({}, async (c) => {
      const empty = new Uint8Array(0)
      await c.writeBlob(c.digestOf(empty), empty)
      expect(fake.writes.at(-1)).toMatchObject({ sizes: [0], finished: true })
    })
  })

  it('the last message finishes the write', async () => {
    await using({ chunkBytes: 1000 }, async (c) => {
      const data = fill(2500, 11)
      await c.writeBlob(c.digestOf(data), data)
      expect(fake.writes.at(-1)).toMatchObject({
        sizes: [1000, 1000, 500],
        offsets: [0, 1000, 2000],
        finished: true,
      })
    })
  })

  it('a streamed Blob whose size is not a whole number of messages sends its tail', async () => {
    const data = fill(5 * 1024 * 1024 + 7, 12)
    await using({}, async (c) => {
      const d = c.digestOf(data)
      await c.writeBlob(d, new Blob([data]))
      expect(fake.blobs.get(d.hash)?.length).toBe(data.length)
    })
  })

  it('under zstd, a small Blob is read and compressed; a streamed one goes as it is', async () => {
    fake.caps.compressors = ['ZSTD']
    await using({}, async (c) => {
      await c.negotiate()
      const small = bytes('small, compressible, compressible, compressible')
      await c.writeBlob(c.digestOf(small), new Blob([small]))
      expect(fake.writes.at(-1)!.resource).toContain('/compressed-blobs/zstd/')
      const large = fill(5 * 1024 * 1024, 13)
      const d = c.digestOf(large)
      await c.writeBlob(d, new Blob([large]))
      expect(fake.writes.at(-1)!.resource).toMatch(/(^|\/)uploads\/[^/]+\/blobs\//)
      expect(fake.blobs.get(d.hash)?.length).toBe(large.length)
    })
  })

  it('a stalled multi-message write retries at the safe size; a one-message stall does not', async () => {
    const warns: string[] = []
    await using({ onWarn: (m: string) => warns.push(m) }, async (c) => {
      const large = fill(300 * 1024, 14)
      const d = c.digestOf(large)
      fake.fail('Write', grpc.status.DEADLINE_EXCEEDED)
      await c.writeBlob(d, large)
      expect(warns).toEqual([
        `vx/reapi: chunked write of ${d.hash.slice(0, 12)} hit the 131072-byte chunk stall (Bun http2 flow control); retrying at ${SAFE_CHUNK_BYTES}`,
      ])
      expect(fake.writes.at(-1)!.sizes.every((n) => n <= SAFE_CHUNK_BYTES)).toBe(true)
      const small = bytes('one message')
      fake.fail('Write', grpc.status.DEADLINE_EXCEEDED)
      // `.then`, not `expect(…).rejects`: under bun test the latter held this
      // call until its 30 s deadline (item 827).
      const refused = await c.writeBlob(c.digestOf(small), small).then(
        () => 'written',
        (e: Error) => e.message,
      )
      expect(refused).toContain('DEADLINE_EXCEEDED')
    })
  })

  it('an interrupted write resumes from what the server committed', async () => {
    const data = fill(300 * 1024, 15)
    await using({ chunkBytes: 64 * 1024 }, async (c) => {
      const d = c.digestOf(data)
      fake.cutWrite = 100 * 1024
      await c.writeBlob(d, data)
      const [cut, resumed] = fake.writes.slice(-2)
      expect(resumed!.resource).toBe(cut!.resource)
      expect(resumed!.offsets[0]).toBe(100 * 1024)
      expect(fake.blobs.get(d.hash)).toEqual(data)
    })
  })

  it('a streamed Blob resumes from the committed offset too', async () => {
    const data = new Uint8Array(5 * 1024 * 1024 + 3)
    for (let i = 0; i < data.length; i++) data[i] = i % 251
    await using({}, async (c) => {
      const d = c.digestOf(data)
      fake.cutWrite = 1_000_003
      await c.writeBlob(d, new Blob([data]))
      expect(fake.writes.at(-1)!.offsets[0]).toBe(1_000_003)
      expect(fake.blobs.get(d.hash)).toEqual(data)
    })
  })

  it('a write the server calls complete is not sent again', async () => {
    const data = fill(200, 16)
    await using({}, async (c) => {
      fake.reportComplete = true
      fake.fail('Write', grpc.status.UNAVAILABLE)
      const methods = await callsOf(() => c.writeBlob(c.digestOf(data), data))
      expect(methods).toEqual(['Write', 'QueryWriteStatus'])
    })
  })
})
