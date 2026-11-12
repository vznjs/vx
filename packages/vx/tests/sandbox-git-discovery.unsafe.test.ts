// Every Linux mask and bind is a mount point, and git's discovery stops at
// one: a sandboxed task granted the repository's `.git` read "not a git
// repository … Stopping at filesystem boundary" (2026-10-03).
import { realpathSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { run } from './helpers/orchestrator.js'
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

  // The schema's version-stamp claim: a file the task may not read is
  // deleted to git status, so describe says dirty unless the whole
  // workspace is granted.
  it('stamps a clean tree dirty unless the whole workspace is readable', async () => {
    // A workspace each: a run rewrites the `.vx` locks the other committed.
    const stamp = async (read: string): Promise<string> => {
      const ws = realpathSync(await makeWorkspace({ prefix: 'vx-git-stamp-' }))
      await addProject(ws, 'b', { files: { 'x.txt': 'x' } })
      await addProject(ws, 'app', {
        config: `export default { tasks: { t: { exec: {
          command: 'git describe --always --dirty',
          sandbox: { allow: { read: ${read} } },
        } } } }\n`,
      })
      const git = gitIn(ws)
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
      await run({ cwd: ws, tasks: ['app#t'], log })
      await rm(ws, { recursive: true, force: true })
      return out.join('').trim()
    }
    expect(await stamp(`['.', '../../.git']`)).toEndWith('-dirty')
    expect(await stamp(`['../..', '../../.git']`)).toMatch(/^[0-9a-f]+$/)
  })

  // git probes `.git` by stat alone, which strace does not stop on
  // (TRACED_CALLS), so a task denied it failed with git's "not a git
  // repository" and nothing named the sandbox.
  it('names the .git grant when git finds no repository it was denied', async () => {
    await addProject(root, 'app', {
      config: `export default { tasks: { t: { exec: {
        command: 'git rev-parse HEAD',
        sandbox: { allow: { read: ['.'] } },
      } } } }\n`,
    })
    const git = gitIn(root)
    git('add', '-A')
    git('commit', '-qm', 'app')
    const r = await run({ cwd: root, tasks: ['t'] })
    expect(r.outcomes[0]?.status).toBe('failed')
    const lines = r.outcomes[0]?.sandbox?.lines ?? []
    expect(lines.filter((l) => l.includes("allow: { read: ['../../.git'] }"))).toHaveLength(1)
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
