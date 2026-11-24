// A sandboxed task's write outside its project, its error swallowed. Such a
// refusal is not reported (only the project's are violations), so the task
// passes; what must hold is that the write never lands: in a sibling
// project, the workspace root, through a link in the project, through
// /proc's view of the cwd, or in the home directory.
import { existsSync, realpathSync, symlinkSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { run } from './helpers/orchestrator.js'
import { sandboxAvailable } from './helpers/sandbox-gate.js'
import { addProject, makeWorkspace } from './helpers/workspace.js'

const available = await sandboxAvailable('sandbox swallowed writes test')
const quiet = { status() {}, taskStdout() {}, taskStderr() {}, taskComplete() {} }

describe.skipIf(!available || process.platform !== 'linux')(
  'a swallowed write outside the project',
  () => {
    let root: string
    let home: string
    beforeEach(async () => {
      root = realpathSync(await makeWorkspace({ prefix: 'vx-swallowed-' }))
      home = os.homedir()
    })
    afterEach(async () => {
      await rm(root, { recursive: true, force: true })
      await rm(path.join(home, 'vx-swallowed-probe'), { force: true })
    })

    it.each([
      ['a sibling project', '../lib/pwn.txt', 'packages/lib/pwn.txt'],
      ['the workspace root', '../../pwn.txt', 'pwn.txt'],
      ['a link in the project', 'link/pwn.txt', 'packages/lib/pwn.txt'],
      ['/proc/self/cwd', '/proc/self/cwd/../lib/pwn.txt', 'packages/lib/pwn.txt'],
      ['the home directory', '"$HOME/vx-swallowed-probe"', '~/vx-swallowed-probe'],
    ])('into %s never lands', async (_, to, landed) => {
      await addProject(root, 'lib', { files: { 'secret.txt': 'secret\n' } })
      const dir = await addProject(root, 'app', {
        config: `export default { tasks: { t: {
          exec: { command: ${JSON.stringify(`mkdir -p out && { echo pwn > ${to}; } 2>/dev/null; echo ok > out/r.txt`)},
            sandbox: { allow: { read: ['.'], write: ['out/'] } } },
          inputs: { files: ['src/**'] }, outputs: { files: ['out/**'] }, cache: true,
        } } }\n`,
        files: { 'src/a.txt': 'a\n' },
      })
      symlinkSync('../lib', path.join(dir, 'link'))
      const o = (await run({ cwd: root, tasks: ['t'], log: quiet })).outcomes[0]!
      const at = landed.startsWith('~/')
        ? path.join(home, landed.slice(2))
        : path.join(root, landed)
      expect({
        status: o.status,
        out: await readFile(path.join(dir, 'out', 'r.txt'), 'utf8'),
        landed: existsSync(at),
      }).toEqual({ status: 'success', out: 'ok\n', landed: false })
    })
  },
)
