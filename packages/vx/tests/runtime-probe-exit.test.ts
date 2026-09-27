// A `cache.inputs.runtime` probe still running when vx exits is taken down
// with its tree (A-9). The probe ran in vx's own group with nothing listing
// it: a Ctrl-C during key derivation, while `sleep` (standing for a hung
// `git` or `node -e …`) still ran, left the probe's shell and its child to
// init after vx had gone.

import { existsSync, readFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { isAlive, waitForDead } from './helpers/alive.js'
import { addProject, gitIn, makeWorkspace } from './helpers/workspace.js'

const CLI = path.join(import.meta.dir, '..', 'src', 'bin.ts')
let root: string

beforeEach(async () => {
  root = await makeWorkspace({ prefix: 'vx-probe-exit-' })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

it('a runtime probe running when vx exits on SIGINT is gone with its tree', async () => {
  // The probe writes its shell's pid and its child's, then waits on the child.
  await addProject(root, 'app', {
    config: `
      export default {
        tasks: {
          build: {
            exec: { command: 'true' },
            cache: {
              inputs: {
                files: ['**'],
                runtime: ['sleep 300 & echo "$$ $!" > probe.pids; wait'],
              },
              outputs: { files: [] },
            },
          },
        },
      }
    `,
  })
  gitIn(root)('add', '-A')
  gitIn(root)('commit', '-q', '-m', 'fixture')
  const pidsFile = path.join(root, 'packages', 'app', 'probe.pids')
  const vx = Bun.spawn(['bun', CLI, 'run', 'app#build'], {
    cwd: root,
    stdout: 'ignore',
    stderr: 'ignore',
    env: { ...process.env, VX_KILL_GRACE_MS: '200' },
  })
  const deadline = Date.now() + 20_000
  while (
    Date.now() < deadline &&
    !(existsSync(pidsFile) && readFileSync(pidsFile, 'utf8').includes(' '))
  ) {
    await Bun.sleep(20)
  }
  const [shell, child] = readFileSync(pidsFile, 'utf8').trim().split(' ').map(Number)
  // Control: the probe is running, both processes of it.
  expect([isAlive(shell!), isAlive(child!)]).toEqual([true, true])
  vx.kill('SIGINT')
  await vx.exited
  expect([await waitForDead(shell!, 2_000), await waitForDead(child!, 2_000)]).toEqual([true, true])
}, 40_000)
