// Every Linux mask and bind is a mount point, and git's discovery stops at
// one: a sandboxed task granted the repository's `.git` read "not a git
// repository … Stopping at filesystem boundary" (2026-10-03).
import { realpathSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { run } from './helpers/orchestrator.js'
import { sandboxAvailable } from './helpers/sandbox-gate.js'
import { addProject, gitIn, gitInit, makeWorkspace } from './helpers/workspace.js'

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

  // A submodule's `.git` is a file naming `.git/modules/<path>` of the
  // outer repository, inside the workspace: the hint said its data lay
  // outside and suggested no grant, though granting it works.
  it('names the grant for a submodule project whose repository it was denied', async () => {
    const inner = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'vx-git-sub-')))
    try {
      gitInit(inner)
      await writeFile(path.join(inner, 'package.json'), '{"name":"sub"}\n')
      const config = (read: string) =>
        `export default { tasks: { t: { exec: { command: 'git rev-parse HEAD', sandbox: { allow: { read: ${read} } } } } } }\n`
      await writeFile(path.join(inner, 'vx.config.mjs'), config(`['.']`))
      gitIn(inner)('add', '-A')
      gitIn(inner)('commit', '-qm', 'sub')
      const head = gitIn(inner)('rev-parse', 'HEAD').trim()
      await mkdir(path.join(root, 'packages'), { recursive: true })
      const git = gitIn(root)
      git('-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', inner, 'packages/sub')
      git('commit', '-qm', 'sub')
      const r = await run({ cwd: root, tasks: ['t'] })
      expect(r.outcomes[0]?.status).toBe('failed')
      const grant = "allow: { read: ['../../.git/modules/packages/sub'] }"
      expect((r.outcomes[0]?.sandbox?.lines ?? []).filter((l) => l.includes(grant))).toHaveLength(1)
      await writeFile(
        path.join(root, 'packages', 'sub', 'vx.config.mjs'),
        config(`['.', '../../.git/modules/packages/sub']`),
      )
      const out: string[] = []
      const log = {
        status() {},
        taskStdout(_n: unknown, chunk: string) {
          out.push(chunk)
        },
        taskStderr() {},
        taskComplete() {},
      }
      const granted = await run({ cwd: root, tasks: ['t'], log })
      expect([granted.outcomes[0]?.status, out.join('').trim()]).toEqual(['success', head])
    } finally {
      await rm(inner, { recursive: true, force: true })
    }
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
