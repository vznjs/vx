// A `node_modules/.bin` under a directory holding `path.delimiter` cannot be
// named in PATH: joined in, it split into two entries naming nothing, the
// second RELATIVE and so resolved against the task's cwd, and the 127
// verdict said the bin was "first" on PATH (2026-10-02).
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { buildIsolatedEnv } from '../src/exec/env.js'
import { shellVerdict } from '../src/orchestrator/shell-verdict.js'
import { run } from '../src/orchestrator/index.js'
import { addProject, makeWorkspace } from './helpers/workspace.js'

const D = path.delimiter
const quiet = { status() {}, taskStdout() {}, taskStderr() {}, taskComplete() {} }

describe('a bin directory holding the PATH delimiter', () => {
  it('is left out of PATH; the other bin and the parent PATH stay', () => {
    const env = buildIsolatedEnv({
      passThrough: [],
      define: {},
      source: { PATH: '/usr/bin' },
      binPaths: [`/w/a${D}b/node_modules/.bin`, '/w2/node_modules/.bin'],
    })
    expect(env.PATH).toBe(`/w2/node_modules/.bin${D}/usr/bin`)
  })

  it('the 127 verdict names the directory and the delimiter', () => {
    const bin = `/w/a${D}b/node_modules/.bin`
    expect(shellVerdict({ code: 127, command: 'mytool', cwd: '/w', bins: [bin] })).toBe(
      `[vx] exit 127 is the shell's "command not found": mytool is not on this task's PATH — ${bin} holds "${D}", which PATH reads as a separator, so vx cannot put it there; move the workspace to a path without "${D}"`,
    )
  })

  it('a task does not run a file the split entry names relative to its cwd', async () => {
    const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), 'vx-delim-')))
    const outer = path.join(parent, `x${D}y`)
    await mkdir(outer)
    try {
      const root = await makeWorkspace({ dir: outer, prefix: 'ws-' })
      const dir = await addProject(root, 'app', {
        config: `export default { tasks: { t: { exec: { command: 'mytool' } } } }\n`,
      })
      // The split's relative half: `y/<ws>/packages/app/node_modules/.bin`.
      const rel = path.relative(outer, path.join(dir, 'node_modules', '.bin'))
      const planted = path.join(dir, 'y', rel)
      await mkdir(planted, { recursive: true })
      const marker = path.join(parent, 'ran')
      await writeFile(path.join(planted, 'mytool'), `#!/bin/sh\necho > '${marker}'\n`)
      await chmod(path.join(planted, 'mytool'), 0o755)
      expect(existsSync(path.join(planted, 'mytool'))).toBe(true)

      const r = await run({ cwd: root, tasks: ['t'], log: quiet })
      expect(r.ok).toBe(false)
      expect(existsSync(marker)).toBe(false)
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  })
})
