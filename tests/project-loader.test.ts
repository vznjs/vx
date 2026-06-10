import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { loadProjectConfig, loadWorkspaceConfig } from '../src/workspace/project-loader.js'

describe('loadProjectConfig', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'vx-loader-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('loads a default-exported object from .mjs', async () => {
    const file = path.join(dir, 'vx.config.mjs')
    await writeFile(file, "export default { tasks: { build: { exec: { command: 'tsc' } } } }")
    const cfg = await loadProjectConfig(file)
    expect(cfg.tasks?.build?.exec?.command).toBe('tsc')
  })

  it('throws clearly when the config did not export a default object', async () => {
    const file = path.join(dir, 'vx.config.mjs')
    await writeFile(file, 'export const notDefault = 1')
    await expect(loadProjectConfig(file)).rejects.toThrow(/did not export a default object/)
  })

  it('throws when the default export is not an object', async () => {
    const file = path.join(dir, 'vx.config.mjs')
    await writeFile(file, 'export default 42')
    await expect(loadProjectConfig(file)).rejects.toThrow(/did not export a default object/)
  })

  describe('group tasks (no exec)', () => {
    it('accepts a task that has only dependsOn', async () => {
      const file = path.join(dir, 'vx.config.mjs')
      await writeFile(file, `export default { tasks: { install: { dependsOn: ['^build'] } } }`)
      const cfg = await loadProjectConfig(file)
      expect(cfg.tasks?.install?.exec).toBeUndefined()
      expect(cfg.tasks?.install?.dependsOn).toEqual(['^build'])
    })

    it('rejects a task with no exec and no dependsOn', async () => {
      const file = path.join(dir, 'vx.config.mjs')
      await writeFile(file, `export default { tasks: { empty: {} } }`)
      await expect(loadProjectConfig(file)).rejects.toThrow(/must declare `dependsOn`/)
    })

    it('accepts a string description on a task', async () => {
      const file = path.join(dir, 'vx.config.mjs')
      await writeFile(
        file,
        `export default { tasks: { lint: { description: 'lint with oxlint', exec: { command: 'oxlint' } } } }`,
      )
      const cfg = await loadProjectConfig(file)
      expect(cfg.tasks?.lint?.description).toBe('lint with oxlint')
    })

    it('rejects a non-string description', async () => {
      const file = path.join(dir, 'vx.config.mjs')
      await writeFile(
        file,
        `export default { tasks: { lint: { description: 42, exec: { command: 'oxlint' } } } }`,
      )
      await expect(loadProjectConfig(file)).rejects.toThrow(/description must be a string/)
    })

    it('accepts a persistent exec', async () => {
      const file = path.join(dir, 'vx.config.mjs')
      await writeFile(
        file,
        `export default { tasks: { dev: { exec: { command: 'vite', persistent: { readyWhen: 'Local:' } } } } }`,
      )
      const cfg = await loadProjectConfig(file)
      expect(cfg.tasks?.dev?.exec?.persistent?.readyWhen).toBe('Local:')
    })

    it('accepts empty persistent (ready immediately)', async () => {
      const file = path.join(dir, 'vx.config.mjs')
      await writeFile(
        file,
        `export default { tasks: { dev: { exec: { command: 'vite', persistent: {} } } } }`,
      )
      const cfg = await loadProjectConfig(file)
      expect(cfg.tasks?.dev?.exec?.persistent).toEqual({})
    })

    it('rejects cache + persistent (persistent tasks have no exit to cache)', async () => {
      const file = path.join(dir, 'vx.config.mjs')
      await writeFile(
        file,
        `export default { tasks: { dev: { exec: { command: 'vite', persistent: {} }, cache: { inputs: { files: [] }, outputs: { files: [] } } } } }`,
      )
      await expect(loadProjectConfig(file)).rejects.toThrow(
        /cache.*not allowed on a persistent task/,
      )
    })

    it('rejects non-string readyWhen', async () => {
      const file = path.join(dir, 'vx.config.mjs')
      await writeFile(
        file,
        `export default { tasks: { dev: { exec: { command: 'vite', persistent: { readyWhen: 42 } } } } }`,
      )
      await expect(loadProjectConfig(file)).rejects.toThrow(/readyWhen must be a string/)
    })

    it('rejects non-object persistent', async () => {
      const file = path.join(dir, 'vx.config.mjs')
      await writeFile(
        file,
        `export default { tasks: { dev: { exec: { command: 'vite', persistent: true } } } }`,
      )
      await expect(loadProjectConfig(file)).rejects.toThrow(/persistent must be an object/)
    })

    it('rejects cache on a group task (no exec)', async () => {
      const file = path.join(dir, 'vx.config.mjs')
      await writeFile(
        file,
        `export default { tasks: { g: {
          dependsOn: ['^build'],
          cache: { inputs: { files: ['**'] }, outputs: { files: [] } },
        } } }`,
      )
      await expect(loadProjectConfig(file)).rejects.toThrow(/`cache` requires `exec`/)
    })

    it('rejects wildcards in cache.inputs.env (no silent literal misinterpretation)', async () => {
      // Turbo expands `VERCEL_*` in env tracking; vx requires explicit
      // names so an unset wildcard doesn't silently become an empty
      // value in the cache key. Reject at load time with a clear
      // pointer to the workaround (list names individually).
      const file = path.join(dir, 'vx.config.mjs')
      await writeFile(
        file,
        `export default { tasks: { build: {
          exec: { command: 'tsc' },
          cache: { inputs: { files: ['src/**'], env: ['VERCEL_*'] }, outputs: { files: [] } },
        } } }`,
      )
      await expect(loadProjectConfig(file)).rejects.toThrow(/wildcards.*env names.*not supported/)
    })

    it('rejects non-string env entries in cache.inputs.env', async () => {
      const file = path.join(dir, 'vx.config.mjs')
      await writeFile(
        file,
        `export default { tasks: { build: {
          exec: { command: 'tsc' },
          cache: { inputs: { files: ['src/**'], env: [42] }, outputs: { files: [] } },
        } } }`,
      )
      await expect(loadProjectConfig(file)).rejects.toThrow(/env.*non-empty/)
    })

    it('rejects empty-string entries in cache.outputs.files', async () => {
      const file = path.join(dir, 'vx.config.mjs')
      await writeFile(
        file,
        `export default { tasks: { build: {
          exec: { command: 'tsc' },
          cache: { inputs: { files: ['src/**'] }, outputs: { files: [''] } },
        } } }`,
      )
      await expect(loadProjectConfig(file)).rejects.toThrow(/outputs.files.*non-empty/)
    })

    it('rejects absolute paths in cache.outputs.files (must be project-relative)', async () => {
      const file = path.join(dir, 'vx.config.mjs')
      await writeFile(
        file,
        `export default { tasks: { build: {
          exec: { command: 'tsc' },
          cache: { inputs: { files: ['src/**'] }, outputs: { files: ['/tmp/leak.js'] } },
        } } }`,
      )
      await expect(loadProjectConfig(file)).rejects.toThrow(/absolute paths are not allowed/)
    })

    it('rejects non-string entries in cache.outputs.files', async () => {
      const file = path.join(dir, 'vx.config.mjs')
      await writeFile(
        file,
        `export default { tasks: { build: {
          exec: { command: 'tsc' },
          cache: { inputs: { files: ['src/**'] }, outputs: { files: [42] } },
        } } }`,
      )
      await expect(loadProjectConfig(file)).rejects.toThrow(/outputs.files.*non-empty/)
    })

    it('rejects absolute paths in cache.inputs.files (must be project-relative)', async () => {
      const file = path.join(dir, 'vx.config.mjs')
      await writeFile(
        file,
        `export default { tasks: { build: {
          exec: { command: 'tsc' },
          cache: { inputs: { files: ['/etc/passwd'] }, outputs: { files: [] } },
        } } }`,
      )
      await expect(loadProjectConfig(file)).rejects.toThrow(/absolute paths are not allowed/)
    })

    it('rejects empty-string entries in cache.inputs.files', async () => {
      const file = path.join(dir, 'vx.config.mjs')
      await writeFile(
        file,
        `export default { tasks: { build: {
          exec: { command: 'tsc' },
          cache: { inputs: { files: [''] }, outputs: { files: [] } },
        } } }`,
      )
      await expect(loadProjectConfig(file)).rejects.toThrow(/inputs.files.*non-empty/)
    })
  })
})

