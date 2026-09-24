import { realpathSync } from 'node:fs'
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { affectedProjects } from '../src/workspace/index.js'
import { GitFilesCache, repoRootOf } from '../src/cache/index.js'
import { populateGitFilesCache } from '../src/cache/inputs.js'
import { run, type Logger } from '../src/orchestrator/index.js'
import { dry, type DryTask } from './helpers/parity.js'
import { BIN, SETTLE_MS, executions, initialOnly, startWatch, until } from './helpers/watch-loop.js'
import { addProject, gitIn, gitInitCommit, makeWorkspace } from './helpers/workspace.js'

const quiet: Logger = { status() {}, taskStdout() {}, taskStderr() {}, taskComplete() {} }

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

// A linked `git worktree add` checkout has a `.git` FILE pointing into the
// main repository, and `git status` there reports against the worktree's
// own index. The key reads that enumeration, so a run there must miss,
// save, hit, and re-key on an edit exactly as in the main checkout.
describe('workspace inside a linked git worktree', () => {
  let main: string
  let linked: string

  beforeEach(async () => {
    main = await makeWorkspace({ prefix: 'vx-wt-main-' })
    await addProject(main, 'app', {
      config: `
        export default {
          tasks: {
            build: {
              exec: { command: 'cat src/in.txt > out.txt' },
              cache: { inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] } },
            },
          },
        }
      `,
      files: { 'src/in.txt': 'v1' },
    })
    await git(main, ['add', '-A'])
    await git(main, ['commit', '-q', '-m', 'init'])
    linked = await mkdtemp(path.join(tmpdir(), 'vx-wt-linked-'))
    await git(main, ['worktree', 'add', '-q', linked])
  })

  afterEach(async () => {
    await rm(linked, { recursive: true, force: true })
    await rm(main, { recursive: true, force: true })
  })

  it('a first run misses and saves, a second hits and restores, an edit re-keys', async () => {
    expect((await stat(path.join(linked, '.git'))).isFile()).toBe(true)
    const out = path.join(linked, 'packages', 'app', 'out.txt')
    const statuses = async (): Promise<string[]> =>
      (await run({ cwd: linked, tasks: ['build'], log: quiet })).outcomes.map(
        (o) => `${o.node.id} ${o.status}`,
      )

    expect(await statuses()).toEqual(['app#build success'])
    await rm(out)
    expect(await statuses()).toEqual(['app#build cache-hit'])
    expect(await readFile(out, 'utf8')).toBe('v1')

    await writeFile(path.join(linked, 'packages', 'app', 'src', 'in.txt'), 'v2')
    expect(await statuses()).toEqual(['app#build success'])
    expect(await readFile(out, 'utf8')).toBe('v2')
  }, 30_000)

  // turborepo#5217: a key that folded the checkout's absolute path differed
  // between two checkouts of one commit, so a shared remote never hit.
  it('the main checkout and a linked worktree at a longer path derive the same keys', async () => {
    await mkdir(path.join(main, 'shared'), { recursive: true })
    await writeFile(path.join(main, 'shared', 'base.json'), '{}')
    await writeFile(
      path.join(main, 'packages', 'app', 'vx.config.mjs'),
      `
        export default {
          tasks: {
            build: {
              exec: { command: 'cat src/in.txt > out.txt' },
              cache: {
                inputs: { files: ['src/**'], workspaceFiles: ['shared/**'] },
                outputs: { files: ['out.txt'] },
              },
            },
          },
        }
      `,
    )
    await git(main, ['add', '-A'])
    await git(main, ['commit', '-q', '-m', 'workspace input'])
    const deep = path.join(linked, 'a', 'much', 'longer', 'checkout')
    await mkdir(path.dirname(deep), { recursive: true })
    await git(main, ['worktree', 'add', '-q', deep])
    for (const root of [main, deep]) {
      await writeFile(path.join(root, 'packages', 'app', 'src', 'untracked.txt'), 'u')
    }
    const keys = async (cwd: string) =>
      (await dry(cwd, ['build', '--all'])).map((t) => `${t.id} ${t.hash}`)

    const inMain = await keys(main)
    expect(inMain).toHaveLength(1)
    expect(await keys(deep)).toEqual(inMain)
  }, 30_000)

  // nx#36675: a worktree sharing the main checkout's cache replayed main's
  // entry after an edit in the worktree.
  it('a worktree sharing the cache directory misses on its own edit and never replays main', async () => {
    const shared = path.join(linked, '..', `${path.basename(linked)}-cache`)
    const once = async (cwd: string) => {
      const r = await run({ cwd, tasks: ['build'], cacheDir: shared, log: quiet })
      return [
        r.outcomes.map((o) => o.status).join(),
        await readFile(path.join(cwd, 'packages', 'app', 'out.txt'), 'utf8'),
      ]
    }
    try {
      await writeFile(path.join(main, 'packages', 'app', 'src', 'in.txt'), 'PASS-main')
      expect(await once(main)).toEqual(['success', 'PASS-main'])

      await writeFile(path.join(linked, 'packages', 'app', 'src', 'in.txt'), 'CHANGED-in-wt')
      expect(await once(linked)).toEqual(['success', 'CHANGED-in-wt'])
      expect(await once(linked)).toEqual(['cache-hit', 'CHANGED-in-wt'])

      expect(await once(main)).toEqual(['cache-hit', 'PASS-main'])
    } finally {
      await rm(shared, { recursive: true, force: true })
    }
  }, 30_000)
})

