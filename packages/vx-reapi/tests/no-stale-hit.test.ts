// A remote cache's worst failure is a stale hit: an entry vx serves whose
// bytes are not the ones its key names. These rows hold the cache layer to
// "a miss or a refusal, never wrong bytes" across a failed upload and a
// corrupt download (the F stream's error-path audit, B-99).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import * as grpc from '@grpc/grpc-js'
import { ReapiRemoteCache, actionDigestFor } from '../src/cache.js'
import { CHUNKING_SUPPORTED } from './helpers/bun-floor.js'
import { startFakeReapi, type FakeReapi } from './helpers/fake-reapi.js'

let fake: FakeReapi
let cache: ReapiRemoteCache
beforeAll(async () => {
  fake = await startFakeReapi()
})
afterAll(() => fake.stop())
beforeEach(() => {
  cache?.close()
  cache = new ReapiRemoteCache({ endpoint: fake.endpoint })
})

const bytes = (s: string) => new TextEncoder().encode(s)
const ARTIFACT = 'vx-artifact.tar.zst'
/** What a get of `key` serves: its body, `miss`, or `refused` when the body errors. */
const served = async (key: string): Promise<string> => {
  const got = await cache.get(key).catch(() => null)
  if (got === null) return 'miss'
  return got.body.text().then(
    (t) => t,
    () => 'refused',
  )
}

describe.if(CHUNKING_SUPPORTED)('no stale hit from the remote cache', () => {
  it('an upload that never lands records no entry', async () => {
    // The batch and the streamed fallback both spend their retries.
    fake.fail('BatchUpdateBlobs', grpc.status.UNAVAILABLE, 4)
    fake.fail('Write', grpc.status.UNAVAILABLE, 4)
    const put = await cache.put('k-unlanded', new Blob([bytes('payload')]), { durationMs: 1 }).then(
      () => 'stored',
      () => 'rejected',
    )
    expect(put).toBe('rejected')
    expect(fake.actions.has(actionDigestFor('k-unlanded').hash)).toBe(false)
  }, 30_000)

  it('an entry the server refuses to record is no hit', async () => {
    fake.fail('UpdateActionResult', grpc.status.UNAVAILABLE, 4)
    const put = await cache
      .put('k-unrecorded', new Blob([bytes('payload')]), { durationMs: 1 })
      .then(
        () => 'stored',
        () => 'rejected',
      )
    expect([put, await served('k-unrecorded')]).toEqual(['rejected', 'miss'])
  }, 30_000)

  it('an artifact whose bytes are not its digest is never served', async () => {
    const digest = fake.put(bytes('good bytes'))
    fake.actions.set(actionDigestFor('k-forged').hash, {
      exit_code: 0,
      output_files: [{ path: ARTIFACT, digest, is_executable: false }],
    })
    // Same length, other bytes, under the honest digest.
    fake.blobs.set(digest.hash, bytes('evil bytes'))
    expect(await served('k-forged')).toBe('refused')
    // Control: the honest bytes are served.
    fake.blobs.set(digest.hash, bytes('good bytes'))
    expect(await served('k-forged')).toBe('good bytes')
  })

  it('an artifact the server cannot read is a miss, not a partial body', async () => {
    const digest = fake.put(bytes('whole artifact'))
    fake.actions.set(actionDigestFor('k-unread').hash, {
      exit_code: 0,
      output_files: [{ path: ARTIFACT, digest, is_executable: false }],
    })
    fake.fail('Read', grpc.status.DATA_LOSS, 1)
    fake.fail('BatchReadBlobs', grpc.status.DATA_LOSS, 1)
    expect(await served('k-unread')).toBe('miss')
    // Control: the same entry, read, is a hit.
    expect(await served('k-unread')).toBe('whole artifact')
  })
})
