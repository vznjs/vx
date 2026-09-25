// The fake server is only as good as its agreement with the client: each
// row drives the real ReapiClient through one of the fake's services, so a
// suite built on the fake (the wire and executor sweeps) stands on answers
// the client is known to read.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import * as grpc from '@grpc/grpc-js'
import { decodeExecuteResponseBytes } from '../src/executor.js'
import { ReapiClient } from '../src/wire.js'
import { CHUNKING_SUPPORTED } from './helpers/bun-floor.js'
import { startFakeReapi, type FakeReapi } from './helpers/fake-reapi.js'

let fake: FakeReapi
beforeAll(async () => {
  fake = await startFakeReapi()
})
afterAll(() => fake.stop())

const bytes = (s: string) => new TextEncoder().encode(s)
const client = (extra: Record<string, unknown> = {}) =>
  new ReapiClient({ endpoint: fake.endpoint, ...extra })

describe.if(CHUNKING_SUPPORTED)('the fake REAPI server, read by the real client', () => {
  it('capabilities: exec and the compressors it advertises', async () => {
    fake.caps.compressors = ['ZSTD']
    const c = client()
    try {
      const caps = await c.capabilities()
      expect([caps.execEnabled, caps.supportedCompressors]).toEqual([true, ['ZSTD']])
      await c.negotiate()
      expect(c.compressionEnabled).toBe(true)
    } finally {
      fake.caps.compressors = []
      c.close()
    }
  })

  it('CAS: a batch and a stream round trip, and what is missing is named', async () => {
    const c = client()
    try {
      const small = bytes('small blob')
      const d = c.digestOf(small)
      await c.batchUpdateBlobs([{ digest: d, data: small }])
      expect((await c.batchReadBlobs([d])).get(d.hash)).toEqual(small)
      const large = new Uint8Array(3 * 1024 * 1024).fill(7)
      const ld = c.digestOf(large)
      await c.writeBlob(ld, large)
      expect(await c.readBlob(ld)).toEqual(large)
      const absent = c.digestOf(bytes('never written'))
      expect((await c.findMissingBlobs([d, absent])).map((x) => x.hash)).toEqual([absent.hash])
    } finally {
      c.close()
    }
  })

  it('CAS under zstd: the fake stores and serves the plain bytes', async () => {
    fake.caps.compressors = ['ZSTD']
    fake.caps.batchCompressors = ['ZSTD']
    const c = client()
    try {
      await c.negotiate()
      const large = new Uint8Array(2 * 1024 * 1024).fill(3)
      const d = c.digestOf(large)
      await c.writeBlob(d, large)
      expect(fake.writes.at(-1)!.resource).toContain('/compressed-blobs/zstd/')
      expect(fake.blobs.get(d.hash)).toEqual(large)
      expect(await c.readBlob(d)).toEqual(large)
    } finally {
      fake.caps.compressors = []
      fake.caps.batchCompressors = []
      c.close()
    }
  })

  it('ActionCache: an update is what the next get returns', async () => {
    const c = client()
    try {
      const action = c.digestOf(bytes('action'))
      expect(await c.getActionResult(action)).toBeNull()
      await c.updateActionResult(action, { exit_code: 4 })
      expect((await c.getActionResult(action))?.exit_code).toBe(4)
    } finally {
      c.close()
    }
  })

  it('Execute: the stages stream, and the final response decodes', async () => {
    fake.onExecute = () => ({
      stages: ['QUEUED', 'EXECUTING'],
      response: { result: { exit_code: 3, stdout_raw: bytes('out') } },
    })
    const c = client()
    try {
      const stages: string[] = []
      const op = await c.execute(c.digestOf(bytes('a')), { onStage: (s) => stages.push(s) })
      expect(stages).toEqual(['QUEUED', 'EXECUTING', 'COMPLETED'])
      const decoded = decodeExecuteResponseBytes(op.response!.value!)
      expect(decoded.result?.exit_code).toBe(3)
    } finally {
      c.close()
    }
  })

  it('a transient status is retried; a dropped Execute re-attaches by its operation name', async () => {
    const c = client()
    try {
      const before = fake.calls.length
      fake.fail('FindMissingBlobs', grpc.status.UNAVAILABLE)
      const d = c.digestOf(bytes('probe'))
      expect((await c.findMissingBlobs([d])).map((x) => x.hash)).toEqual([d.hash])
      expect(fake.calls.slice(before).map((x) => x.method)).toEqual([
        'FindMissingBlobs',
        'FindMissingBlobs',
      ])
      fake.onExecute = (_req, method) =>
        method === 'Execute'
          ? { stages: ['QUEUED'], error: { code: grpc.status.UNAVAILABLE, details: 'gone' } }
          : { response: { result: { exit_code: 0 } } }
      const mark = fake.calls.length
      await c.execute(c.digestOf(bytes('b')))
      const calls = fake.calls.slice(mark)
      expect(calls.map((x) => x.method)).toEqual(['Execute', 'WaitExecution'])
      expect(calls[1]!.request['name']).toMatch(/^operations\/\d+$/)
    } finally {
      fake.onExecute = () => ({ response: { result: { exit_code: 0 } } })
      c.close()
    }
  })
})
