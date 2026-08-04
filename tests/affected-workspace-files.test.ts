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
})
