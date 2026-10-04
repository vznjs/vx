// `--affected` is a CI gate's flag: an edit to `lib` must run `app`'s tasks
// when they depend on `lib`'s, or the gate proves nothing downstream. Until
// 2026-09-16 the sugar was the changed-only `[<base>]` form (item 287); until
// 2026-10-04 it reached every task of every manifest dependent. It now follows
// task edges (owner): a change seeds the tasks whose inputs it touches (every
// task of the project when no cached task declares the path), and a requested
// task runs when its `dependsOn` closure holds a seeded one. This drives the
// real CLI on a git fixture with a manifest edge.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { writeLocalWorkspace } from './helpers/local-workspace.js'

const TIMEOUT = 60_000
const CLI = path.join(import.meta.dir, '..', 'src', 'bin.ts')

function git(cwd: string, ...args: string[]): void {
  const p = Bun.spawnSync({
    cmd: ['git', '-c', 'commit.gpgsign=false', ...args],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (p.exitCode !== 0) {
    throw new Error(
      `git ${args.join(' ')} exited ${p.exitCode}: ${new TextDecoder().decode(p.stderr).trim()}`,
    )
  }
}

async function write(p: string, content: string): Promise<void> {
  await mkdir(path.dirname(p), { recursive: true })
  await writeFile(p, content)
}

function vx(cwd: string, ...args: string[]): { stdout: string; exitCode: number } {
  const p = Bun.spawnSync({
    cmd: ['bun', CLI, ...args],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, CI: '', GITHUB_ACTIONS: '', NO_COLOR: '1' },
  })
  return {
    stdout: new TextDecoder().decode(p.stdout) + new TextDecoder().decode(p.stderr),
    exitCode: p.exitCode ?? 1,
  }
}

const CONFIG = `export default {
  tasks: {
    build: {
      dependsOn: ['^build'],
      exec: { command: 'mkdir -p dist && cp src/index.ts dist/out.txt' },
      cache: { inputs: { files: ['src/**', '!src/**/*.test.ts'] }, outputs: { files: ['dist/**'] } },
    },
    test: {
      dependsOn: ['build'],
      exec: { command: 'true' },
      cache: { inputs: { files: ['src/**'] }, outputs: { files: [] } },
    },
    lint: { exec: { command: 'true' } },
  },
}
`

let root: string

/** `app` depends on `lib` through its manifest; `tool` depends on nothing. */
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-affected-deps-'))
  await write(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'r', workspaces: ['pkgs/*'] }),
  )
  await writeLocalWorkspace(root)
  await write(path.join(root, 'pkgs/lib/package.json'), JSON.stringify({ name: 'lib' }))
  await write(
    path.join(root, 'pkgs/app/package.json'),
    JSON.stringify({ name: 'app', dependencies: { lib: 'workspace:*' } }),
  )
  await write(path.join(root, 'pkgs/tool/package.json'), JSON.stringify({ name: 'tool' }))
  for (const p of ['lib', 'app', 'tool']) {
    await write(path.join(root, `pkgs/${p}/src/index.ts`), 'export const x = 1')
    await write(path.join(root, `pkgs/${p}/src/index.test.ts`), 'test')
    await write(path.join(root, `pkgs/${p}/vx.config.mjs`), CONFIG)
  }
  git(root, 'init', '-q')
  git(root, 'add', '-A')
  git(root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init')
  await write(path.join(root, 'pkgs/lib/src/index.ts'), 'export const x = 2')
  git(root, 'add', '-A')
  git(root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'edit lib')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** The task ids `vx run <tasks> <args> --dry=json` plans, sorted. */
function planned(tasks: string[], ...args: string[]): string[] | string {
  const r = vx(root, 'run', ...tasks, ...args, '--dry=json')
  if (r.exitCode !== 0) return r.stdout
  const out = r.stdout.slice(r.stdout.indexOf('{'))
  return (JSON.parse(out) as { tasks: { id: string }[] }).tasks.map((t) => t.id).sort()
}

async function commitEdit(rel: string, content: string): Promise<void> {
  await write(path.join(root, rel), content)
  git(root, 'add', '-A')
  git(root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', `edit ${rel}`)
}

describe('--affected and the dependents of what changed', () => {
  it(
    'an edit to lib selects lib AND app, never tool',
    () => {
      const r = vx(root, 'run', 'build', '--affected=HEAD~1')
      expect(r.exitCode).toBe(0)
      expect(r.stdout).toContain('lib#build')
      expect(r.stdout).toContain('app#build')
      expect(r.stdout).not.toContain('tool#build')
    },
    TIMEOUT,
  )

  it(
    'CONTROL: the plain [<base>] filter is only what changed',
    () => {
      const r = vx(root, 'run', 'build', '--filter', '[HEAD~1]')
      expect(r.exitCode).toBe(0)
      expect(r.stdout).toContain('lib#build')
      expect(r.stdout).not.toContain('app#build')
      expect(r.stdout).toContain('1 in run · 3 total')
    },
    TIMEOUT,
  )
})

describe('--affected follows task edges (owner, 2026-10-04)', () => {
  it(
    "a source edit reaches the dependent's tasks behind ^build, not its lint",
    () => {
      expect(planned(['build', 'test', 'lint'], '--affected=HEAD~1')).toEqual([
        'app#build',
        'app#test',
        'lib#build',
        'lib#lint',
        'lib#test',
      ])
    },
    TIMEOUT,
  )

  it(
    "an edit outside build's inputs runs only the tasks that read it",
    async () => {
      await commitEdit('pkgs/lib/src/index.test.ts', 'test 2')
      // lib#test reads the spec; lib#build leaves it out, so nothing in app
      // is reached. lib#lint is uncached: its project changed, so it runs.
      expect(planned(['build', 'test', 'lint'], '--affected=HEAD~1')).toEqual([
        'lib#build',
        'lib#lint',
        'lib#test',
      ])
      // CONTROL: the project walk still takes every dependent.
      expect(planned(['test'], '--filter', '...[HEAD~1]')).toEqual([
        'app#build',
        'app#test',
        'lib#build',
        'lib#test',
      ])
    },
    TIMEOUT,
  )

  it(
    'a change no requested task reaches is a clean "nothing affected"',
    async () => {
      await commitEdit('pkgs/lib/src/index.test.ts', 'test 2')
      const r = vx(root, 'run', 'build', '--affected=HEAD~1')
      expect(r.exitCode).toBe(0)
      expect(r.stdout).not.toContain('#build')
      expect(r.stdout).toContain('Nothing affected: the change reaches no build task.')
    },
    TIMEOUT,
  )

  it(
    'a path no cached task declares reaches its whole project',
    async () => {
      // vx cannot prove an undeclared file re-keys nothing (a plugin may read
      // it), so it reaches lib#build and, through ^build, app.
      await commitEdit('pkgs/lib/README.md', 'docs')
      expect(planned(['test'], '--affected=HEAD~1')).toEqual([
        'app#build',
        'app#test',
        'lib#build',
        'lib#test',
      ])
    },
    TIMEOUT,
  )

  it(
    'a dependent with no task edge to the change is not affected',
    async () => {
      await write(
        path.join(root, 'pkgs/app/vx.config.mjs'),
        `export default { tasks: { build: { exec: { command: 'true' } } } }\n`,
      )
      git(root, 'add', '-A')
      git(root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'unlink')
      await commitEdit('pkgs/lib/src/index.ts', 'export const x = 3')
      expect(planned(['build'], '--affected=HEAD~1')).toEqual(['lib#build'])
    },
    TIMEOUT,
  )

  it(
    'a pkg#task the user names runs whatever the diff',
    async () => {
      await commitEdit('pkgs/lib/src/index.test.ts', 'test 2')
      expect(planned(['test', 'tool#lint'], '--affected=HEAD~1')).toEqual([
        'lib#build',
        'lib#test',
        'tool#lint',
      ])
    },
    TIMEOUT,
  )
})
