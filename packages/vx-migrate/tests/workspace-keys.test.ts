// The adopted tool's workspace keys vx has a home for (G-49's silent gaps):
// turbo.json `concurrency`, `cacheMaxSize`, `cacheMaxAge`; nx.json
// `parallel`. Read by nothing, formbricks' 10GB cache cap and
// nx-examples' `parallel: 1` did not reach the run.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { availableParallelism, tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { WorkspaceConfig } from '@vzn/vx'
import { nx, turbo } from '../src/index.js'

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-migrate-wskeys-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const staged = async (plugin: ReturnType<typeof turbo>, ws: WorkspaceConfig = {}) => {
  await plugin.config!(ws, { workspaceRoot: root, warn: () => {} })
  return ws
}

describe('turbo(): turbo.json workspace keys', () => {
  it('concurrency and the cache bounds, top level or under global', async () => {
    await writeFile(
      path.join(root, 'turbo.json'),
      JSON.stringify({ concurrency: '3', cacheMaxSize: '10GB', tasks: {} }),
    )
    expect(await staged(turbo())).toEqual({ concurrency: 3, cacheRetention: { maxSize: '10GB' } })
    await writeFile(
      path.join(root, 'turbo.json'),
      JSON.stringify({ global: { concurrency: '50%', cacheMaxAge: '2w' }, tasks: {} }),
    )
    expect(await staged(turbo())).toEqual({
      concurrency: Math.max(1, Math.floor(availableParallelism() / 2)),
      cacheRetention: { olderThan: '14d' },
    })
  })

  it('"0" is off, and a key the workspace sets is its own', async () => {
    await writeFile(
      path.join(root, 'turbo.json'),
      JSON.stringify({ concurrency: '3', cacheMaxSize: '0', cacheMaxAge: '0', tasks: {} }),
    )
    expect(await staged(turbo())).toEqual({ concurrency: 3 })
    expect(await staged(turbo(), { concurrency: 8 })).toEqual({ concurrency: 8 })
  })
})

describe('nx(): nx.json parallel', () => {
  it('parallel, or the legacy runner option, is the concurrency', async () => {
    await writeFile(path.join(root, 'nx.json'), JSON.stringify({ parallel: 1 }))
    expect(await staged(nx())).toEqual({ concurrency: 1 })
    await writeFile(
      path.join(root, 'nx.json'),
      JSON.stringify({ tasksRunnerOptions: { default: { options: { parallel: 5 } } } }),
    )
    expect(await staged(nx())).toEqual({ concurrency: 5 })
    expect(await staged(nx(), { concurrency: 2 })).toEqual({ concurrency: 2 })
  })
})
