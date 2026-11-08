// What a hook answers is read in the plugin's name: a getter or Proxy trap
// in the answer that throws is the plugin's failure, framed as every
// hook's throw is (`plugin 'X' failed in <hook>: …`), never a raw stack
// from wherever core happened to read it. And what core checks is what it
// uses: a getter that answers the check one value and the run another
// does not get past the check. The discover stage's rows sit in
// discover-stage.test.ts.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { Cache } from '../src/cache/index.js'
import type { TaskNode } from '../src/graph/index.js'
import type { FingerprintContext, VxPlugin } from '../src/orchestrator/index.js'
import {
  applyConfigHooks,
  applyKeyHooks,
  applyScheduleHooks,
  claimedAffected,
  claimedDigests,
  resolveCache,
  resolveExecutors,
} from '../src/orchestrator/plugin-host.js'
import { testPlugin } from './helpers/plugin.js'

const trap = (): never => {
  throw new Error('trap')
}
const throwing = (): Record<string, unknown> =>
  Object.defineProperty({}, 'x', { enumerable: true, get: () => trap() })
/** A Proxy over `target` whose every read throws, but `then`: an `await` of it reads that first. */
const trapped = (target: object): object =>
  new Proxy(target, { get: (_t, k) => (k === 'then' ? undefined : trap()) })
/** A Proxy whose prototype cannot be asked for. */
const protoTrapped = (): object => new Proxy({}, { getPrototypeOf: trap })

const said = (work: () => Promise<unknown>): Promise<string> =>
  work().then(
    () => 'ok',
    (e: Error) => `${e.constructor.name}: ${e.message}`,
  )

describe('a hostile hook answer is refused naming the plugin', () => {
  it('key', async () => {
    const keyed = (answer: () => unknown): Promise<string> =>
      said(() =>
        applyKeyHooks(
          [testPlugin('org/h', { key: answer as never })],
          new Map([['a#build', { id: 'a#build' } as TaskNode]]),
          {} as never,
        ),
      )
    expect([await keyed(throwing), await keyed(protoTrapped)]).toEqual([
      "UserError: plugin 'org/h' failed in key: trap",
      "UserError: plugin 'org/h' failed in key: trap",
    ])
  })

  it('executor', async () => {
    const ctx = { workspaceRoot: '/ws', cacheDir: '/ws/.vx/cache', warn: () => {}, concurrency: 1 }
    const resolved = (extra: () => object): Promise<string> =>
      said(() =>
        resolveExecutors(
          [
            testPlugin('org/h', {
              executor: () =>
                Object.defineProperties(
                  { name: 'pool', execute: () => Promise.reject(new Error('unused')) },
                  Object.getOwnPropertyDescriptors(extra()),
                ) as never,
            }),
          ],
          ctx as never,
        ),
      )
    expect([
      await resolved(() => ({
        get remote(): never {
          return trap()
        },
      })),
      await resolved(() => ({
        get platforms(): never {
          return trap()
        },
      })),
    ]).toEqual([
      "UserError: plugin 'org/h' failed in executor: trap",
      "UserError: plugin 'org/h' failed in executor: trap",
    ])
  })

  it('cache', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'vx-hostile-cache-'))
    const local = new Cache(path.join(dir, 'c'))
    try {
      const host = {
        workspaceRoot: '/ws',
        cacheDir: '/ws/.vx/cache',
        warn: () => {},
        scope: undefined,
        refs: [],
        localCache: local,
        policy: { localRead: true, localWrite: true, remoteRead: true, remoteWrite: true },
      }
      const remote = (answer: object): Promise<string> =>
        said(() => resolveCache([testPlugin('org/h', { cache: () => answer as never })], host))
      expect([
        await remote(trapped({})),
        await remote({
          get has(): never {
            return trap()
          },
          get: () => {},
          put: () => {},
        }),
      ]).toEqual([
        "UserError: plugin 'org/h' failed in cache: trap",
        "UserError: plugin 'org/h' failed in cache: trap",
      ])
    } finally {
      local.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('fingerprint', async () => {
    const ctx = { workspaceRoot: '/ws', projects: [{ name: 'a' }] } as unknown as FingerprintContext
    const claim = (fingerprint: Partial<NonNullable<VxPlugin['fingerprint']>>): VxPlugin =>
      testPlugin('org/h', {
        fingerprint: { files: ['pnpm-lock.yaml'], affected: () => undefined, ...fingerprint },
      })
    let reads = 0
    expect([
      await said(() =>
        claimedAffected(claim({ affected: () => trapped([]) as never }), {} as never, ctx),
      ),
      await said(() =>
        claimedDigests(claim({ digests: () => trapped({}) as never }), 'pnpm-lock.yaml', ctx),
      ),
      await said(() =>
        claimedDigests(
          claim({ digests: () => ({ hash: 'h', projects: throwing() }) as never }),
          'pnpm-lock.yaml',
          ctx,
        ),
      ),
      // A digest read as a string to the check and as a number after it.
      await claimedDigests(
        claim({
          digests: () =>
            ({
              hash: 'h',
              projects: Object.defineProperty({}, 'a', {
                enumerable: true,
                get: () => (++reads === 1 ? 'd' : 5),
              }),
            }) as never,
        }),
        'pnpm-lock.yaml',
        ctx,
      ),
    ]).toEqual([
      "UserError: plugin 'org/h' failed in fingerprint: trap",
      "UserError: plugin 'org/h' failed in fingerprint: trap",
      "UserError: plugin 'org/h' failed in fingerprint: trap",
      { hash: 'h', projects: { a: 'd' } },
    ])
  })

  it('schedule', async () => {
    class Weights extends Map<string, number> {
      override [Symbol.iterator](): never {
        return trap()
      }
    }
    expect(
      await said(() =>
        applyScheduleHooks(
          [testPlugin('org/h', { schedule: () => new Weights() })],
          new Map([['a#build', {} as TaskNode]]),
          {} as never,
        ),
      ),
    ).toBe("UserError: plugin 'org/h' failed in schedule: trap")
  })

  it('config', async () => {
    expect(
      await said(() =>
        applyConfigHooks(
          [testPlugin('org/h', { config: () => protoTrapped() as never })],
          {} as never,
          {} as never,
        ),
      ),
    ).toBe("UserError: plugin 'org/h' failed in config: trap")
  })
})
