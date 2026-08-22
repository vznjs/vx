import { describe, expect, it } from 'bun:test'
import {
  builtinPlugins,
  localCachePlugin,
  localExecutorPlugin,
  withBuiltins,
  type VxPlugin,
} from '../src/orchestrator/index.js'

describe('built-in plugins', () => {
  it('are named under the vx/ prefix and contribute exactly one capability each', () => {
    const [exec, cache] = builtinPlugins()
    expect(exec!.name).toBe('vx/local-executor')
    expect(typeof exec!.executor).toBe('function')
    expect(exec!.cache).toBeUndefined()
    expect(cache!.name).toBe('vx/local-cache')
    expect(typeof cache!.cache).toBe('function')
    expect(cache!.executor).toBeUndefined()
  })

  it('withBuiltins appends the built-ins after user plugins when absent', () => {
    const user: VxPlugin = { name: 'org/x', executor: () => undefined }
    expect(withBuiltins([user]).map((p) => p.name)).toEqual([
      'org/x',
      'vx/local-executor',
      'vx/local-cache',
    ])
  })

  it('withBuiltins keeps a user-declared built-in at its declared position and does not duplicate it', () => {
    const user: VxPlugin = { name: 'org/x', executor: () => undefined }
    const list = withBuiltins([localExecutorPlugin(), user])
    expect(list.map((p) => p.name)).toEqual(['vx/local-executor', 'org/x', 'vx/local-cache'])
  })

  it('withBuiltins with no user plugins is exactly the built-ins', () => {
    expect(withBuiltins([]).map((p) => p.name)).toEqual(['vx/local-executor', 'vx/local-cache'])
    expect(withBuiltins(undefined).map((p) => p.name)).toEqual([
      'vx/local-executor',
      'vx/local-cache',
    ])
  })

  it('localCachePlugin hands back the local cache the host passes in', async () => {
    const marker = { hasRemote: false } as never
    const layer = await localCachePlugin().cache!({
      workspaceRoot: '/ws',
      cacheDir: '/ws/.vx/cache',
      warn: () => undefined,
      localCache: marker,
      policy: { localRead: true, localWrite: true, remoteRead: false, remoteWrite: false },
    })
    expect(layer).toBe(marker)
  })

  it('localExecutorPlugin contributes the local executor', async () => {
    const exec = await localExecutorPlugin().executor!({
      workspaceRoot: '/ws',
      cacheDir: '/ws/.vx/cache',
      warn: () => undefined,
      concurrency: 2,
    })
    expect(exec?.name).toBe('local')
  })
})
