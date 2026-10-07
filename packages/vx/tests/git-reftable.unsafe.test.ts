// A repository whose refs are in reftable storage (`git init
// --ref-format=reftable`, git 2.45). Its `.git/HEAD` reads
// `ref: refs/heads/.invalid` and its refs live in `.git/reftable/`, so any
// code that reads refs from the files answers wrong or nothing. vx asks git
// for every ref but one: the run context's HEAD reader, which reads `.git`
// to save a spawn. Each row runs the same workspace twice, files and
// reftable, and asks for the same answers; the shared store's repository
// id is read from `.git` too (`repo-id.ts`), and held the same way. Unsafe: it needs the host's git
// (2.45 or later), which CI requires with VX_REQUIRE_REFTABLE.

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'bun:test'
import type { Logger, RunSummary } from '../src/orchestrator/index.js'
import { run } from '../src/orchestrator/index.js'
import { captureGitContext } from '../src/orchestrator/run-context.js'
import { repoIdOf } from '../src/workspace/repo-id.js'
import { addProject, gitIn, makeWorkspace } from './helpers/workspace.js'

const TIMEOUT = 60_000
const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')

function gitVersion(): [number, number] | null {
  const p = Bun.spawnSync(['git', '--version'], { stdout: 'pipe', stderr: 'ignore' })
  const m = /(\d+)\.(\d+)/.exec(p.stdout.toString())
  return m === null ? null : [Number(m[1]), Number(m[2])]
}
const version = gitVersion()
const reftable = version !== null && (version[0] > 2 || (version[0] === 2 && version[1] >= 45))

it('the host git can make a reftable repository where VX_REQUIRE_REFTABLE asks', () => {
  // A skip is a silent pass: CI sets the variable, so a git too old to
  // run the rows below fails there instead of skipping them.
  if (process.env['VX_REQUIRE_REFTABLE'] === '1')
    expect({ git: version, reftable }).toEqual({ git: version, reftable: true })
})

const logger: Logger = {
  status: () => {},
  taskStdout: () => {},
  taskStderr: () => {},
  taskComplete: () => {},
}

const CONFIG = `export default {
  tasks: {
    build: {
      exec: { command: 'mkdir -p dist && cat src/x.txt > dist/out.txt' },
      cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] } },
    },
  },
}`

const roots: string[] = []
afterEach(async () => {
  for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true })
})

