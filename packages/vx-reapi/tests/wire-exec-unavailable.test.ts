// An Execute the server answers UNAVAILABLE before any operation exists has
// no name to re-attach by: it is sent again, on the same retry budget as a
// cache call, and a server that stays unavailable is refused with a clear
// error rather than waited on (B-99, the F stream's error-path audit).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import * as grpc from '@grpc/grpc-js'
import { ReapiClient } from '../src/wire.js'
import { CHUNKING_SUPPORTED } from './helpers/bun-floor.js'
import { startFakeReapi, type FakeReapi } from './helpers/fake-reapi.js'

let fake: FakeReapi
beforeAll(async () => {
  fake = await startFakeReapi()
})
afterAll(() => fake.stop())
beforeEach(() => {
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

describe.if(CHUNKING_SUPPORTED)('an Execute refused UNAVAILABLE', () => {
  it('before any operation is sent again and completes', async () => {
    fake.fail('Execute', grpc.status.UNAVAILABLE, 1)
    const mark = fake.calls.length
    const op = await using((c) => c.execute(c.digestOf(bytes('once refused'))))
    expect([op.done, fake.calls.slice(mark).map((x) => x.method)]).toEqual([
      true,
      ['Execute', 'Execute'],
    ])
  }, 20_000)

  it('past the retry budget is refused, not waited on', async () => {
    fake.fail('Execute', grpc.status.UNAVAILABLE, 10)
    const mark = fake.calls.length
    const refused = await using((c) =>
      c.execute(c.digestOf(bytes('always refused'))).then(
        () => 'resolved',
        (e: Error) => e.message,
      ),
    )
    expect([refused, fake.calls.slice(mark).map((x) => x.method)]).toEqual([
      '14 UNAVAILABLE: injected UNAVAILABLE',
      ['Execute', 'Execute', 'Execute', 'Execute'],
    ])
  }, 20_000)
})
