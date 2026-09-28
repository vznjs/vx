// A mutation sweep of cache.ts (50 mutants, 44 caught): the rows its five
// real survivors lacked, and F-21's fix — the duration is metadata, so a
// failed read of it leaves the hit a hit.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import * as grpc from '@grpc/grpc-js'
import { ReapiRemoteCache, actionDigestFor } from '../src/cache.js'
import { ReapiClient } from '../src/wire.js'
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
/** An AC entry for `key` naming `artifact` at `path`, plus `extra`. */
const entry = (key: string, artifact: string, extra: Record<string, unknown> = {}, at = ARTIFACT) =>
  fake.actions.set(actionDigestFor(key).hash, {
    exit_code: 0,
    output_files: [{ path: at, digest: fake.put(bytes(artifact)), is_executable: false }],
    ...extra,
  })
const restored = async (key: string) => {
  const got = await cache.get(key)
  return got === null ? null : [await got.body.text(), got.durationMs]
}

describe.if(CHUNKING_SUPPORTED)('the cache layer, past the sweep', () => {
  it('a duration that cannot be read leaves the hit a hit (F-21)', async () => {
    const meta = fake.put(bytes('{"durationMs":9}'))
    entry('k-dur-fails', 'artifact bytes', { stdout_digest: meta })
    fake.fail('Read', grpc.status.DATA_LOSS)
    expect(await restored('k-dur-fails').catch((e: Error) => e.message)).toEqual([
      'artifact bytes',
      undefined,
    ])
  })

  it('a duration that is not JSON, or evicted from CAS, is unknown, not 0', async () => {
    entry('k-dur-junk', 'a', { stdout_raw: bytes('not json') })
    entry('k-dur-gone', 'b', {
      stdout_digest: { hash: 'f'.repeat(64), size_bytes: 16 },
    })
    expect([await restored('k-dur-junk'), await restored('k-dur-gone')]).toEqual([
      ['a', undefined],
      ['b', undefined],
    ])
  })

  it('an entry naming another path is no hit for has() or get()', async () => {
    entry('k-other', 'x', {}, 'elsewhere.tar')
    entry('k-here', 'y')
    expect([
      await cache.has('k-other'),
      await cache.get('k-other'),
      await cache.has('k-here'),
    ]).toEqual([false, null, true])
  })

  it('put records a success, and get opens the artifact while the duration reads (F-24)', async () => {
    await cache.put('k-put', new Blob([bytes('payload')]), { durationMs: 42 })
    const recorded = fake.actions.get(actionDigestFor('k-put').hash) as { exit_code: number }
    const meta = fake.put(bytes('{"durationMs":7}'))
    entry('k-order', 'art', { stdout_digest: meta })
    // The duration's read waits until the artifact's stream is opened, for at
    // most 1 s: read one after the other (the round trip F-24 removed), it
    // sees no open stream when it proceeds.
    const proto = ReapiClient.prototype
    const [readBlob, readBlobStream] = [proto.readBlob, proto.readBlobStream]
    let opened = false
    let overlapped: boolean | undefined
    proto.readBlobStream = function (this: ReapiClient, ...a: Parameters<typeof readBlobStream>) {
      opened = true
      return readBlobStream.apply(this, a)
    }
    proto.readBlob = async function (this: ReapiClient, ...a: Parameters<typeof readBlob>) {
      const until = Date.now() + 1000
      while (!opened && Date.now() < until) await Bun.sleep(5)
      overlapped ??= opened
      return readBlob.apply(this, a)
    }
    try {
      const got = await restored('k-order')
      expect([recorded.exit_code, got, overlapped]).toEqual([0, ['art', 7], true])
    } finally {
      proto.readBlob = readBlob
      proto.readBlobStream = readBlobStream
    }
  })

  // F-25: GetActionResult asked for nothing inline, so every hit spent a
  // Read on its artifact and (bazel-remote) one on its duration.
  it('a hit the server inlines takes no Read; inline bytes that do not match are streamed', async () => {
    const art = bytes('inline artifact')
    const d = fake.put(art)
    fake.actions.set(actionDigestFor('k-inline').hash, {
      exit_code: 0,
      output_files: [{ path: ARTIFACT, digest: d, is_executable: false, contents: art }],
      stdout_raw: bytes('{"durationMs":5}'),
    })
    const bad = fake.put(bytes('the real bytes'))
    fake.actions.set(actionDigestFor('k-inline-bad').hash, {
      exit_code: 0,
      output_files: [
        { path: ARTIFACT, digest: bad, is_executable: false, contents: bytes('forged') },
      ],
    })
    const mark = fake.calls.length
    const good = await restored('k-inline')
    const asked = fake.calls.slice(mark).find((c) => c.method === 'GetActionResult')!.request
    const readsGood = fake.calls.slice(mark).filter((c) => c.method === 'Read').length
    const forged = await restored('k-inline-bad')
    expect([good, readsGood, asked['inline_stdout'], asked['inline_output_files'], forged]).toEqual(
      [['inline artifact', 5], 0, true, [ARTIFACT], ['the real bytes', undefined]],
    )
  })
})
