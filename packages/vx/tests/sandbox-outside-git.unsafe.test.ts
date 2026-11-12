// The wall denied only `<workspaceRoot>/.git`. A workspace below the git
// top-level, or a linked worktree (vx-dte's `local()` workers), keeps its
// git dir outside the workspace, and a sandboxed task read any project's
// committed bytes through it — the main checkout's working tree too — into
// an output no key answered for: a stale hit.
import { existsSync, realpathSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { sandboxRequestFor } from '../src/sandbox/request.js'
import { run } from './helpers/orchestrator.js'
import { sandboxAvailable } from './helpers/sandbox-gate.js'
import { addProject, gitIn, gitInit, makeWorkspace } from './helpers/workspace.js'

const available = await sandboxAvailable('sandbox outside git test')

describe.skipIf(!available)('a sandboxed task and a git dir outside the workspace', () => {
  let tmp: string
  beforeEach(async () => {
    tmp = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'vx-outside-git-')))
  })
  afterEach(() => rm(tmp, { recursive: true, force: true }))

  const projects = async (ws: string, peek: string): Promise<void> => {
    await addProject(ws, 'a', {
      config: `export default { tasks: { t: { exec: {
        command: ${JSON.stringify(`cat src/own; ${peek}; true`)},
        sandbox: { allow: { read: ['.'] } },
      } } } }\n`,
      files: { 'src/own': 'OWN\n' },
    })
    await addProject(ws, 'b', { files: { 'src/secret': 'SECRET\n' } })
  }

  const said = async (ws: string): Promise<[string | undefined, string]> => {
    const out: string[] = []
    const log = {
      status() {},
      taskStdout(_n: unknown, chunk: string) {
        out.push(chunk)
      },
      taskStderr() {},
      taskComplete() {},
    }
    const r = await run({ cwd: ws, tasks: ['a#t'], log })
    return [r.outcomes[0]?.status, out.join('')]
  }

  it('reads neither the git dir nor the rest of the top-level, below the top-level', async () => {
    const repo = path.join(tmp, 'repo')
    await mkdir(path.join(repo, 'other'), { recursive: true })
    gitInit(repo)
    await writeFile(path.join(repo, 'other', 'secret'), 'OTHER\n')
    const ws = await makeWorkspace({ dir: repo, git: false })
    const rel = path.basename(ws)
    await projects(
      ws,
      `git --git-dir=${repo}/.git show HEAD:${rel}/packages/b/src/secret 2>/dev/null; ` +
        `cat ${repo}/other/secret 2>/dev/null`,
    )
    const git = gitIn(repo)
    git('add', '-A')
    git('commit', '-qm', 'init')
    // CONTROL: the peek reads both outside the sandbox.
    const outside = Bun.spawnSync({
      cmd: ['git', `--git-dir=${repo}/.git`, 'show', `HEAD:${rel}/packages/b/src/secret`],
      stdout: 'pipe',
    })
    expect(outside.stdout.toString()).toBe('SECRET\n')
    const [status, out] = await said(ws)
    expect({
      status,
      own: out.includes('OWN'),
      secret: out.includes('SECRET'),
      other: out.includes('OTHER'),
    }).toEqual({ status: 'success', own: true, secret: false, other: false })
  })

  it('names the hidden .git outside the workspace, and suggests no grant for it', async () => {
    const repo = path.join(tmp, 'repo')
    await mkdir(repo)
    gitInit(repo)
    const ws = await makeWorkspace({ dir: repo, git: false })
    await addProject(ws, 'a', {
      config: `export default { tasks: { t: { exec: {
        command: 'git rev-parse HEAD',
        sandbox: { allow: { read: ['.'] } },
      } } } }\n`,
    })
    const git = gitIn(repo)
    git('add', '-A')
    git('commit', '-qm', 'init')
    const r = await run({ cwd: ws, tasks: ['a#t'] })
    expect(r.outcomes[0]?.status).toBe('failed')
    const lines = r.outcomes[0]?.sandbox?.lines ?? []
    // Linux traces no stat, so git's own words bring the hint; macOS
    // reports the hidden read itself. Either names the .git, and no grant.
    const named = lines.filter((l) => l.includes(`${repo}/.git`))
    expect(named).toHaveLength(1)
    expect(named[0]).toMatch(/suggests no grant/)
  })

  it('refuses a write grant into the git dir outside the workspace', async () => {
    const repo = path.join(tmp, 'repo')
    await mkdir(repo)
    gitInit(repo)
    const ws = await makeWorkspace({ dir: repo, git: false })
    await addProject(ws, 'a', {
      config: `export default { tasks: { t: { exec: {
        command: 'echo planted > ${repo}/.git/hooks/pre-commit',
        sandbox: { allow: { read: ['.'], write: ['${repo}/.git/hooks/'] } },
      } } } }\n`,
    })
    const git = gitIn(repo)
    git('add', '-A')
    git('commit', '-qm', 'init')
    const r = await run({ cwd: ws, tasks: ['a#t'] })
    expect(r.outcomes[0]?.status).toBe('failed')
    expect(existsSync(path.join(repo, '.git', 'hooks', 'pre-commit'))).toBe(false)
    const grant = { allow: { read: ['.'], write: [`${repo}/.git/hooks/`] } }
    const asked = sandboxRequestFor(
      { projectDir: path.join(ws, 'packages', 'a') },
      grant,
      ws,
      undefined,
    )
    await expect(asked).rejects.toThrow(`would make ${repo}/.git writable`)
  })

  it("reads neither the main checkout's git dir nor its working tree, in a linked worktree", async () => {
    const main = await makeWorkspace({ dir: tmp, git: 'init' })
    await projects(
      main,
      `git --git-dir=${main}/.git show HEAD:packages/b/src/secret 2>/dev/null; ` +
        `cat ${main}/packages/b/src/secret 2>/dev/null | sed s/SECRET/TREE/`,
    )
    const git = gitIn(main)
    git('add', '-A')
    git('commit', '-qm', 'init')
    const wt = path.join(tmp, 'wt')
    git('worktree', 'add', '-q', '--detach', wt)
    const [status, out] = await said(wt)
    expect({
      status,
      own: out.includes('OWN'),
      secret: out.includes('SECRET'),
      tree: out.includes('TREE'),
    }).toEqual({ status: 'success', own: true, secret: false, tree: false })
  })
})
