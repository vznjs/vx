import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Cache, type CacheKeyInput } from './cache.js'

describe('Cache.key', () => {
  let dir: string
  let cache: Cache
  let workspaceRoot: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'nxt-cache-key-'))
    workspaceRoot = dir
    cache = new Cache(path.join(dir, '.nxt', 'cache'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  async function writeInput(name: string, content: string): Promise<string> {
    const p = path.join(dir, name)
    await writeFile(p, content)
    return p
  }

  function baseInput(): CacheKeyInput {
    return {
      taskId: 'pkg#build',
      command: 'echo hi',
      explicitEnv: [],
      envInputs: [],
      inputFiles: [],
      workspaceRoot,
      upstreamHashes: [],
    }
  }

  it('is deterministic across repeated calls with identical input', async () => {
    const a = await cache.key(baseInput())
    const b = await cache.key(baseInput())
    expect(a).toBe(b)
  })

  it('changes when the command string changes', async () => {
    const a = await cache.key({ ...baseInput(), command: 'echo a' })
    const b = await cache.key({ ...baseInput(), command: 'echo b' })
    expect(a).not.toBe(b)
  })

  it('changes when the taskId changes', async () => {
    const a = await cache.key({ ...baseInput(), taskId: 'a#build' })
    const b = await cache.key({ ...baseInput(), taskId: 'b#build' })
    expect(a).not.toBe(b)
  })

  it('changes when an input file content changes (not just mtime)', async () => {
    const f = await writeInput('a.txt', 'one')
    const a = await cache.key({ ...baseInput(), inputFiles: [f] })
    await writeFile(f, 'two')
    const b = await cache.key({ ...baseInput(), inputFiles: [f] })
    expect(a).not.toBe(b)
  })

  it('does not change when only mtime changes (content identical)', async () => {
    const f = await writeInput('a.txt', 'same')
    const a = await cache.key({ ...baseInput(), inputFiles: [f] })
    // Touch file (rewrite same content; mtime updates).
    await writeFile(f, 'same')
    const b = await cache.key({ ...baseInput(), inputFiles: [f] })
    expect(a).toBe(b)
  })

  it('is independent of input file order in the array', async () => {
    const f1 = await writeInput('one.txt', 'first')
    const f2 = await writeInput('two.txt', 'second')
    const a = await cache.key({ ...baseInput(), inputFiles: [f1, f2] })
    const b = await cache.key({ ...baseInput(), inputFiles: [f2, f1] })
    expect(a).toBe(b)
  })

  it('changes when an explicit env value changes', async () => {
    const a = await cache.key({ ...baseInput(), explicitEnv: [['K', 'v1']] })
    const b = await cache.key({ ...baseInput(), explicitEnv: [['K', 'v2']] })
    expect(a).not.toBe(b)
  })

  it('changes when an env-input value changes', async () => {
    const a = await cache.key({ ...baseInput(), envInputs: [['MODE', 'a']] })
    const b = await cache.key({ ...baseInput(), envInputs: [['MODE', 'b']] })
    expect(a).not.toBe(b)
  })

  it('distinguishes empty value from unset (different cache keys)', async () => {
    const present = await cache.key({ ...baseInput(), envInputs: [['MODE', '']] })
    const absent = await cache.key({ ...baseInput(), envInputs: [] })
    expect(present).not.toBe(absent)
  })

  it('changes when an upstream hash changes', async () => {
    const a = await cache.key({ ...baseInput(), upstreamHashes: ['aaa'] })
    const b = await cache.key({ ...baseInput(), upstreamHashes: ['bbb'] })
    expect(a).not.toBe(b)
  })

  it('is independent of upstream hash order', async () => {
    const a = await cache.key({ ...baseInput(), upstreamHashes: ['aaa', 'bbb'] })
    const b = await cache.key({ ...baseInput(), upstreamHashes: ['bbb', 'aaa'] })
    expect(a).toBe(b)
  })

  it('produces different keys for two projects with identical relative trees', async () => {
    const f = await writeInput('a.txt', 'shared')
    const a = await cache.key({ ...baseInput(), taskId: 'pkg-a#build', inputFiles: [f] })
    const b = await cache.key({ ...baseInput(), taskId: 'pkg-b#build', inputFiles: [f] })
    expect(a).not.toBe(b)
  })
})
