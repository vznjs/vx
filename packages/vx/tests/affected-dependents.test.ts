// `--affected` is a CI gate's flag: an edit to `lib` must run `app`'s tasks
// when they depend on `lib`'s, or the gate proves nothing downstream. Until
// 2026-09-16 the sugar was the changed-only `[<base>]` form (item 287); until
// 2026-10-04 it reached every task of every manifest dependent. It now follows
// task edges (owner): a change seeds the tasks whose inputs it touches (a
// task with no inputs always), and a requested
// task runs when its `dependsOn` closure holds a seeded one. This drives the
// real CLI on a git fixture with a manifest edge.
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { localWorkspaceSource } from './helpers/local-workspace.js'
import { edgesSource, pluginSource } from './helpers/plugin.js'
import { git } from './helpers/workspace.js'
import { vxSync } from './helpers/vx.js'

const TIMEOUT = 60_000

const vx = (cwd: string, ...args: string[]) => vxSync(cwd, args)

const CONFIG = `export default {
  tasks: {
    build: {
      dependsOn: ['^build'],
      exec: { command: 'mkdir -p dist && cp src/index.ts dist/out.txt' },
      inputs: { files: ['src/**', '!src/**/*.test.ts'] }, outputs: { files: ['dist/**'] }, cache: true,
    },
    test: {
      dependsOn: ['build'],
      exec: { command: 'true' },
      inputs: { files: ['src/**'] }, outputs: { files: [] }, cache: true,
    },
    lint: { exec: { command: 'true' }, inputs: { files: ['src/**'] } },
  },
}
`

let root: string
const EDGES = edgesSource({ app: ['lib'] })

/** `app` depends on `lib` through a plugin's edge; `tool` depends on nothing. */
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-affected-deps-'))
  await Bun.write(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'r', workspaces: ['pkgs/*'] }),
  )
  await Bun.write(path.join(root, '.vx/workspace.mjs'), localWorkspaceSource([EDGES]))
  await Bun.write(path.join(root, 'pkgs/lib/package.json'), JSON.stringify({ name: 'lib' }))
  await Bun.write(path.join(root, 'pkgs/app/package.json'), JSON.stringify({ name: 'app' }))
  await Bun.write(path.join(root, 'pkgs/tool/package.json'), JSON.stringify({ name: 'tool' }))
  for (const p of ['lib', 'app', 'tool']) {
    await Bun.write(path.join(root, `pkgs/${p}/src/index.ts`), 'export const x = 1')
    await Bun.write(path.join(root, `pkgs/${p}/src/index.test.ts`), 'test')
    await Bun.write(path.join(root, `pkgs/${p}/vx.config.mjs`), CONFIG)
  }
  git(root, 'init', '-q')
  git(root, 'add', '-A')
  git(root, 'commit', '-qm', 'init')
  await Bun.write(path.join(root, 'pkgs/lib/src/index.ts'), 'export const x = 2')
  git(root, 'add', '-A')
  git(root, 'commit', '-qm', 'edit lib')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** The task ids `vx run <tasks> <args> --dry --format json` plans, sorted. */
function planned(tasks: string[], ...args: string[]): string[] | string {
  const r = vx(root, 'run', ...tasks, ...args, '--dry', '--format', 'json')
  if (r.code !== 0) return r.text
  const out = r.text.slice(r.text.indexOf('{'))
  return (JSON.parse(out) as { tasks: { id: string }[] }).tasks.map((t) => t.id).sort()
}

function appBuildHash(): string {
  const r = vx(root, 'run', 'build', '--filter', 'app', '--dry', '--format', 'json')
  const out = r.text.slice(r.text.indexOf('{'))
  const tasks = (JSON.parse(out) as { tasks: { id: string; hash: string }[] }).tasks
  return tasks.find((t) => t.id === 'app#build')!.hash
}

async function commitEdit(rel: string, content: string): Promise<void> {
  await Bun.write(path.join(root, rel), content)
  git(root, 'add', '-A')
  git(root, 'commit', '-qm', `edit ${rel}`)
}

describe('--affected and the dependents of what changed', () => {
  it(
    'an edit to lib selects lib AND app, never tool',
    () => {
      const r = vx(root, 'run', 'build', '--affected=HEAD~1')
      expect(r.code).toBe(0)
      expect(r.text).toContain('lib#build')
      expect(r.text).toContain('app#build')
      expect(r.text).not.toContain('tool#build')
    },
    TIMEOUT,
  )

  it(
    'CONTROL: the plain [<base>] filter is only what changed',
    () => {
      const r = vx(root, 'run', 'build', '--filter', '[HEAD~1]')
      expect(r.code).toBe(0)
      expect(r.text).toContain('lib#build')
      expect(r.text).not.toContain('app#build')
      expect(r.text).toContain('1 in run · 3 total')
    },
    TIMEOUT,
  )
})

