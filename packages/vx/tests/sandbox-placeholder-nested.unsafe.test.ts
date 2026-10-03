// A literal write grant on a path that does not exist is bound as an empty
// file, and the hint beside the failure named the symptom of `mkdir -p dist`
// only ("File exists"). A task making a directory INSIDE it (`mkdir -p
// coverage/lcov`, a coverage tool's layout) reads "Not a directory"
// instead, a message the hint did not name (B-96).

import { rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { addProject, makeWorkspace } from './helpers/workspace.js'
import { sandboxAvailable } from './helpers/sandbox-gate.js'

const available = await sandboxAvailable('sandbox nested placeholder test')
const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')

describe.skipIf(!available || process.platform !== 'linux')(
  'a directory made inside a file grant',
  () => {
    let root = ''
    beforeEach(async () => {
      root = await makeWorkspace({ prefix: 'vx-nested-placeholder-' })
      await addProject(
        root,
        'app',
        `
        export default { tasks: { cov: { exec: {
          command: 'mkdir -p coverage/lcov && echo x > coverage/lcov/a.txt',
          sandbox: { allow: { read: ['.'], write: ['coverage'] } },
        } } } }
      `,
      )
    })
    afterEach(async () => {
      await rm(root, { recursive: true, force: true })
    })

    it('names the "Not a directory" the task read, and the spelling that fixes it', async () => {
      const proc = Bun.spawn([process.execPath, BIN, 'run', 'cov', '--all'], {
        cwd: root,
        env: { ...process.env, NO_COLOR: '1' },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [out, err] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ])
      expect(await proc.exited).toBe(1)
      const text = out + err
      // The positive first: the task met the symptom this row is about.
      expect(text).toContain('Not a directory')
      const hint = text.split('\n').find((l) => l.includes('write grant `coverage` named nothing'))
      expect(hint).toBeString()
      expect(hint).toContain('"Not a directory"')
      expect(hint).toContain('spell the grant `coverage/`')
    }, 60_000)
  },
)
