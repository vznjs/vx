import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { affectedProjects } from '../src/workspace/index.js'
import { GitFilesCache, populateGitFilesCache } from '../src/cache/index.js'

// Regression: when the vx workspace root is a SUBDIR of the git repo (a polyglot
// repo whose JS workspace lives under e.g. `code/`), `git ls-files` prints
// cwd(workspace)-relative paths while `git status` / `git diff` print
// repo-root-relative ones. If vx keys them inconsistently, a modified file is
// never pruned from the trusted-OID set (→ STALE cache hit) and `--affected`
// under-selects. Both git commands must be normalized to workspace-relative.

async function git(cwd: string, args: string[]): Promise<void> {
  const p = Bun.spawnSync({ cmd: ['git', ...args], cwd, stdout: 'pipe', stderr: 'pipe' })
  if (p.exitCode !== 0)
    throw new Error(`git ${args.join(' ')}: ${new TextDecoder().decode(p.stderr)}`)
}

describe('workspace root is a subdirectory of the git repo', () => {
  let repo: string
  let ws: string // the workspace root = <repo>/code

  beforeEach(async () => {
    repo = await mkdtemp(path.join(tmpdir(), 'vx-subws-'))
    ws = path.join(repo, 'code')
    await mkdir(path.join(ws, 'pkg-a'), { recursive: true })
    await mkdir(path.join(ws, 'pkg-b'), { recursive: true })
    await git(repo, ['init', '-q', '-b', 'main'])
    await git(repo, ['config', 'user.email', 't@t.co'])
    await git(repo, ['config', 'user.name', 't'])
    await writeFile(path.join(ws, 'pkg-a', 'in.txt'), 'v1')
    await writeFile(path.join(ws, 'pkg-b', 'in.txt'), 'b')
    await writeFile(path.join(repo, 'toplevel.txt'), 'root') // outside the workspace
    await git(repo, ['add', '-A'])
    await git(repo, ['commit', '-q', '-m', 'init'])
  })

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true })
  })

  it('--affected flags the changed project (git diff normalized to workspace-relative)', async () => {
    await writeFile(path.join(ws, 'pkg-a', 'in.txt'), 'v2-changed')
    const projects = [
      {
        name: 'pkg-a',
        dir: path.join(ws, 'pkg-a'),
        packageJson: { name: 'pkg-a' },
        configPath: null,
      },
      {
        name: 'pkg-b',
        dir: path.join(ws, 'pkg-b'),
        packageJson: { name: 'pkg-b' },
        configPath: null,
      },
    ]
    const out = await affectedProjects({ workspaceRoot: ws, since: 'HEAD', projects })
    expect([...out]).toEqual(['pkg-a'])
  })

  it('a modified tracked file is pruned from the trusted OID set (no stale hit)', async () => {
    await writeFile(path.join(ws, 'pkg-a', 'in.txt'), 'v2-modified')
    const gfc = new GitFilesCache()
    await populateGitFilesCache(ws, [path.join(ws, 'pkg-a'), path.join(ws, 'pkg-b')], gfc)
    expect(gfc.worktreeDirty).toBe(true)
    // The dirty file must NOT carry a trusted (committed) OID — else its cache
    // key would hash the old content and serve a stale hit.
    const aOids = gfc.oidsFor(path.join(ws, 'pkg-a'))
    expect(aOids?.has(path.join(ws, 'pkg-a', 'in.txt'))).toBe(false)
    // The clean file in the sibling project keeps its trusted OID.
    const bOids = gfc.oidsFor(path.join(ws, 'pkg-b'))
    expect(bOids?.has(path.join(ws, 'pkg-b', 'in.txt'))).toBe(true)
  })
})
