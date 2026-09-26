// A process exit while a verified temp is being removed. The removal
// unlinks asynchronously, and it struck the temp from the exit hook's list
// before the unlink began: an exit in between found nothing to remove and
// left the temp (item 868, the class of item 867's run-lock race). The
// unlink is held pending here, so the exit lands inside that window every
// time; its own file because `mock.module` holds for the whole file.

import * as fsPromises from 'node:fs/promises'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, it, mock } from 'bun:test'

const real = { ...fsPromises }
let hold: Promise<void> | undefined
let started: (() => void) | undefined
await mock.module('node:fs/promises', () => ({
  ...real,
  unlink: async (p: string) => {
    started?.()
    if (hold !== undefined) await hold
    return real.unlink(p)
  },
}))
const { artifactTag, resolveTurboCacheConfig, TurboRemoteCache } = await import('../src/index.js')

const KEY = 'k'.repeat(40)

it('an exit while a verified temp is being removed still takes it', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'vx-turbo-exit-'))
  try {
    const body = new Uint8Array(1024).fill(7)
    const tag = await artifactTag(Buffer.from(KEY), 'ab90', 'team_1', new Blob([body]))
    const config = resolveTurboCacheConfig(
      { apiUrl: 'http://turbo.invalid', token: 't', teamId: 'team_1', signatureKey: KEY },
      {},
    )
    const fetchImpl = (async () =>
      new Response(body, { headers: { 'x-artifact-tag': tag } })) as unknown as typeof fetch
    const got = await new TurboRemoteCache(config!, fetchImpl, dir).get('ab90')
    // The positive first: the verified body's temp is here.
    expect(readdirSync(dir)).toHaveLength(1)
    let release!: () => void
    hold = new Promise((r) => {
      release = r
    })
    const unlinking = new Promise<void>((r) => {
      started = r
    })
    const cancelling = (got as { body: Response }).body.body!.getReader().cancel()
    await unlinking
    process.emit('exit', 0)
    const left = readdirSync(dir)
    release()
    await cancelling
    expect(left).toEqual([])
  } finally {
    hold = undefined
    started = undefined
    rmSync(dir, { recursive: true, force: true })
  }
})
