// Item 824's sweep of wire.ts, second slice (Execute, split, splice,
// GetTree): each row fails with one line of the client undone, on the
// offline fake (helpers/fake-reapi.ts).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import * as grpc from '@grpc/grpc-js'
import { encodeDigest } from '../src/merkle.js'
import { ReapiClient } from '../src/wire.js'
import { CHUNKING_SUPPORTED } from './helpers/bun-floor.js'
import { startFakeReapi, type FakeReapi } from './helpers/fake-reapi.js'

let fake: FakeReapi
beforeAll(async () => {
  fake = await startFakeReapi()
})
afterAll(() => fake.stop())
beforeEach(() => {
  fake.caps.digestFunctions = ['SHA256']
  fake.onExecute = () => ({ response: { result: { exit_code: 0 } } })
})

const bytes = (s: string) => new TextEncoder().encode(s)
async function using<T>(f: (c: ReapiClient) => Promise<T>): Promise<T> {
  const c = new ReapiClient({ endpoint: fake.endpoint })
  try {
    return await f(c)
  } finally {
    c.close()
  }
}
const lastRequest = (method: string) =>
  fake.calls.filter((c) => c.method === method).at(-1)!.request

describe.if(CHUNKING_SUPPORTED)('what Execute asks for', () => {
  it('by default: skip the server’s cache, inline stdout and stderr, nothing else', async () => {
    await using((c) => c.execute(c.digestOf(bytes('defaults'))))
    const req = lastRequest('Execute')
    expect([req['skip_cache_lookup'], req['inline_stdout'], req['inline_stderr']]).toEqual([
      true,
      true,
      true,
    ])
    expect([
      req['inline_output_files'],
      req['execution_policy'],
      req['results_cache_policy'],
    ]).toEqual([[], null, null])
  })

  it('the options reach the request: files to inline, both priorities, the digest function', async () => {
    fake.caps.digestFunctions = ['SHA256', 'SHA512']
    await using(async (c) => {
      await c.negotiate({ digestFunction: 'SHA512' })
      await c.execute(c.digestOf(bytes('options')), {
        skipCacheLookup: false,
        inlineOutputFiles: ['out.txt'],
        priority: 3,
        resultsCachePriority: 4,
      })
    })
    const req = lastRequest('Execute')
    expect({
      skip: req['skip_cache_lookup'],
      files: req['inline_output_files'],
      priority: (req['execution_policy'] as { priority: number }).priority,
      cache: (req['results_cache_policy'] as { priority: number }).priority,
      fn: req['digest_function'],
    }).toEqual({ skip: false, files: ['out.txt'], priority: 3, cache: 4, fn: 'SHA512' })
  })
})