describe('--affected follows task edges (2026-10-04)', () => {
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
    'an edit to app keeps the unchanged upstream lib#build its ^build needs (vercel/turborepo#12516)',
    async () => {
      await commitEdit('pkgs/app/src/index.ts', 'export const x = 3')
      expect(planned(['build'], '--affected=HEAD~1')).toEqual(['app#build', 'lib#build'])
      // A cold cache: the upstream runs before app, so app finds its inputs.
      const r = vx(root, 'run', 'build', '--affected=HEAD~1')
      expect(r.code).toBe(0)
      expect(r.text).toContain('lib#build')
      expect(r.text).not.toContain('tool#build')
    },
    TIMEOUT,
  )

  it(
    'a ./-spelled input glob selects as the key reads it (vercel/turborepo#14140)',
    async () => {
      await commitEdit(
        'pkgs/lib/vx.config.mjs',
        CONFIG.replace("['src/**', '!src/**/*.test.ts']", "['./src/**', '!./src//**/*.test.ts']"),
      )
      await commitEdit('pkgs/lib/src/index.test.ts', 'test 2')
      expect(vx(root, 'run', 'build', '--affected=HEAD~1', '--dry').text).toContain(
        'Nothing affected: the change reaches no build task',
      )
      await commitEdit('pkgs/lib/src/index.ts', 'export const x = 3')
      expect(planned(['build'], '--affected=HEAD~1')).toEqual(['app#build', 'lib#build'])
    },
    TIMEOUT,
  )

  it(
    'a group task is kept when a task it depends on is affected (vercel/turborepo#13805)',
    async () => {
      await commitEdit(
        'pkgs/app/vx.config.mjs',
        CONFIG.replace('  tasks: {', "  tasks: {\n    all: { dependsOn: ['build'] },"),
      )
      await commitEdit('pkgs/lib/src/index.ts', 'export const x = 3')
      expect(planned(['all'], '--affected=HEAD~1')).toEqual(['app#all', 'app#build', 'lib#build'])
      // CONTROL: a change its closure does not reach leaves it out.
      await commitEdit('pkgs/tool/src/index.ts', 'export const x = 3')
      expect(vx(root, 'run', 'all', '--affected=HEAD~1', '--dry').code).toBe(0)
      expect(vx(root, 'run', 'all', '--affected=HEAD~1', '--dry').text).not.toContain('app#all')
    },
    TIMEOUT,
  )

  it(
    'a bare directory input selects on an edit under it (vercel/turborepo#14804)',
    async () => {
      await commitEdit(
        'pkgs/lib/vx.config.mjs',
        CONFIG.replace("['src/**', '!src/**/*.test.ts']", "['src', '!src/**/*.test.ts']"),
      )
      await commitEdit('pkgs/lib/src/index.ts', 'export const x = 3')
      expect(planned(['build'], '--affected=HEAD~1')).toEqual(['app#build', 'lib#build'])
    },
    TIMEOUT,
  )

  it(
    'a change no requested task reaches is a clean "nothing affected"',
    async () => {
      await commitEdit('pkgs/lib/src/index.test.ts', 'test 2')
      const r = vx(root, 'run', 'build', '--affected=HEAD~1')
      expect(r.code).toBe(0)
      expect(r.text).not.toContain('#build')
      expect(r.text).toContain('Nothing affected: the change reaches no build task')
      // `--dry` says the run's line, not that no affected project declares
      // a task `lib` does declare (X-141).
      const dry = vx(root, 'run', 'build', '--affected=HEAD~1', '--dry')
      expect([dry.code, dry.text.trim()]).toEqual([
        0,
        '› vx run  Nothing affected: the change reaches no build task',
      ])
    },
    TIMEOUT,
  )

  it(
    'a task named after an Object.prototype member is declared only where it is',
    async () => {
      // Only tool declares toString; lib's edit reaches lib and app, which
      // inherit `toString` from Object and must not read as declaring it.
      await Bun.write(
        path.join(root, 'pkgs/tool/vx.config.mjs'),
        `export default { tasks: { toString: { exec: { command: 'true' }, inputs: { files: ['src/**'] } } } }\n`,
      )
      git(root, 'add', '-A')
      git(root, 'commit', '-qm', 'toString')
      await commitEdit('pkgs/lib/src/index.ts', 'export const x = 3')
      const r = vx(root, 'run', 'toString', '--affected=HEAD~1')
      expect(r.code).toBe(0)
      expect(r.text).toContain('Nothing affected: the change reaches no toString task.')
    },
    TIMEOUT,
  )

  it(
    'a path no input declares reaches no task',
    async () => {
      // An undeclared file is in no key (M, 2026-11-25).
      await commitEdit('pkgs/lib/README.md', 'docs')
      expect(vx(root, 'run', 'test', '--affected=HEAD~1', '--dry').text).toContain(
        'Nothing affected: the change reaches no test task',
      )
    },
    TIMEOUT,
  )

  it(
    'a dependent with no task edge to the change is not affected',
    async () => {
      await Bun.write(
        path.join(root, 'pkgs/app/vx.config.mjs'),
        `export default { tasks: { build: { exec: { command: 'true' }, inputs: { files: ['src/**'] } } } }\n`,
      )
      git(root, 'add', '-A')
      git(root, 'commit', '-qm', 'unlink')
      await commitEdit('pkgs/lib/src/index.ts', 'export const x = 3')
      expect(planned(['build'], '--affected=HEAD~1')).toEqual(['lib#build'])
    },
    TIMEOUT,
  )

  it(
    'a package without build gets one keyed on all its files',
    async () => {
      // lib declares no build, so it gets the default: a group behind ^build
      // keyed on every file of lib (2026-10-04).
      await Bun.write(
        path.join(root, 'pkgs/lib/vx.config.mjs'),
        `export default { tasks: { test: { exec: { command: 'true' }, inputs: { files: ['src/**'] }, outputs: { files: [] }, cache: true } } }\n`,
      )
      git(root, 'add', '-A')
      git(root, 'commit', '-qm', 'no build')
      await commitEdit('pkgs/lib/src/index.test.ts', 'test 2')
      expect(planned(['test'], '--affected=HEAD~1')).toEqual([
        'app#build',
        'app#test',
        'lib#build',
        'lib#test',
      ])
      // The key follows: app#build folds lib's default build, which folds
      // every file of lib, the spec too. CONTROL: tool's edit moves nothing.
      const before = appBuildHash()
      await commitEdit('pkgs/tool/src/index.test.ts', 'test 3')
      expect(appBuildHash()).toBe(before)
      await commitEdit('pkgs/lib/src/index.test.ts', 'test 3')
      expect(appBuildHash()).not.toBe(before)
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

describe('--affected follows the graph a `graph` plugin leaves', () => {
  /** Commits a workspace whose plugin runs `body` as its `graph` hook. */
  async function graphPlugin(body: string): Promise<void> {
    await Bun.write(
      path.join(root, '.vx/workspace.mjs'),
      localWorkspaceSource([EDGES, pluginSource('org/edge', `{ graph(nodes) { ${body} } }`)]),
    )
    git(root, 'add', '-A')
    git(root, 'commit', '-qm', 'plugin')
  }

  it(
    'an edge a plugin adds reaches a task no project edge ties to the change',
    async () => {
      await graphPlugin(
        `const t = nodes.get('tool#build'); if (t && nodes.has('lib#build')) t.deps.push('lib#build')`,
      )
      await commitEdit('pkgs/lib/src/index.ts', 'export const x = 3')
      expect(planned(['build'], '--affected=HEAD~1')).toEqual([
        'app#build',
        'lib#build',
        'tool#build',
      ])
      // CONTROL: a change the edge does not reach leaves tool out.
      await commitEdit('pkgs/app/src/index.ts', 'export const x = 3')
      expect(planned(['build'], '--affected=HEAD~1')).toEqual(['app#build', 'lib#build'])
    },
    TIMEOUT,
  )

  it(
    'an input a plugin gives a task reaches it',
    async () => {
      await graphPlugin(
        `const i = nodes.get('tool#build')?.config.inputs; if (i) i.workspaceFiles = ['pkgs/lib/README.md']`,
      )
      await commitEdit('pkgs/lib/README.md', 'docs')
      expect(planned(['build'], '--affected=HEAD~1')).toEqual(['tool#build'])
    },
    TIMEOUT,
  )

  it(
    'a task a plugin marks requested runs whatever the diff',
    async () => {
      await graphPlugin(`const t = nodes.get('tool#build'); if (t) t.requested = true`)
      await commitEdit('pkgs/app/src/index.ts', 'export const x = 3')
      expect(planned(['test'], '--affected=HEAD~1')).toEqual([
        'app#build',
        'app#test',
        'lib#build',
        'tool#build',
      ])
    },
    TIMEOUT,
  )

  it(
    'an unknown ^name is refused by `vx lock`, even in a task no diff reaches',
    async () => {
      // A run judged `^nope` only for the tasks the diff kept; a run now
      // checks no rule, and the lock checks every task.
      await Bun.write(
        path.join(root, 'pkgs/tool/vx.config.mjs'),
        CONFIG.replace("dependsOn: ['^build']", "dependsOn: ['^build', '^nope']"),
      )
      await graphPlugin('')
      const lock = Bun.spawnSync({
        cmd: ['bun', path.join(import.meta.dir, '..', 'src', 'bin.ts'), 'lock'],
        cwd: root,
        stderr: 'pipe',
        env: { ...process.env, VX_LOCK_REVIEW_FILES: 'false' },
      })
      expect([lock.exitCode, lock.stderr.toString()]).toEqual([
        1,
        "✗ vx lock  lock not written\n\n  pkgs/tool/vx.config.mjs:4:7\n  tasks.build.dependsOn names ^nope but no project in the workspace declares nope\n\n    2 |   tasks: {\n    3 |     build: {\n  > 4 |       dependsOn: ['^build', '^nope'],\n      |       ^\n",
      ])
    },
    TIMEOUT,
  )
})
