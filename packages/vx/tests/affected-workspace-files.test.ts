// `--affected` must see every change that moves a cache key.
//
// `docs/cli.md` states the rule as a principle: "input hashing sees it, so
// `--affected` must too." A workspace-root-anchored `cache.inputs.workspaceFiles`
// glob is the documented escape hatch for shared files that belong to NO
// project — so a change to one of those files re-keys the declaring task while
// `projectsContaining` maps the path to no project at all.
//
// The failure is the silent kind this repo keeps meeting: `vx run test
// --affected` exits 0 having run nothing, on a change that invalidated the
// task's cache. Same shape as the root-lockfile gap fixed 2026-07-30, one
// level further out.
//
// Every case drives the REAL CLI against a real git-backed fixture — the pair
// that proves the defect is "the key moved" AND "affected selected nothing",
// because either half alone is consistent with correct behaviour.

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

interface RunResult {
  stdout: string
  exitCode: number
}

function vx(cwd: string, ...args: string[]): RunResult {
  const p = Bun.spawnSync({
    cmd: ['bun', CLI, ...args],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    // Pin the output flow: the default depends on CI/GITHUB_ACTIONS, which
    // makes an assertion on stdout behave differently on a runner.
    env: { ...process.env, CI: '', GITHUB_ACTIONS: '', NO_COLOR: '1' },
  })
  return {
    stdout: new TextDecoder().decode(p.stdout) + new TextDecoder().decode(p.stderr),
    exitCode: p.exitCode ?? 1,
  }
}

let root: string

