// `scope: 'key'` (2026-10-20): each entry's key folds the run's ref, and a
// read asks each ref's key in order, so a server that ignores the read
// header still keeps branches apart.

import { describe, expect, it } from 'bun:test'
import { type RemoteCacheLayer, UserError } from '@vzn/vx'
import { keyedByRef, readScopes, refKey, remoteScope } from '../src/turbo-cache/scope.js'

function memory(batches = true): {
  layer: RemoteCacheLayer
  store: Map<string, string>
  asked: string[][]
} {
  const store = new Map<string, string>()
  const asked: string[][] = []
  const layer: RemoteCacheLayer = {
    has: async (h) => (asked.push([h]), store.has(h) ? {} : null),
    ...(batches
      ? {
          hasMany: async (hs: readonly string[]) => (
            asked.push([...hs]),
            new Map(hs.filter((h) => store.has(h)).map((h) => [h, {}]))
          ),
        }
      : {}),
    get: async (h) => {
      asked.push([h])
      const v = store.get(h)
      return v === undefined ? null : { body: new Blob([v]), durationMs: undefined }
    },
    put: async (h, body) => void store.set(h, await body.text()),
  }
  return { layer, store, asked }
}

const FEAT = 'refs/heads/feat'
const MAIN = 'refs/heads/main'

describe("scope: 'key'", () => {
  it("a write lands under the run's own ref; a read takes the first ref that holds the key", async () => {
    const m = memory()
    await keyedByRef(m.layer, [MAIN]).put('k1', new Blob(['main']), { durationMs: 1 })
    expect([...m.store.keys()]).toEqual([refKey(MAIN, 'k1')])
    const feat = keyedByRef(m.layer, [FEAT, MAIN])
    expect(await feat.hasMany!(['k1', 'k2'])).toEqual(new Map([['k1', {}]]))
    expect(m.asked.at(-1)).toEqual([
      refKey(FEAT, 'k1'),
      refKey(MAIN, 'k1'),
      refKey(FEAT, 'k2'),
      refKey(MAIN, 'k2'),
    ])
    expect(await (await feat.get('k1'))!.body.text()).toBe('main')
    await feat.put('k1', new Blob(['feat']), { durationMs: 1 })
    expect(m.store.get(refKey(FEAT, 'k1'))).toBe('feat')
    expect(await (await keyedByRef(m.layer, [FEAT, MAIN]).get('k1'))!.body.text()).toBe('feat')
  })

  it('without a batch probe, a read GETs each ref in order', async () => {
    const m = memory(false)
    m.store.set(refKey(MAIN, 'k1'), 'main')
    const feat = keyedByRef(m.layer, [FEAT, MAIN])
    expect(await (await feat.get('k1'))!.body.text()).toBe('main')
    expect(m.asked).toEqual([[refKey(FEAT, 'k1')], [refKey(MAIN, 'k1')]])
    expect(await feat.has('k2')).toBeNull()
  })

  it('a merge queue writes and reads as its base branch', async () => {
    const m = memory()
    const queue = keyedByRef(m.layer, ['refs/heads/gh-readonly-queue/main/pr-12-abc123', MAIN])
    await queue.put('k1', new Blob(['q']), { durationMs: 1 })
    expect([...m.store.keys()]).toEqual([refKey(MAIN, 'k1')])
    await queue.hasMany!(['k1'])
    expect(m.asked.at(-1)).toEqual([refKey(MAIN, 'k1')])
  })

  // Dropped, a worker of a `dte()` run got no OIDC token for the remote.
  it("lends the run's access through the key-scoped layer", async () => {
    const m = memory()
    const lent = { token: 't', expiresAt: 1 }
    const scoped = keyedByRef({ ...m.layer, lend: async () => lent }, [FEAT, MAIN])
    expect(await scoped.lend?.()).toEqual(lent)
    expect(keyedByRef(m.layer, [FEAT]).lend).toBeUndefined()
  })

  it("scope is 'header' unless set, and anything else is refused", () => {
    expect([remoteScope('turboCache', undefined), remoteScope('turboCache', 'key')]).toEqual([
      'header',
      'key',
    ])
    // Named as the option's other refusals name it, and a UserError: a
    // plain one printed a stack under VX_E_INTERNAL (2026-10-28).
    expect(() => remoteScope('turboCache', 'branch')).toThrow(
      new UserError(`turboCache(): scope must be 'header' or 'key', got "branch"`),
    )
    expect(() => remoteScope('turboCache', 'branch')).toThrow(UserError)
  })

  it('the read header names at most 8 refs, the first ones', () => {
    const refs = Array.from({ length: 10 }, (_, i) => `refs/heads/b${i}`)
    expect(readScopes(refs)['x-artifact-read-scopes']!.split(', ')).toEqual(refs.slice(0, 8))
  })
})
