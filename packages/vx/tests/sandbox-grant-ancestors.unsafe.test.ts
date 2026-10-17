// A task granted `../vx-*/package.json` globs it from `..`, which lists
// the directory above the grant. Linux mounts each hit, and bwrap makes
// every directory above a mount, so the listing worked there; seatbelt
// matches paths and refused it (EPERM), so `@vzn/vx-docs#import` failed
// on every Mac while CI, sandboxed on Linux only, stayed green (2026-10-17).
// The rows assert what the task printed, the same on both platforms: a
// refused read fails the task on each, so the status says nothing here.
import { realpathSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { run } from './helpers/orchestrator.js'
import { sandboxAvailable } from './helpers/sandbox-gate.js'
import { addProject, makeWorkspace } from './helpers/workspace.js'

const available = await sandboxAvailable('sandbox grant ancestors test')

const PROBE = `bun -e "console.log('glob', [...new Bun.Glob('b*/x.txt').scanSync({ cwd: '..' })].sort().join(','))"
ls ../b1 > /dev/null 2>&1 && echo ls-b1
cat ../b2/x.txt 2> /dev/null
cat ../c/x.txt 2> /dev/null
ls ../c > /dev/null 2>&1 && echo ls-c
true
`

describe.skipIf(!available)('a glob grant outside the project, run for real', () => {
  let root: string
  beforeEach(async () => {
    root = realpathSync(await makeWorkspace({ prefix: 'vx-grant-anc-' }))
    for (const name of ['b1', 'b2', 'c']) {
      await addProject(root, name, { files: { 'x.txt': `${name}-data\n` } })
    }
  })
  afterEach(() => rm(root, { recursive: true, force: true }))

  const printed = async (read: string[]) => {
    await addProject(root, 'a', {
      files: { 'probe.sh': PROBE },
      config: `export default { tasks: { t: { exec: {
        command: 'sh probe.sh',
        sandbox: { allow: { read: ${JSON.stringify(['.', ...read])}, systemInfo: ['vfs.disk-space'] } },
      } } } }\n`,
    })
    let out = ''
    const log = {
      status() {},
      taskStdout(_n: unknown, chunk: string) {
        out += chunk
      },
      taskStderr() {},
      taskComplete() {},
    }
    await run({ cwd: root, tasks: ['a#t'], log })
    return out.trim().split('\n')
  }

  it('may list the directories above it and those it names, as on Linux; never another', async () => {
    expect(await printed(['../b*/x.txt'])).toEqual(['glob b1/x.txt,b2/x.txt', 'ls-b1', 'b2-data'])
  })

  it('CONTROL: with no grant there, nothing outside the project is seen', async () => {
    expect((await printed([])).filter((l) => /b1|b2|c-data|ls-/.test(l))).toEqual([])
  })
})