/**
 * A workspace with ONE project whose `build` declares a workspace-anchored
 * input glob reaching a shared dir that belongs to no project.
 */
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-affected-wsf-'))
  await write(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'r', workspaces: ['pkgs/*'] }),
  )
  await writeLocalWorkspace(root)
  await write(path.join(root, 'shared/schema.txt'), 'v1')
  await write(path.join(root, 'pkgs/app/package.json'), JSON.stringify({ name: 'app' }))
  await write(path.join(root, 'pkgs/app/src/index.ts'), 'export const x = 1')
  await write(
    path.join(root, 'pkgs/app/vx.config.mjs'),
    [
      'export default {',
      '  tasks: {',
      '    build: {',
      '      exec: { command: "mkdir -p dist && echo built > dist/out.txt" },',
      '      cache: {',
      '        inputs: { files: ["src/**"], workspaceFiles: ["shared/**"] },',
      '        outputs: { files: ["dist/**"] },',
      '      },',
      '    },',
      '  },',
      '}',
      '',
    ].join('\n'),
  )
  git(root, 'init', '-q')
  git(root, 'config', 'user.email', 't@vx.local')
  git(root, 'config', 'user.name', 'vx')
  git(root, 'add', '-A')
  git(root, 'commit', '-qm', 'initial')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('--affected sees a workspaceFiles change', () => {
  it(
    'the change re-keys the task AND selects it',
    async () => {
      // Warm the cache at v1.
      expect(vx(root, 'run', 'build', '--all').exitCode).toBe(0)
      expect(vx(root, 'run', 'build', '--all').stdout).toContain('up-to-date')

      // Change the SHARED file — inside no project, but folded into app#build's
      // key by its `workspaceFiles` glob.
      await write(path.join(root, 'shared/schema.txt'), 'v2')
      git(root, 'add', '-A')
      git(root, 'commit', '-qm', 'bump shared schema')

      // Half one: the key really did move. Without this, "affected selected
      // nothing" would be the CORRECT answer and the test would prove nothing.
      const unscoped = vx(root, 'run', 'build', '--all')
      expect(unscoped.exitCode).toBe(0)
      expect(unscoped.stdout).not.toContain('up-to-date')

      // Half two: --affected must select it. Re-warm first so a miss here can
      // only come from selection, not from the key still being cold.
      expect(vx(root, 'run', 'build', '--all').stdout).toContain('up-to-date')
      await write(path.join(root, 'shared/schema.txt'), 'v3')
      git(root, 'add', '-A')
      git(root, 'commit', '-qm', 'bump again')

      const scoped = vx(root, 'run', 'build', '--affected=HEAD~1')
      expect(scoped.exitCode).toBe(0)
      expect(scoped.stdout).toContain('app#build')
    },
    TIMEOUT,
  )

  it(
    'a glob naming a file inside ANOTHER project selects its declarer (item 954)',
    async () => {
      // `schema.md` allows it; the path is app's, so selection never asked
      // who else reads it, and a bare `[ref]` filter ran app alone.
      await write(path.join(root, 'pkgs/app/data.json'), '{"v":1}')
      await write(path.join(root, 'pkgs/tool/package.json'), JSON.stringify({ name: 'tool' }))
      await write(
        path.join(root, 'pkgs/tool/vx.config.mjs'),
        [
          'export default {',
          '  tasks: {',
          '    build: {',
          '      exec: { command: "true" },',
          '      cache: { inputs: { files: [], workspaceFiles: ["pkgs/app/data.json"] }, outputs: { files: [] } },',
          '    },',
          '  },',
          '}',
          '',
        ].join('\n'),
      )
      git(root, 'add', '-A')
      git(root, 'commit', '-qm', 'tool reads app data')
      await write(path.join(root, 'pkgs/app/data.json'), '{"v":2}')
      git(root, 'add', '-A')
      git(root, 'commit', '-qm', 'bump data')

      const scoped = vx(root, 'run', 'build', '--filter', '[HEAD~1]', '--dry')
      expect(scoped.exitCode).toBe(0)
      expect(scoped.stdout).toContain('app#build')
      expect(scoped.stdout).toContain('tool#build')
    },
    TIMEOUT,
  )

  it(
    'a shared file NO glob reaches still selects nothing',
    async () => {
      // The control. Widening must be driven by a glob that actually matches,
      // not by "the path belongs to no project" — otherwise every README edit
      // rebuilds the workspace.
      await write(path.join(root, 'docs/notes.md'), 'hello')
      git(root, 'add', '-A')
      git(root, 'commit', '-qm', 'add unrelated doc')

      const scoped = vx(root, 'run', 'build', '--affected=HEAD~1')
      expect(scoped.exitCode).toBe(0)
      expect(scoped.stdout).not.toContain('app#build')
    },
    TIMEOUT,
  )

  it(
    'an ordinary in-project change still selects, and costs no extra work',
    async () => {
      // The other control: the common path must be untouched by whatever
      // machinery the widening needs.
      await write(path.join(root, 'pkgs/app/src/index.ts'), 'export const x = 2')
      git(root, 'add', '-A')
      git(root, 'commit', '-qm', 'edit app source')

      const scoped = vx(root, 'run', 'build', '--affected=HEAD~1')
      expect(scoped.exitCode).toBe(0)
      expect(scoped.stdout).toContain('app#build')
    },
    TIMEOUT,
  )

  it(
    "a root file one task reads does not seed its project's uncached task (X-40)",
    async () => {
      // `shared/**` re-keys app#build alone, but the owner went into the
      // changed-project set, and every uncached task there was seeded:
      // app#lint, which reads nothing of `shared/`, ran.
      await write(
        path.join(root, 'pkgs/app/vx.config.mjs'),
        [
          'export default {',
          '  tasks: {',
          '    build: {',
          '      exec: { command: "true" },',
          '      cache: { inputs: { files: ["src/**"], workspaceFiles: ["shared/**"] }, outputs: { files: [] } },',
          '    },',
          '    lint: { exec: { command: "true" } },',
          '  },',
          '}',
          '',
        ].join('\n'),
      )
      git(root, 'add', '-A')
      git(root, 'commit', '-qm', 'app lints')
      const planned = (): string[] | string => {
        const r = vx(root, 'run', 'build', 'lint', '--affected=HEAD~1', '--dry=json')
        if (r.exitCode !== 0) return r.stdout
        const out = r.stdout.slice(r.stdout.indexOf('{'))
        return (JSON.parse(out) as { tasks: { id: string }[] }).tasks.map((t) => t.id).sort()
      }

      await write(path.join(root, 'shared/schema.txt'), 'v2')
      git(root, 'add', '-A')
      git(root, 'commit', '-qm', 'bump shared schema')
      expect(planned()).toEqual(['app#build'])

      // CONTROL: a change inside the project still seeds the uncached task.
      await write(path.join(root, 'pkgs/app/src/index.ts'), 'export const x = 2')
      git(root, 'add', '-A')
      git(root, 'commit', '-qm', 'edit app source')
      expect(planned()).toEqual(['app#build', 'app#lint'])
    },
    TIMEOUT,
  )

  it(
    'a glob reaching into a changed nested repository selects its declarer',
    async () => {
      // git reports a submodule or an embedded repository as ONE path
      // (`vendor/sub`, `vendor/new/`), while the key folds the files inside;
      // matched as a file, `vendor/sub/**` missed it and the run said
      // "nothing affected" over a stale key.
      const sub = path.join(root, 'vendor/sub')
      await write(path.join(sub, 'f.txt'), '1')
      git(sub, 'init', '-q')
      git(sub, 'config', 'user.email', 't@vx.local')
      git(sub, 'config', 'user.name', 'vx')
      git(sub, 'add', '-A')
      git(sub, 'commit', '-qm', 'sub')
      for (const [name, glob] of [
        ['tool', 'vendor/sub/**'],
        ['gen', 'vendor/*/f.txt'],
        ['fresh', 'vendor/new/**'],
      ] as const) {
        await write(path.join(root, `pkgs/${name}/package.json`), JSON.stringify({ name }))
        await write(
          path.join(root, `pkgs/${name}/vx.config.mjs`),
          `export default { tasks: { build: { exec: { command: "true" }, cache: { inputs: { files: [], workspaceFiles: [${JSON.stringify(glob)}] }, outputs: { files: [] } } } } }\n`,
        )
      }
      // `git add` of an embedded repository records a gitlink, as a submodule's.
      git(root, 'add', '-A')
      git(root, 'commit', '-qm', 'readers of vendor')
      const planned = (): string[] | string => {
        const r = vx(root, 'run', 'build', '--affected=HEAD', '--dry=json')
        if (r.exitCode !== 0 || !r.stdout.includes('{')) return r.stdout
        const out = r.stdout.slice(r.stdout.indexOf('{'))
        return (JSON.parse(out) as { tasks: { id: string }[] }).tasks.map((t) => t.id).sort()
      }
      expect(planned()).toContain('nothing affected')
      await write(path.join(sub, 'f.txt'), '2')
      expect(planned()).toEqual(['gen#build', 'tool#build'])
      await write(path.join(sub, 'f.txt'), '1')
      const fresh = path.join(root, 'vendor/new')
      await write(path.join(fresh, 'x.txt'), 'x')
      git(fresh, 'init', '-q')
      // `vendor/*/f.txt` may descend into any repository under `vendor`.
      expect(planned()).toEqual(['fresh#build', 'gen#build'])
    },
    TIMEOUT,
  )
})
