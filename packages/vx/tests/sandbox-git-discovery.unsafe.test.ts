// Every Linux mask and bind is a mount point, and git's discovery stops at
// one: a sandboxed task granted the repository's `.git` read "not a git
// repository … Stopping at filesystem boundary" (2026-10-03).
import { realpathSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { run } from '../src/orchestrator/index.js'
import { sandboxAvailable } from './helpers/sandbox-gate.js'
import { addProject, gitIn, makeWorkspace } from './helpers/workspace.js'

const available = await sandboxAvailable('sandbox git discovery test')

describe.skipIf(!available || process.platform !== 'linux')('git in a sandboxed task', () => {
  let root: string
  beforeEach(async () => {
    root = realpathSync(await makeWorkspace({ prefix: 'vx-git-disc-' }))
  })
  afterEach(() => rm(root, { recursive: true, force: true }))

  const said = async (read: string, env = '') => {
    await addProject(root, 'app', {
      config: `export default { tasks: { t: { exec: {
        command: 'git rev-parse HEAD',
        ${env}
        sandbox: { allow: { read: ${read} } },
      } } } }\n`,
    })
    const git = gitIn(root)
    git('add', '-A')
    git('commit', '-qm', 'app')
    const out: string[] = []
    const log = {
      status() {},
      taskStdout(_n: unknown, chunk: string) {
        out.push(chunk)
      },
      taskStderr() {},
      taskComplete() {},
    }
    const r = await run({ cwd: root, tasks: ['t'], log })
    return [r.outcomes[0]?.status, out.join('').trim() === git('rev-parse', 'HEAD').trim()]
  }

  it('finds the repository whose .git it is granted', async () => {
    expect(await said(`['.', '../../.git']`)).toEqual(['success', true])
  })

  it('CONTROL: a value the task sets wins', async () => {
    expect(
      await said(
        `['.', '../../.git']`,
        `env: { define: { GIT_DISCOVERY_ACROSS_FILESYSTEM: '0' } },`,
      ),
    ).toEqual(['failed', false])
  })

  it('CONTROL: without the grant, no repository', async () => {
    expect(await said(`['.']`)).toEqual(['failed', false])
  })

  it('CONTROL: a task that names no .git does not see the variable', async () => {
    await addProject(root, 'app', {
      config: `export default { tasks: { t: { exec: {
        command: 'echo "v=\${GIT_DISCOVERY_ACROSS_FILESYSTEM-unset}"',
        sandbox: { allow: { read: ['.'] } },
      } } } }\n`,
    })
    const out: string[] = []
    const log = {
      status() {},
      taskStdout(_n: unknown, chunk: string) {
        out.push(chunk)
      },
      taskStderr() {},
      taskComplete() {},
    }
    await run({ cwd: root, tasks: ['t'], log })
    expect(out.join('').trim()).toBe('v=unset')
  })
})