/** Two projects committed in one repository, refs in `format`; returns the root. */
async function workspace(format: 'files' | 'reftable'): Promise<string> {
  const root = await makeWorkspace({ prefix: `vx-reftable-${format}-`, git: false })
  roots.push(root)
  await writeFile(path.join(root, '.gitignore'), '.vx/\ndist/\n')
  for (const name of ['a', 'b']) {
    await addProject(root, name, { config: CONFIG, files: { 'src/x.txt': name } })
  }
  const git = gitIn(root)
  git('init', '-q', `--ref-format=${format}`, '-b', 'main')
  git('config', 'user.email', 'test@vx.local')
  git('config', 'user.name', 'vx test')
  git('add', '-A')
  // One date, so both formats make the same commit.
  git('-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'init', '--date=2026-01-01T00:00:00Z')
  return root
}

async function build(root: string): Promise<Map<string, string>> {
  const r: RunSummary = await run({ cwd: root, tasks: ['build'], log: logger })
  expect(r.ok).toBe(true)
  return new Map(r.outcomes.map((o) => [o.node.id, o.hash ?? '']))
}

describe.skipIf(!reftable)('a reftable repository', () => {
  it(
    'reports HEAD as git does, attached and detached, and never from the files',
    async () => {
      const root = await workspace('reftable')
      const git = gitIn(root)
      expect(await readFile(path.join(root, '.git', 'HEAD'), 'utf8')).toBe(
        'ref: refs/heads/.invalid\n',
      )
      const sha = git('rev-parse', 'HEAD').trim()
      expect(captureGitContext(root)).toEqual({ commitSha: sha, branch: 'main', dirty: null })
      // A `packed-refs` left by a hand migration names the branch HEAD
      // seems to point at: read as the answer, it put another commit on
      // the run.
      await writeFile(
        path.join(root, '.git', 'packed-refs'),
        `${'1'.repeat(40)} refs/heads/.invalid\n`,
      )
      expect(captureGitContext(root).commitSha).toBe(sha)
      git('checkout', '-q', '--detach')
      expect(captureGitContext(root)).toEqual({ commitSha: sha, branch: null, dirty: null })
    },
    TIMEOUT,
  )

  it(
    'keys every task as the files repository does, and hits on the second run',
    async () => {
      const files = await build(await workspace('files'))
      const root = await workspace('reftable')
      const keys = await build(root)
      expect(Object.fromEntries(keys)).toEqual(Object.fromEntries(files))
      const r = await run({ cwd: root, tasks: ['build'], log: logger })
      expect(r.outcomes.map((o) => o.status)).toEqual(['cache-hit', 'cache-hit'])
    },
    TIMEOUT,
  )

  it(
    'selects --affected from the reftable history',
    async () => {
      const root = await workspace('reftable')
      const git = gitIn(root)
      await writeFile(path.join(root, 'packages', 'a', 'src', 'x.txt'), 'a2')
      git('commit', '-qam', 'edit a')
      const p = Bun.spawnSync(
        [process.execPath, BIN, 'run', 'build', '--affected=HEAD~1', '--dry-run'],
        {
          cwd: root,
          stdout: 'pipe',
          stderr: 'pipe',
          env: { ...process.env, NO_COLOR: '1', CI: '' },
        },
      )
      const out = p.stdout.toString() + p.stderr.toString()
      expect(p.exitCode).toBe(0)
      expect(out).toContain('a#build')
      expect(out).not.toContain('b#build')
    },
    TIMEOUT,
  )

  it(
    'names the shared store as the files repository does, and none when shallow',
    async () => {
      const files = await workspace('files')
      const id = await repoIdOf(files)
      const clone = path.join(os.tmpdir(), `vx-reftable-clone-${process.pid}-${Date.now()}`)
      const shallow = `${clone}-shallow`
      roots.push(clone, shallow)
      const git = gitIn(os.tmpdir())
      git('clone', '-q', '--ref-format=reftable', files, clone)
      git('clone', '-q', '--ref-format=reftable', '--depth=1', `file://${files}`, shallow)
      for (const dir of [clone, shallow]) gitIn(dir)('remote', 'remove', 'origin')
      expect(await readFile(path.join(clone, '.git', 'HEAD'), 'utf8')).toBe(
        'ref: refs/heads/.invalid\n',
      )
      expect([id, await repoIdOf(clone), await repoIdOf(shallow)]).toEqual([
        expect.stringMatching(/^[0-9a-f]{16}$/),
        id,
        null,
      ])
    },
    TIMEOUT,
  )

  it(
    'works in a linked worktree of a reftable repository',
    async () => {
      const root = await workspace('reftable')
      const git = gitIn(root)
      const wt = path.join(os.tmpdir(), `vx-reftable-wt-${process.pid}-${Date.now()}`)
      roots.push(wt)
      git('worktree', 'add', '-q', wt, '-b', 'side')
      const sha = gitIn(wt)('rev-parse', 'HEAD').trim()
      expect(captureGitContext(wt)).toEqual({ commitSha: sha, branch: 'side', dirty: null })
      const keys = await build(wt)
      expect([...keys.values()].every((k) => /^[0-9a-f]{16}$/.test(k))).toBe(true)
      await mkdir(path.join(wt, 'packages', 'a', 'src'), { recursive: true })
      await writeFile(path.join(wt, 'packages', 'a', 'src', 'x.txt'), 'a3')
      const moved = await build(wt)
      expect(moved.get('a#build')).not.toBe(keys.get('a#build'))
      expect(moved.get('b#build')).toBe(keys.get('b#build'))
    },
    TIMEOUT,
  )
})
