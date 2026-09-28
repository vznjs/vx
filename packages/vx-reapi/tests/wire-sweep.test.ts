// Item 823's sweep of wire.ts (setup, metadata, CAS and ByteStream): each
// row fails with one line of the client undone. Driven through the offline
// fake (helpers/fake-reapi.ts), which records what the client sent.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import http2 from 'node:http2'
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
  // Item 928: grpc-js refuses such a value on every call and quotes it in the
  // error each degrade warning printed.
  it('a header gRPC metadata cannot carry is refused at construction, its value unprinted', () => {
    const refusal = (headers: Record<string, string>): string => {
      try {
        new ReapiClient({ endpoint: fake.endpoint, headers }).close()
        return '(no refusal)'
      } catch (err) {
        return (err as Error).message
      }
    }
    const refused = (k: string) =>
      `reapi: header ${JSON.stringify(k)} holds a character gRPC metadata cannot carry (printable ASCII only) — check it (its value is not printed)`
    expect([
      refusal({ authorization: 'Bearer SECRET\nline2' }),
      refusal({ 'x-token': 'SECRET€' }),
      refusal({ authorization: 'Bearer SECRET ~ok' }),
    ]).toEqual([refused('authorization'), refused('x-token'), '(no refusal)'])
  })

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
  // F-19: one FindMissingBlobs carried every digest, and 70 000 of them
  // (4.9 MB) passed a server's 4 MiB receive limit: RESOURCE_EXHAUSTED.
  it('FindMissingBlobs splits a digest list past one message', async () => {
    const digests = Array.from({ length: 70_000 }, (_, i) => ({
      hash: i.toString(16).padStart(64, '0'),
      size_bytes: 10,
    }))
    const stored = fake.put(bytes('here'))
    let missing: string[] = []
    const calls = await callsOf(() =>
      using({}, async (c) => {
        missing = (await c.findMissingBlobs([...digests, stored])).map((d) => d.hash)
      }),
    )
    expect([calls, missing.length, new Set(missing).has(stored.hash)]).toEqual([
      ['FindMissingBlobs', 'FindMissingBlobs'],
      70_000,
      false,
    ])
  })

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
    // Short is caught at the end; long, as it passes the size (L-3).
    fake.blobs.set(asked.hash, bytes('thr'))
    await using({}, async (c) => {
      await expect(c.readBlob(asked)).rejects.toThrow('size 3 != declared 4')
    })
    fake.blobs.set(asked.hash, bytes('five!'))
    await using({}, async (c) => {
      await expect(c.readBlob(asked)).rejects.toThrow('served past its declared 4 bytes')
    })
  })

  it('RESOURCE_EXHAUSTED is retried as UNAVAILABLE is', async () => {
    fake.fail('FindMissingBlobs', grpc.status.RESOURCE_EXHAUSTED)
    const methods = await callsOf(() =>
      using({}, (c) => c.findMissingBlobs([c.digestOf(bytes('re'))])),
    )
    expect(methods).toEqual(['FindMissingBlobs', 'FindMissingBlobs'])
  })

  // F-1: INTERNAL is how grpc-js spells a call cut in transit (an
  // RST_STREAM(INTERNAL_ERROR), a stream with no status); it failed at once.
  it('INTERNAL is retried as UNAVAILABLE is, on a unary call and a Read; DATA_LOSS is not', async () => {
    const d = fake.put(bytes('internal'))
    const methods = await callsOf(() =>
      using({}, async (c) => {
        fake.fail('FindMissingBlobs', grpc.status.INTERNAL)
        await c.findMissingBlobs([d])
        fake.fail('Read', grpc.status.INTERNAL, 1)
        expect(new TextDecoder().decode((await c.readBlob(d))!)).toBe('internal')
        fake.fail('Read', grpc.status.DATA_LOSS, 1)
        expect(
          await c.readBlob(d).then(
            () => 'resolved',
            (e: Error) => e.message,
          ),
        ).toBe('15 DATA_LOSS: injected DATA_LOSS')
      }),
    )
    expect(methods).toEqual(['FindMissingBlobs', 'FindMissingBlobs', 'Read', 'Read', 'Read'])
  })

  // Item 919: a Read had no retry, unlike every unary call, so one
  // UNAVAILABLE reading a finished action's outputs failed the task.
  it("a transient Read is retried, whole or before a stream's first message", async () => {
    const d = fake.put(bytes('read me'))
    const reads = () => fake.calls.filter((x) => x.method === 'Read').length
    const before = reads()
    await using({}, async (c) => {
      fake.fail('Read', grpc.status.UNAVAILABLE, 1)
      expect(new TextDecoder().decode((await c.readBlob(d))!)).toBe('read me')
      fake.fail('Read', grpc.status.RESOURCE_EXHAUSTED, 1)
      const stream = (await c.readBlobStream(d))!
      expect(await new Response(stream).text()).toBe('read me')
    })
    expect(reads() - before).toBe(4)
  })

  it('a Read that stays unavailable fails once the retry budget is spent', async () => {
    const d = fake.put(bytes('never'))
    const reads = () => fake.calls.filter((x) => x.method === 'Read').length
    const before = reads()
    await using({}, async (c) => {
      fake.fail('Read', grpc.status.UNAVAILABLE, 4)
      const got = await c.readBlob(d).then(
        () => 'resolved',
        (e: Error) => e.message,
      )
      expect(got).toContain('UNAVAILABLE')
    })
    expect(reads() - before).toBe(4)
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

  // F-3: past its first message a streamed read errored on a transient
  // status, so a remote hit whose Read a proxy cut mid-artifact became a
  // miss. It re-opens at the offset the reader has.
  it('a streamed read cut mid-blob resumes at the offset the reader has', async () => {
    // Every offset holds a different byte, so a resume at the wrong one shows.
    const body = Uint8Array.from({ length: 200 * 1024 }, (_, i) => i % 251)
    const d = fake.put(body)
    const mark = fake.calls.length
    fake.cutReads = 2
    const got = await using({}, async (c) => new Response((await c.readBlobStream(d))!).bytes())
    const reads = fake.calls.slice(mark).filter((x) => x.method === 'Read')
    expect([
      Buffer.from(got).equals(Buffer.from(body)),
      reads.map((r) => Number(r.request['read_offset'])),
    ]).toEqual([true, [0, 65536, 131072]])
  })

  it('a streamed read cut past its retry budget errors the stream', async () => {
    const d = fake.put(fill(512 * 1024, 8))
    fake.cutReads = 4
    try {
      const got = await using({}, async (c) =>
        new Response((await c.readBlobStream(d))!).bytes().then(
          () => 'read',
          (e: Error) => e.message,
        ),
      )
      expect(got).toBe('14 UNAVAILABLE: cut mid-read')
    } finally {
      fake.cutReads = 0
    }
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
    await using({ chunkBytes: 128 * 1024, onWarn: (m: string) => warns.push(m) }, async (c) => {
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

describe('flow control', () => {
  it('the client offers a 16 MiB receive window, per stream and per connection', async () => {
    // At HTTP/2's default 64 KiB a read moves one window per round trip:
    // 8 MB took 3988 ms through a proxy adding 15 ms each way, 142 ms at
    // 16 MiB (F-32).
    const seen: { stream?: number | undefined; connection?: number | undefined } = {}
    const server = http2.createServer()
    server.on('session', (session) => {
      session.on('remoteSettings', (settings) => (seen.stream = settings.initialWindowSize))
    })
    server.on('stream', (stream: http2.ServerHttp2Stream) => {
      seen.connection = stream.session?.state.remoteWindowSize
      stream.respond(
        { ':status': 200, 'content-type': 'application/grpc', 'grpc-status': '12' },
        { endStream: true },
      )
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as { port: number }
    const c = new ReapiClient({ endpoint: `127.0.0.1:${port}` })
    try {
      await c.findMissingBlobs([{ hash: 'a'.repeat(64), size_bytes: 1 }]).catch(() => {})
      expect(seen).toEqual({ stream: 16 * 1024 * 1024, connection: 16 * 1024 * 1024 })
    } finally {
      c.close()
      server.close()
    }
  })
})
