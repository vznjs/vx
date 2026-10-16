// A server that refuses the credentials was reported as unreachable:
// "cannot reach the REAPI server … check the endpoint, that the server is
// running, and that this host can reach it", none of which was wrong.

import * as grpc from '@grpc/grpc-js'
import { expect, it } from 'bun:test'
import { reapi } from '../src/index.js'
import { startFakeReapi } from './helpers/fake-reapi.js'

const ctx = { warn: () => {}, workspaceRoot: '/ws', cacheDir: '/ws/.vx/cache' } as never

it('remote execution refused for its credentials says so, not "cannot reach"', async () => {
  const fake = await startFakeReapi()
  try {
    const said: string[] = []
    for (const code of [grpc.status.UNAUTHENTICATED, grpc.status.PERMISSION_DENIED]) {
      fake.fail('GetCapabilities', code)
      const p = reapi({ endpoint: fake.endpoint, execute: true })
      try {
        await p.executor?.(ctx)
      } catch (err) {
        said.push((err as Error).message)
      }
      await p.teardown?.()
    }
    expect(said).toEqual([
      `the REAPI server at ${fake.endpoint} refused the credentials for remote execution: 16 UNAUTHENTICATED: injected UNAUTHENTICATED — check the token in \`headers\`, or drop \`execute\` to use it as a cache only`,
      `the REAPI server at ${fake.endpoint} refused the credentials for remote execution: 7 PERMISSION_DENIED: injected PERMISSION_DENIED — check the token in \`headers\`, or drop \`execute\` to use it as a cache only`,
    ])
  } finally {
    fake.stop()
  }
})
