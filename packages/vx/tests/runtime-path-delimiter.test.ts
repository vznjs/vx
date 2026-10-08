// The runtime probe's PATH leads with the same bin directories as the
// task's (item 996), so it drops one holding `path.delimiter` as the task's
// does (env-path-delimiter.test.ts): joined in, it split into an entry
// relative to the probe's cwd, and the key held what a file there printed.
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { resolveInputs } from '../src/cache/inputs.js'

const D = path.delimiter

describe('a runtime probe under a directory holding the PATH delimiter', () => {
  it('does not run a file the split entry names relative to its cwd', async () => {
    const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), 'vx-rdelim-')))
    const root = path.join(parent, `x${D}y`, 'ws')
    const dir = path.join(root, 'app')
    try {
      // The split's relative half, `y/ws/app/node_modules/.bin`, under the cwd.
      const planted = path.join(dir, 'y', 'ws', 'app', 'node_modules', '.bin')
      await mkdir(planted, { recursive: true })
      const marker = path.join(parent, 'ran')
      await writeFile(path.join(planted, 'mytool'), `#!/bin/sh\necho > '${marker}'\n`)
      await chmod(path.join(planted, 'mytool'), 0o755)
      expect(existsSync(path.join(planted, 'mytool'))).toBe(true)

      const resolved = resolveInputs({
        projectDir: dir,
        workspaceRoot: root,
        envSource: {},
        inputs: { files: [], runtime: ['mytool'] },
        ownOutputs: [],
        nestedProjectDirs: [],
      })
      await expect(resolved).rejects.toThrow('runtime command exited 127')
      expect(existsSync(marker)).toBe(false)
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  })
})
