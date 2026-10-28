// A `git` vx runs got vx's whole env, and is readable after its `exec`
// like any child, so a same-user task could read a token vx never passed
// it there (`vx watch` runs git while its tasks run). It now gets what git
// reads and nothing else (`gitEnv`, util/hide-env.ts).
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, expect, it } from 'bun:test'
import { localWorkspaceSource } from './helpers/local-workspace.js'

const BIN = path.resolve(import.meta.dir, 'helpers', 'vx-locked.ts')
let root: string | undefined

afterAll(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
})

it('every git vx runs sees the git and locale variables, not the rest', async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-git-env-'))
  const real = Bun.which('git')!
  const shim = path.join(root, 'bin')
  const seen = path.join(root, 'seen')
  await mkdir(shim)
  await mkdir(seen)
  await writeFile(
    path.join(shim, 'git'),
    // One file per git run: runs overlap.
    `#!/bin/sh\nenv | grep -E '^(VX_TEST_CANARY|GIT_CONFIG_NOSYSTEM|HOME)=' | sed 's/=.*//' > "$(mktemp ${JSON.stringify(seen)}/XXXXXX)"\nexec ${JSON.stringify(real)} "$@"\n`,
  )
  await chmod(path.join(shim, 'git'), 0o755)
  const ws = path.join(root, 'ws')
  await mkdir(path.join(ws, 'packages', 'a'), { recursive: true })
  await writeFile(
    path.join(ws, 'package.json'),
    JSON.stringify({ name: 'r', private: true, workspaces: ['packages/*'] }),
  )
  await Bun.write(path.join(ws, '.vx/workspace.mjs'), localWorkspaceSource())
  await writeFile(path.join(ws, 'packages', 'a', 'package.json'), JSON.stringify({ name: 'a' }))
  await writeFile(
    path.join(ws, 'packages', 'a', 'vx.config.mjs'),
    `export default { tasks: { build: { exec: { command: 'true' }, inputs: { files: ['package.json'] }, cache: { outputs: { files: [] } } } } }\n`,
  )
  expect(Bun.spawnSync({ cmd: [real, 'init', '-q'], cwd: ws }).exitCode).toBe(0)
  const r = Bun.spawnSync({
    cmd: [process.execPath, BIN, 'run', 'a#build'],
    cwd: ws,
    env: {
      ...process.env,
      PATH: `${shim}${path.delimiter}${process.env['PATH']}`,
      VX_TEST_CANARY: 'secret',
      GIT_CONFIG_NOSYSTEM: '1',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  expect(r.exitCode, r.stderr.toString()).toBe(0)
  const runs = await Promise.all(
    (await readdir(seen)).map(async (f) =>
      (await readFile(path.join(seen, f), 'utf8')).trim().split('\n').sort().join(' '),
    ),
  )
  expect(runs.length).toBeGreaterThan(0)
  expect([...new Set(runs)]).toEqual(['GIT_CONFIG_NOSYSTEM HOME'])
})

// A linked worktree's pre-commit hook exports GIT_DIR (its gitdir) and no
// GIT_WORK_TREE, and git then takes ITS cwd as the work tree's top. vx runs
// git in the workspace root, here a subfolder: every file read as untracked,
// `--affected` selected every project and the keys moved. A plain `git` in
// the workspace finds the worktree's top; vx's must too.
it('a hook-exported GIT_DIR finds the top-level a plain git does', async () => {
  const top = await mkdtemp(path.join(os.tmpdir(), 'vx-git-dir-'))
  const git = (cwd: string, ...args: string[]): string => {
    const r = Bun.spawnSync({
      cmd: [
        'git',
        '-c',
        'user.email=t@t',
        '-c',
        'user.name=t',
        '-c',
        'commit.gpgsign=false',
        ...args,
      ],
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`)
    return r.stdout.toString().trim()
  }
  const vx = (cwd: string, args: string[], env: Record<string, string> = {}): string => {
    const r = Bun.spawnSync({
      cmd: [process.execPath, BIN, ...args],
      cwd,
      env: { ...process.env, CI: '', GITHUB_ACTIONS: '', ...env },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(r.exitCode, r.stderr.toString()).toBe(0)
    return r.stdout.toString()
  }
  try {
    const repo = path.join(top, 'repo')
    const ws = path.join(repo, 'code')
    for (const name of ['a', 'b']) {
      const dir = path.join(ws, 'packages', name)
      await mkdir(path.join(dir, 'src'), { recursive: true })
      await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name }))
      await writeFile(path.join(dir, 'src', 'in.txt'), name)
      await writeFile(
        path.join(dir, 'vx.config.mjs'),
        `export default { tasks: { build: { exec: { command: 'true' }, inputs: { files: ['src/**'] }, cache: { outputs: { files: [] } } } } }\n`,
      )
    }
    await writeFile(
      path.join(ws, 'package.json'),
      JSON.stringify({ name: 'r', private: true, workspaces: ['packages/*'] }),
    )
    await Bun.write(path.join(ws, '.vx/workspace.mjs'), localWorkspaceSource())
    git(repo, 'init', '-q')
    vx(ws, ['lock'])
    git(repo, 'add', '-A')
    git(repo, 'commit', '-q', '-m', 'init')
    const linked = path.join(top, 'linked')
    git(repo, 'worktree', 'add', '-q', linked)
    const code = path.join(linked, 'code')
    await writeFile(path.join(code, 'packages', 'a', 'src', 'in.txt'), 'a2')
    const plan = (select: string, env: Record<string, string>): string[] =>
      (
        JSON.parse(vx(code, ['run', 'build', select, '--dry=json'], env)) as {
          tasks: { id: string; hash: string; cacheStatus: string }[]
        }
      ).tasks.map((t) => `${t.id} ${t.hash} ${t.cacheStatus}`)
    const hook = { GIT_DIR: git(linked, 'rev-parse', '--absolute-git-dir') }
    const plain = plan('--affected=HEAD', {})
    expect(plain.map((t) => t.split(' ')[0])).toEqual(['a#build'])
    expect(plan('--affected=HEAD', hook)).toEqual(plain)
    expect(plan('--all', hook)).toEqual(plan('--all', {}))
  } finally {
    await rm(top, { recursive: true, force: true })
  }
}, 30_000)
