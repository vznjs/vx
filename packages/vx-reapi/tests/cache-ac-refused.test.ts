// A server that takes blobs but refuses action-cache writes (a read-only
// key, an AC with updates off) answers every save the same refusal. Each
// put uploaded its whole artifact first and was refused after, so a run
// with such a key sent every artifact it built for nothing. The refusal is
// said once by core's degrade line and stands for the run: later puts fail
// the same way before sending a byte.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import * as grpc from '@grpc/grpc-js'
import { ReapiRemoteCache } from '../src/cache.js'
import { CHUNKING_SUPPORTED } from './helpers/bun-floor.js'
import { startFakeReapi, type FakeReapi } from './helpers/fake-reapi.js'

let fake: FakeReapi
beforeAll(async () => {
  fake = await startFakeReapi()
})
afterAll(() => fake.stop())

const uploads = () =>
  fake.calls.filter((c) => c.method === 'BatchUpdateBlobs' || c.method === 'Write').length

describe.if(CHUNKING_SUPPORTED)('an action cache that refuses writes', () => {
  for (const code of [grpc.status.PERMISSION_DENIED, grpc.status.UNIMPLEMENTED]) {
    it(`refused with ${grpc.status[code]}, later puts send nothing`, async () => {
      const cache = new ReapiRemoteCache({ endpoint: fake.endpoint, onWarn: () => undefined })
      fake.fail('UpdateActionResult', code, 10)
      try {
        const put = (key: string) =>
          cache.put(key, new Blob([`artifact ${key} ${code}`]), { durationMs: 1 }).then(
            () => 'stored',
            (e: { code?: number }) => e.code,
          )
        const first = await put('k-ac-1')
        const sent = uploads()
        const second = await put('k-ac-2')
        expect([first, second, uploads() - sent]).toEqual([code, code, 0])
      } finally {
        fake.fail('UpdateActionResult', code, 0)
        cache.close()
      }
    })
  }

  it('a transient refusal does not stand (control)', async () => {
    const cache = new ReapiRemoteCache({ endpoint: fake.endpoint, onWarn: () => undefined })
    fake.fail('UpdateActionResult', grpc.status.DEADLINE_EXCEEDED, 1)
    try {
      const put = (key: string) =>
        cache.put(key, new Blob([`artifact ${key}`]), { durationMs: 1 }).then(
          () => 'stored',
          (e: { code?: number }) => e.code,
        )
      expect([await put('k-ac-t1'), await put('k-ac-t2')]).toEqual([
        grpc.status.DEADLINE_EXCEEDED,
        'stored',
      ])
    } finally {
      cache.close()
    }
  })
})
