import { realpathSync } from 'node:fs'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { affectedProjects } from '../src/workspace/index.js'
import { GitFilesCache, repoRootOf } from '../src/cache/index.js'
import { populateGitFilesCache } from '../src/cache/inputs.js'

// Regression: when the vx workspace root is a SUBDIR of the git repo (a polyglot
// repo whose JS workspace lives under e.g. `code/`), `git ls-files` prints
// cwd(workspace)-relative paths while `git status` / `git diff` print
// repo-root-relative ones. If vx keys them inconsistently, a modified file is
// never pruned from the trusted-OID set (→ STALE cache hit) and `--affected`
// under-selects. Both git commands must be normalized to workspace-relative.

// Signing off for every call, not per commit: this repo's own environment
// configures an ssh signing helper that talks to a local MCP server, which a
// SANDBOXED task cannot reach — so a fixture that commits passes when the
// file is run alone and fails inside the gate's shard. One row remembered
// the flag and the next did not (2026-09-20); the helper now owns it.
async function git(cwd: string, args: string[]): Promise<void> {
  const p = Bun.spawnSync({
    cmd: ['git', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgSign=false', ...args],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })
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

// The clean-filter gate walks UP from each pathspec looking for a
// `.gitattributes`, and it has to know where to stop. Deriving that from
// `--git-dir` is wrong in a linked worktree — there it names
// `<main>/.git/worktrees/<name>`, which is not an ancestor of the
// worktree's files at all, so the walk never stops and runs to `/`.
// `--show-prefix` is exact, free (same spawn) and right in all three
// layouts, so the root is derived from it instead.
describe('the repo root the attributes gate stops at', () => {
  it("matches git's own toplevel in a plain repo, a subdir workspace and a WORKTREE", async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'vx-reporoot-'))
    try {
      const main = path.join(root, 'main')
      await mkdir(path.join(main, 'code', 'pkg'), { recursive: true })
      await writeFile(path.join(main, 'code', 'pkg', 'a.txt'), 'a\n')
      await git(main, ['init', '-q'])
      await git(main, ['config', 'user.email', 'test@vx.local'])
      await git(main, ['config', 'user.name', 'vx test'])
      await git(main, ['add', '-A'])
      await git(main, ['commit', '-q', '-m', 'init'])
      const wt = path.join(root, 'wt')
      await git(main, ['worktree', 'add', '-q', wt])

      const ask = (cwd: string, args: string[]): string => {
        const p = Bun.spawnSync({ cmd: ['git', ...args], cwd, stdout: 'pipe', stderr: 'pipe' })
        return new TextDecoder().decode(p.stdout).trim()
      }
      // Each case asks GIT for the truth and compares — the prefix is what
      // vx already has in hand, the toplevel is the answer it must reach.
      for (const ws of [main, path.join(main, 'code'), wt, path.join(wt, 'code')]) {
        const prefix = ask(ws, ['rev-parse', '--show-prefix'])
        const toplevel = realpathSync(ask(ws, ['rev-parse', '--show-toplevel']))
        expect({ ws, root: realpathSync(repoRootOf(ws, prefix)) }).toEqual({ ws, root: toplevel })
      }

      // And the reason it is not derived from the git DIRECTORY: in the
      // worktree that path is not even an ancestor of the files.
      const gitDir = ask(wt, ['rev-parse', '--git-dir'])
      expect(path.dirname(path.resolve(wt, gitDir))).not.toBe(realpathSync(wt))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)
})
