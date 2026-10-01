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
    await writeFile(
      path.join(root, 'turbo.json'),
      JSON.stringify({ cacheMaxSize: '10GB', tasks: {} }),
    )
    const own = { cacheRetention: { olderThan: '30d' } }
    expect(await staged(turbo(), own)).toEqual({ cacheRetention: { olderThan: '30d' } })
  })

  it("the cache bounds take Turbo's grammar: a fraction, a bare number", async () => {
    // langfuse's `"cacheMaxSize": "7.5GB"`: Turbo truncates a fraction to
    // bytes, core takes whole numbers only and refused the workspace.
    const cases: [Record<string, string>, WorkspaceConfig][] = [
      [{ cacheMaxSize: '7.5GB' }, { cacheRetention: { maxSize: '7680MB' } }],
      [{ cacheMaxSize: '1.5kb' }, { cacheRetention: { maxSize: '1536B' } }],
      [{ cacheMaxSize: '1000000' }, { cacheRetention: { maxSize: '1000000B' } }],
      [{ cacheMaxSize: '2048MB' }, { cacheRetention: { maxSize: '2GB' } }],
      [{ cacheMaxSize: '0.1B' }, {}],
      [{ cacheMaxAge: '30' }, { cacheRetention: { olderThan: '30d' } }],
    ]
    for (const [keys, expected] of cases) {
      await writeFile(path.join(root, 'turbo.json'), JSON.stringify({ ...keys, tasks: {} }))
      expect({ keys, ws: await staged(turbo()) }).toEqual({ keys, ws: expected })
    }
  })

  it('a concurrency that is no positive whole number is left to the default', async () => {
    for (const concurrency of ['abc', '1.5', '-2']) {
      await writeFile(path.join(root, 'turbo.json'), JSON.stringify({ concurrency, tasks: {} }))
      expect(await staged(turbo())).toEqual({})
    }
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

// What a bare `--affected` compares with: Nx's NX_BASE over nx.json's
// defaultBase (Nx 19's affected.defaultBase before it), Turbo's
// TURBO_SCM_BASE. A key the workspace sets is its own.
describe('the affected base', () => {
  const withEnv = async <T>(name: string, value: string | undefined, fn: () => Promise<T>) => {
    const prev = process.env[name]
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
    try {
      return await fn()
    } finally {
      if (prev === undefined) delete process.env[name]
      else process.env[name] = prev
    }
  }

  it('nx(): NX_BASE, then defaultBase, then affected.defaultBase', async () => {
    const base = () => withEnv('NX_BASE', undefined, async () => (await staged(nx())).affectedBase)
    await writeFile(path.join(root, 'nx.json'), JSON.stringify({}))
    expect(await base()).toBeUndefined()
    await writeFile(
      path.join(root, 'nx.json'),
      JSON.stringify({ affected: { defaultBase: 'dev' } }),
    )
    expect(await base()).toBe('dev')
    await writeFile(
      path.join(root, 'nx.json'),
      JSON.stringify({ defaultBase: 'develop', affected: { defaultBase: 'dev' } }),
    )
    expect(await base()).toBe('develop')
    expect(
      await withEnv('NX_BASE', 'origin/next', async () => (await staged(nx())).affectedBase),
    ).toBe('origin/next')
    expect(
      await withEnv('NX_BASE', undefined, () => staged(nx(), { affectedBase: 'main' })),
    ).toEqual({ affectedBase: 'main' })
  })

  it('turbo(): TURBO_SCM_BASE', async () => {
    await writeFile(path.join(root, 'turbo.json'), JSON.stringify({ tasks: {} }))
    expect(await withEnv('TURBO_SCM_BASE', undefined, () => staged(turbo()))).toEqual({})
    expect(await withEnv('TURBO_SCM_BASE', '', () => staged(turbo()))).toEqual({})
    expect(await withEnv('TURBO_SCM_BASE', 'origin/develop', () => staged(turbo()))).toEqual({
      affectedBase: 'origin/develop',
    })
    expect(
      await withEnv('TURBO_SCM_BASE', 'origin/develop', () =>
        staged(turbo(), { affectedBase: 'main' }),
      ),
    ).toEqual({ affectedBase: 'main' })
  })
})