// turborepo#567: `turbo run lint` from a pre-commit hook failed although
// every task passed. A hook runs with git's own environment — GIT_INDEX_FILE
// names the index being committed, a temporary one for `git commit <path>`
// — and vx asks git for its inputs, so that index must not stand in for
// the working tree.
describe('vx run inside a git pre-commit hook', () => {
  it('passes under a plain, an -a and a partial commit and keys from the working tree', async () => {
    const root = await makeWorkspace({ prefix: 'vx-hook-', git: false })
    await addProject(root, 'app', {
      config: `
        export default {
          tasks: {
            lint: {
              exec: { command: 'cat src/*.txt' },
              cache: { inputs: { files: ['src/**'] }, outputs: { files: [] } },
            },
          },
        }
      `,
      files: { 'src/a.txt': 'a1', 'src/b.txt': 'b1' },
    })
    await git(root, ['init', '-q'])
    await git(root, ['config', 'user.email', 'test@vx.local'])
    await git(root, ['config', 'user.name', 'vx test'])
    await git(root, ['add', '-A'])
    await git(root, ['commit', '-q', '-m', 'init'])
    const hook = path.join(root, '.git', 'hooks', 'pre-commit')
    await writeFile(
      hook,
      `#!/bin/sh
"$VX_HOOK_BUN" "$VX_HOOK_BIN" run lint --all --dry=json > "$VX_HOOK_OUT" || exit 1
exec "$VX_HOOK_BUN" "$VX_HOOK_BIN" run lint --all
`,
      { mode: 0o755 },
    )
    const inHook = path.join(root, '.git', 'hook-dry.json')
    const commit = (...args: string[]) =>
      Bun.spawnSync({
        cmd: ['git', '-c', 'commit.gpgsign=false', 'commit', '-q', ...args],
        cwd: root,
        stdout: 'pipe',
        stderr: 'pipe',
        env: {
          ...process.env,
          CI: '',
          VX_HOOK_BUN: process.execPath,
          VX_HOOK_BIN: BIN,
          VX_HOOK_OUT: inHook,
        },
      })
    // The truth is the key of the same bytes with the index agreeing with
    // the tree: keys are content-addressed, so every file staged.
    const settledKey = async () => {
      await git(root, ['add', '-A'])
      return (await dry(root, ['lint', '--all'])).map((t) => t.hash)
    }
    const committed = async (...args: string[]) => {
      await rm(inHook, { force: true })
      const r = commit(...args)
      expect(r.exitCode === 0 ? 0 : r.stderr.toString()).toBe(0)
      const hook = (JSON.parse(await readFile(inHook, 'utf8')) as { tasks: DryTask[] }).tasks
      expect(hook.map((t) => t.hash)).toEqual(await settledKey())
    }
    const app = path.join(root, 'packages', 'app', 'src')
    try {
      await writeFile(path.join(app, 'a.txt'), 'a2')
      await git(root, ['add', '-A'])
      await committed('-m', 'plain')

      await writeFile(path.join(app, 'a.txt'), 'a3')
      await committed('-a', '-m', 'all')

      // The partial commit's index holds a.txt's new bytes and b.txt's OLD
      // ones; the working tree has both new. A key read from that index
      // would fold b1 where the tree holds b2.
      await writeFile(path.join(app, 'a.txt'), 'a4')
      await writeFile(path.join(app, 'b.txt'), 'b2')
      await committed('-m', 'partial', 'packages/app/src/a.txt')
      expect(gitIn(root)('log', '--format=%s').trim().split('\n')).toEqual([
        'partial',
        'all',
        'plain',
        'init',
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)
})

// turborepo#8932: in a repo whose workspace is a subdirectory, `turbo watch`
// re-ran on git's own writes. The root watcher is on here (a
// `workspaceFiles` input), the widest thing vx watches.
describe('vx watch over a workspace in a git subdirectory', () => {
  it('git writing its own directory runs no cycle, and an input edit still does', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'vx-subwatch-'))
    const outside = await mkdtemp(path.join(tmpdir(), 'vx-subwatch-count-'))
    const log = path.join(outside, 'runs.log')
    try {
      const ws = await makeWorkspace({ dir: repo, prefix: 'code-', git: false })
      await mkdir(path.join(ws, 'shared'))
      await writeFile(path.join(ws, 'shared', 'base.json'), '{}')
      await addProject(ws, 'app', {
        config: `
          export default {
            tasks: {
              build: {
                exec: { command: 'cat src/in.txt > out.txt && echo run >> ${log}' },
                cache: {
                  inputs: { files: ['src/**'], workspaceFiles: ['shared/**'] },
                  outputs: { files: ['out.txt'] },
                },
              },
            },
          }
        `,
        files: { 'src/in.txt': 'v1' },
      })
      gitInitCommit(repo)
      const w = startWatch(ws)
      try {
        await until(() => w.out().includes('vx watch: watching'), 'the watching marker')
        await initialOnly(w, log)
        const g = gitIn(repo)
        for (let i = 0; i < 3; i++) {
          g('status')
          await writeFile(path.join(repo, 'NOTES.md'), `n${i}`)
          g('add', '-A')
          g('commit', '-q', '-m', `notes ${i}`)
        }
        await Bun.sleep(SETTLE_MS)
        expect(w.cycles()).toBe(0)
        expect(await executions(log)).toBe(1)

        await writeFile(path.join(ws, 'shared', 'base.json'), '{"v":2}')
        await until(async () => (await executions(log)) === 2, 'the re-run after an input edit')
      } finally {
        w.proc.kill('SIGTERM')
        await w.proc.exited
      }
    } finally {
      await rm(repo, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  }, 40_000)
})
