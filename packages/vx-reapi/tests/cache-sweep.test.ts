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
  // Each row that meets a fault is told of it; the two below read what was said.
  cache = new ReapiRemoteCache({ endpoint: fake.endpoint, onWarn: () => undefined })
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

  // Each fault the cache works around is said, once a run (2026-10-23:
  // Vercel's refused batch query hid for a day behind a silent fallback).
  it('a duration it cannot read or parse is said, once', async () => {
    const said: string[] = []
    cache.close()
    cache = new ReapiRemoteCache({ endpoint: fake.endpoint, onWarn: (m) => said.push(m) })
    entry('k-warn-dur', 'a', { stdout_digest: fake.put(bytes('{"durationMs":9}')) })
    fake.fail('Read', grpc.status.DATA_LOSS)
    await restored('k-warn-dur')
    entry('k-warn-junk', 'b', { stdout_raw: bytes('not json') })
    entry('k-warn-junk2', 'c', { stdout_raw: bytes('nor this') })
    await restored('k-warn-junk')
    await restored('k-warn-junk2')
    expect(said).toEqual([
      expect.stringMatching(/^\[vx\] vx-reapi: reading a task duration at .* failed: 15 DATA_LOSS/),
    ])
  })

  // A 256 MiB blob named as the duration grew the process 330 MiB: it
  // was read whole for a record of some 20 bytes.
  it('reads no duration record past its cap, and says so', async () => {
    const said: string[] = []
    cache.close()
    cache = new ReapiRemoteCache({ endpoint: fake.endpoint, onWarn: (m) => said.push(m) })
    const big = fake.put(new Uint8Array(1025).fill(0x31))
    entry('k-dur-big', 'a', { stdout_digest: big })
    const before = fake.calls.length
    expect(await restored('k-dur-big')).toEqual(['a', undefined])
    const asked = fake.calls.slice(before).map((c) => JSON.stringify(c.request))
    expect(asked.filter((r) => r.includes(big.hash))).toEqual([])
    expect(said).toEqual([
      expect.stringMatching(
        /^\[vx\] vx-reapi: reading a task duration at .* failed: its record is 1025 bytes, over 1024/,
      ),
    ])
  })

  it('an upload that looks up or batches in vain says so, and still uploads', async () => {
    const said: string[] = []
    cache.close()
    cache = new ReapiRemoteCache({ endpoint: fake.endpoint, onWarn: (m) => said.push(m) })
    fake.fail('GetActionResult', grpc.status.DATA_LOSS)
    fake.fail('BatchUpdateBlobs', grpc.status.DATA_LOSS)
    await cache.put('k-warn-put', new Blob([bytes('payload')]), { durationMs: 1 })
    expect({ said, stored: await restored('k-warn-put') }).toEqual({
      said: [
        expect.stringContaining('looking up a stored entry before an upload'),
        expect.stringContaining('a batch upload (streamed instead)'),
      ],
      stored: ['payload', 1],
    })
  })

  it('an entry naming another path is no hit for has() or get()', async () => {
    entry('k-other', 'x', {}, 'elsewhere.tar')
    entry('k-here', 'y')
    expect([
      await cache.has('k-other'),
      await cache.get('k-other'),
      await cache.has('k-here'),
    ]).toEqual([null, null, expect.any(Object)])
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

  // F-26: every save probed FindMissingBlobs first, a round trip of its own
  // to skip an upload no larger than the probe for a small artifact.
  it('a small artifact is batch-sent unprobed; a large one is probed; a refused batch streams', async () => {
    const methods = async (key: string, size: number) => {
      const mark = fake.calls.length
      await cache.put(key, new Blob([new Uint8Array(size).fill(size % 251)]), { durationMs: 1 })
      // The lookup that keeps a stored entry runs beside the upload.
      const all = fake.calls.slice(mark).map((c) => c.method)
      expect(all.filter((m) => m === 'GetActionResult')).toHaveLength(1)
      return all.filter((m) => m !== 'GetActionResult')
    }
    const small = await methods('k-small', 1024)
    const large = await methods('k-large', 300 * 1024)
    fake.fail('BatchUpdateBlobs', grpc.status.INVALID_ARGUMENT)
    const refused = await methods('k-refused', 2048)
    expect([
      small,
      large.includes('FindMissingBlobs'),
      refused.slice(0, 2),
      refused.at(-1),
    ]).toEqual([
      ['BatchUpdateBlobs', 'UpdateActionResult'],
      true,
      ['BatchUpdateBlobs', 'Write'],
      'UpdateActionResult',
    ])
    expect(await restored('k-refused')).toEqual([String.fromCharCode(2048 % 251).repeat(2048), 1])
  })

  // 2026-10-15: an entry is immutable and core asks no `has` before a
  // put, so the wire keeps a stored result: UpdateActionResult replaces one.
  it('a put of a stored key keeps its result', async () => {
    entry('k-kept', 'first')
    const mark = fake.calls.length
    await cache.put('k-kept', new Blob([bytes('second')]), { durationMs: 1 })
    const methods = fake.calls.slice(mark).map((c) => c.method)
    expect([methods.includes('UpdateActionResult'), await restored('k-kept')]).toEqual([
      false,
      ['first', undefined],
    ])
  })

  // A kept entry whose blob CAS evicted missed every run, and each run's
  // put kept it again: the key never hit on that server.
  it('a put of a stored key whose blob is gone writes its own result', async () => {
    entry('k-dangling', 'gone')
    fake.blobs.delete(new Bun.CryptoHasher('sha256').update('gone').digest('hex'))
    expect(await restored('k-dangling')).toBeNull()
    await cache.put('k-dangling', new Blob([bytes('again')]), { durationMs: 1 })
    expect(await restored('k-dangling')).toEqual(['again', 1])
  })
})
