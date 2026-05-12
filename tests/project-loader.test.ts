import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { loadProjectConfig, loadWorkspaceConfig } from '../src/workspace/project-loader.js'

describe('loadProjectConfig', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'vzn-loader-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('loads a default-exported object from .mjs', async () => {
    const file = path.join(dir, 'vzn.config.mjs')
    await writeFile(
      file,
      "export default { run: { tasks: { build: { exec: { command: 'tsc' } } } } }",
    )
    const cfg = await loadProjectConfig(file)
    expect(cfg.run?.tasks?.build?.exec?.command).toBe('tsc')
  })

  it('throws clearly when the config did not export a default object', async () => {
    const file = path.join(dir, 'vzn.config.mjs')
    await writeFile(file, 'export const notDefault = 1')
    await expect(loadProjectConfig(file)).rejects.toThrow(/did not export a default object/)
  })

  it('throws when the default export is not an object', async () => {
    const file = path.join(dir, 'vzn.config.mjs')
    await writeFile(file, 'export default 42')
    await expect(loadProjectConfig(file)).rejects.toThrow(/did not export a default object/)
  })

  describe('group tasks (no exec)', () => {
    it('accepts a task that has only dependsOn', async () => {
      const file = path.join(dir, 'vzn.config.mjs')
      await writeFile(
        file,
        `export default { run: { tasks: { install: { dependsOn: { dependencies: ['build'] } } } } }`,
      )
      const cfg = await loadProjectConfig(file)
      expect(cfg.run?.tasks?.install?.exec).toBeUndefined()
      expect(cfg.run?.tasks?.install?.dependsOn).toEqual({ dependencies: ['build'] })
    })

    it('rejects a task with no exec and no dependsOn', async () => {
      const file = path.join(dir, 'vzn.config.mjs')
      await writeFile(file, `export default { run: { tasks: { empty: {} } } }`)
      await expect(loadProjectConfig(file)).rejects.toThrow(/must declare `dependsOn`/)
    })

    it('rejects cache on a group task (no exec)', async () => {
      const file = path.join(dir, 'vzn.config.mjs')
      await writeFile(
        file,
        `export default { run: { tasks: { g: {
          dependsOn: { dependencies: ['build'] },
          cache: { inputs: { files: ['**'] }, outputs: { files: [] } },
        } } } }`,
      )
      await expect(loadProjectConfig(file)).rejects.toThrow(/`cache` requires `exec`/)
    })
  })
})

describe('loadWorkspaceConfig', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'vzn-ws-loader-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('returns null when no vzn.workspace.* file exists', async () => {
    expect(await loadWorkspaceConfig(dir)).toBeNull()
  })

  it('loads a default-exported object from vzn.workspace.mjs', async () => {
    await writeFile(
      path.join(dir, 'vzn.workspace.mjs'),
      'export default { concurrency: 4, cacheDir: "build/.vzn-cache" }',
    )
    const cfg = await loadWorkspaceConfig(dir)
    expect(cfg).toEqual({ concurrency: 4, cacheDir: 'build/.vzn-cache' })
  })

  it('throws when concurrency is non-positive or non-integer', async () => {
    await writeFile(path.join(dir, 'vzn.workspace.mjs'), 'export default { concurrency: 0 }')
    await expect(loadWorkspaceConfig(dir)).rejects.toThrow(/positive integer/)
  })

  it('throws when concurrency is a non-number', async () => {
    await writeFile(path.join(dir, 'vzn.workspace.mjs'), 'export default { concurrency: "8" }')
    await expect(loadWorkspaceConfig(dir)).rejects.toThrow(/positive integer/)
  })

  it('throws when cacheDir is not a string', async () => {
    await writeFile(path.join(dir, 'vzn.workspace.mjs'), 'export default { cacheDir: 7 }')
    await expect(loadWorkspaceConfig(dir)).rejects.toThrow(/must be a string/)
  })

  it('throws when the file does not export a default object', async () => {
    await writeFile(path.join(dir, 'vzn.workspace.mjs'), 'export const x = 1')
    await expect(loadWorkspaceConfig(dir)).rejects.toThrow(/did not export a default object/)
  })
})