describe.if(CHUNKING_SUPPORTED)('the operation stream', () => {
  it('a non-transient status is thrown at once, with no re-attach', async () => {
    fake.onExecute = () => ({
      error: { code: grpc.status.INVALID_ARGUMENT, details: 'bad action' },
    })
    const mark = fake.calls.length
    await using(async (c) => {
      await expect(c.execute(c.digestOf(bytes('bad')))).rejects.toThrow('INVALID_ARGUMENT')
    })
    expect(fake.calls.slice(mark).map((x) => x.method)).toEqual(['Execute'])
  })

  it('a stream that ends with no operation is refused by name', async () => {
    fake.onExecute = () => ({ endEarly: true })
    await using(async (c) => {
      await expect(c.execute(c.digestOf(bytes('silent')))).rejects.toThrow(
        'reapi: execution stream closed with no operation',
      )
    })
  })

  it('an abort cancels the stream and says so', async () => {
    let release!: () => void
    fake.onExecute = () => ({
      stages: ['QUEUED'],
      hold: new Promise<void>((r) => {
        release = r
      }),
    })
    try {
      await using(async (c) => {
        const ctl = new AbortController()
        const running = c.execute(
          c.digestOf(bytes('aborted')),
          { onStage: () => ctl.abort() },
          ctl.signal,
        )
        const before = fake.executesCancelled
        // Bounded: an abort nobody hears would otherwise hold the file open.
        const unheard = Bun.sleep(3000).then(() => {
          throw new Error('the abort was not heard')
        })
        await expect(Promise.race([running, unheard])).rejects.toThrow('reapi: execution aborted')
        const deadline = Date.now() + 3000
        while (fake.executesCancelled === before && Date.now() < deadline) await Bun.sleep(5)
        expect(fake.executesCancelled).toBe(before + 1)
      })
    } finally {
      release()
    }
  })

  it('an abort that came before the stream is heard without opening it', async () => {
    let release!: () => void
    fake.onExecute = () => ({
      stages: ['QUEUED'],
      hold: new Promise<void>((r) => {
        release = r
      }),
    })
    try {
      await using(async (c) => {
        const ctl = new AbortController()
        ctl.abort()
        const mark = fake.calls.length
        // The listener an aborted signal never fires is the hang; bounded so
        // the row fails instead of holding the file open.
        const refused = await Promise.race([
          c.execute(c.digestOf(bytes('pre-aborted')), {}, ctl.signal),
          Bun.sleep(1000).then(() => 'the abort was not heard'),
        ]).then(
          (v) => (typeof v === 'string' ? v : 'resolved'),
          (e: Error) => e.message,
        )
        expect([refused, fake.calls.slice(mark).map((x) => x.method)]).toEqual([
          'reapi: execution aborted',
          [],
        ])
      })
    } finally {
      release?.()
    }
  })

  it('no stage is no report; an unnamed stage is STAGE_n; a stage past a digest field still reads', async () => {
    // `stage = 1` after `action_digest = 2`: valid protobuf, not the order an
    // encoder writes, so the reader must skip the digest to reach the stage.
    const digest = encodeDigest({ hash: 'a'.repeat(64), size_bytes: 3 })
    fake.onExecute = () => ({
      metadataBytes: [
        new Uint8Array([0x12, digest.length, ...digest]),
        new Uint8Array([0x08, 9]),
        new Uint8Array([0x12, digest.length, ...digest, 0x08, 2]),
      ],
    })
    const stages: string[] = []
    await using((c) => c.execute(c.digestOf(bytes('stages')), { onStage: (s) => stages.push(s) }))
    expect(stages).toEqual(['STAGE_9', 'QUEUED', 'COMPLETED'])
  })

  it('the public waitExecution re-attaches by name', async () => {
    await using((c) => c.waitExecution('operations/77'))
    expect(lastRequest('WaitExecution')['name']).toBe('operations/77')
  })
})

describe.if(CHUNKING_SUPPORTED)('split, splice and GetTree', () => {
  it('split names the chunks and the function; splice rebuilds the blob', async () => {
    const whole = bytes('split me into two halves')
    const d = fake.put(whole)
    await using(async (c) => {
      const { chunks, chunkingFunction } = await c.splitBlob(d)
      expect([chunks.length, chunkingFunction]).toEqual([2, 'FAST_CDC_2020'])
      const rebuilt = await c.spliceBlob(chunks, d)
      expect(rebuilt.hash).toBe(d.hash)
      expect(lastRequest('SpliceBlob')['blob_digest']).toEqual({
        hash: d.hash,
        size_bytes: String(d.size_bytes),
      })
    })
  })

  it('GetTree returns every page the server streams', async () => {
    const dir = (name: string) => ({
      files: [],
      directories: [],
      symlinks: [{ name, target: 't' }],
    })
    fake.tree = [dir('a'), dir('b'), dir('c')]
    const got = await using((c) => c.getTree(fake.put(bytes('root'))))
    expect(got.map((d) => d.symlinks[0]!.name)).toEqual(['a', 'b', 'c'])
  })
})