describe('loadWorkspaceConfig', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'vx-ws-loader-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('returns null when no vx.workspace.* file exists', async () => {
    expect(await loadWorkspaceConfig(dir)).toBeNull()
  })

  it('loads a default-exported object from vx.workspace.mjs', async () => {
    await writeFile(
      path.join(dir, 'vx.workspace.mjs'),
      'export default { concurrency: 4, cacheDir: "build/.vx-cache" }',
    )
    const cfg = await loadWorkspaceConfig(dir)
    expect(cfg).toEqual({ concurrency: 4, cacheDir: 'build/.vx-cache' })
  })

  it('throws when concurrency is non-positive or non-integer', async () => {
    await writeFile(path.join(dir, 'vx.workspace.mjs'), 'export default { concurrency: 0 }')
    await expect(loadWorkspaceConfig(dir)).rejects.toThrow(/positive integer/)
  })

  it('throws when concurrency is a non-number', async () => {
    await writeFile(path.join(dir, 'vx.workspace.mjs'), 'export default { concurrency: "8" }')
    await expect(loadWorkspaceConfig(dir)).rejects.toThrow(/positive integer/)
  })

  it('throws when cacheDir is not a string', async () => {
    await writeFile(path.join(dir, 'vx.workspace.mjs'), 'export default { cacheDir: 7 }')
    await expect(loadWorkspaceConfig(dir)).rejects.toThrow(/must be a string/)
  })

  it('throws when the file does not export a default object', async () => {
    await writeFile(path.join(dir, 'vx.workspace.mjs'), 'export const x = 1')
    await expect(loadWorkspaceConfig(dir)).rejects.toThrow(/did not export a default object/)
  })
})
