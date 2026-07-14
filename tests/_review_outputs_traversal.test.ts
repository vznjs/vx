// REPRO: `cache.outputs.files` accepts `../` traversal (loader rejects
// only absolute paths), and cleanOutputs/resolveOutputs resolve globs with
// Bun.Glob.scan against the project dir, which follows `..` OUT of the
// project. cleanOutputs rm()s the result → deletes a SIBLING project's
// files on every run.

import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { cleanOutputs, resolveOutputs } from '../src/cache/index.js'
import { validateProjectConfig } from '../src/workspace/project-loader.js'

let root: string

describe('REPRO: outputs.files ../ traversal', () => {
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'vx-review-out-'))
    await mkdir(path.join(root, 'proj', 'src'), { recursive: true })
    await mkdir(path.join(root, 'sibling', 'dist'), { recursive: true })
    await writeFile(path.join(root, 'sibling', 'dist', 'secret.js'), 'DO NOT DELETE')
    await writeFile(path.join(root, 'proj', 'src', 'a.js'), 'mine')
  })

  it('loader ACCEPTS a `../` output glob (only absolute paths are rejected)', () => {
    // This is the validation gap: `../sibling/dist/**` passes validation.
    expect(() =>
      validateProjectConfig(
        {
          tasks: {
            build: {
              exec: { command: 'echo x' },
              cache: {
                inputs: { files: ['src/**'] },
                outputs: { files: ['../sibling/dist/**'] },
              },
            },
          },
        },
        'test',
      ),
    ).not.toThrow()
  })

  it('resolveOutputs escapes the project dir via `..`', async () => {
    const projDir = path.join(root, 'proj')
    const resolved = await resolveOutputs({
      projectDir: projDir,
      outputs: ['../sibling/dist/**'],
      nestedProjectDirs: [],
    })
    // The sibling's file is resolved as an "output" of proj.
    expect(resolved).toContain(path.join(root, 'sibling', 'dist', 'secret.js'))
  })

  it('cleanOutputs DELETES a sibling project file (data loss)', async () => {
    const projDir = path.join(root, 'proj')
    const secret = path.join(root, 'sibling', 'dist', 'secret.js')
    expect(await Bun.file(secret).exists()).toBe(true)

    // Exactly what execute-task calls before every run when caching is on.
    await cleanOutputs({
      projectDir: projDir,
      outputs: ['../sibling/dist/**'],
      nestedProjectDirs: [],
    })

    expect(await Bun.file(secret).exists()).toBe(false) // gone!
  })
})
