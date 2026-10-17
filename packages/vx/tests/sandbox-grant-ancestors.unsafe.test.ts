// A task granted `../vx-*/package.json` globs it from `..`, which lists
// the directory above the grant. Linux mounts each hit, and bwrap makes
// every directory above a mount, so the listing worked there; seatbelt
// matches paths and refused it (EPERM), so `@vzn/vx-docs#import` failed
// on every Mac while CI, sandboxed on Linux only, stayed green (2026-10-17).
import { realpathSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { run } from './helpers/orchestrator.js'
import { sandboxAvailable } from './helpers/sandbox-gate.js'
import { addProject, makeWorkspace } from './helpers/workspace.js'

const available = await sandboxAvailable('sandbox grant ancestors test')

describe.skipIf(!available)('a glob grant outside the project, run for real', () => {
  let root: string
  beforeEach(async () => {
    root = realpathSync(await makeWorkspace({ prefix: 'vx-grant-anc-' }))
    await addProject(root, 'vx-a')
    await addProject(root, 'vx-b')
  })
  afterEach(() => rm(root, { recursive: true, force: true }))

  const outcome = async (read: string[]) => {
    await addProject(root, 'docs', {
      config: `export default { tasks: { t: { exec: {
        command: "bun -e \\"console.log([...new Bun.Glob('vx-*/package.json').scanSync({ cwd: '..' })].sort().join(','))\\"",
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
    const r = await run({ cwd: root, tasks: ['docs#t'], log })
    return [r.outcomes[0]?.status, out.trim()]
  }

  it('may list the directories above it, as on Linux', async () => {
    expect(await outcome(['../vx-*/package.json'])).toEqual([
      'success',
      'vx-a/package.json,vx-b/package.json',
    ])
  })

  it('CONTROL: with no grant there, the glob is refused', async () => {
    const [status] = await outcome([])
    expect(status).toBe('failed')
  })
})
