// Core re-runs a task whose remote hit did not restore (corrupt bytes, a tag
// that does not verify) and saves it again so the good bytes go over the bad
// (remote-lane `distrust`, 2026-10-24). turboCache()'s put asked HEAD first
// and kept whatever the server held, so the bad entry stayed for every run.
import { describe, expect, it } from 'bun:test'
import { resolveTurboCacheConfig, TurboRemoteCache } from '../src/turbo-cache/index.js'

const KEY = 'k'.repeat(32)

function server() {
  const sent: string[] = []
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    sent.push(`${method} ${new URL(url).pathname}`)
    if (method === 'PUT') return new Response(null, { status: 200 })
    // It holds `aa`, with bytes no tag covers.
    return new Response(method === 'HEAD' ? null : 'garbage', {
      status: 200,
      headers: { 'x-artifact-tag': 'bm90LWEtdGFn' },
    })
  }) as typeof fetch
  return { sent, fetchImpl }
}

describe('turboCache() repairs an entry its own get could not use', () => {
  for (const signed of [false, true]) {
    it(`a put after a get of the same key uploads over it${signed ? ' (signed)' : ''}`, async () => {
      const { sent, fetchImpl } = server()
      const config = resolveTurboCacheConfig(
        {
          apiUrl: 'https://cache.example',
          token: 't',
          ...(signed ? { teamId: 'team_1', signatureKey: KEY } : {}),
        },
        {},
      )!
      const c = new TurboRemoteCache(config, fetchImpl, '/tmp')
      if (signed) await expect(c.get('aa')).rejects.toThrow(/did not verify/)
      else await (await c.get('aa'))!.body.arrayBuffer()
      await c.put('aa', new Blob(['good']), { durationMs: 1 })
      expect(sent).toEqual(['GET /v8/artifacts/aa', 'PUT /v8/artifacts/aa'])
    })
  }

  it('CONTROL: a key this process never read is asked first, and a held one is kept', async () => {
    const { sent, fetchImpl } = server()
    const config = resolveTurboCacheConfig({ apiUrl: 'https://cache.example', token: 't' }, {})!
    await new TurboRemoteCache(config, fetchImpl).put('bb', new Blob(['x']), { durationMs: 1 })
    expect(sent).toEqual(['HEAD /v8/artifacts/bb'])
  })
})
