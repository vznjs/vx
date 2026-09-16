// `--affected` is a CI gate's flag: an edit to `lib` must run `app`'s tasks
// when `app` depends on `lib`, or the gate proves nothing downstream. The
// sugar was the changed-only `[<base>]` form until 2026-09-16 (item 287),
// while the CI and running-tasks guides promised dependents — a silent hole
// in every adopter's gate. This drives the real CLI on a git fixture with a
// manifest edge and pins both forms: the sugar reaches the dependent, the
// plain `[<base>]` filter stays "only what I touched".
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

const CONFIG = [
  'export default {',
  '  tasks: {',
  '    build: {',
  '      exec: { command: "mkdir -p dist && cp src/index.ts dist/out.txt" },',
  '      cache: { inputs: { files: ["src/**"] }, outputs: { files: ["dist/**"] } },',
  '    },',
  '  },',
  '}',
  '',
].join('\n')

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

describe('--affected and the dependents of what changed', () => {
  it(
    'an edit to lib selects lib AND app, never tool',
    () => {
      const r = vx(root, 'run', 'build', '--affected=HEAD~1')
      expect(r.exitCode).toBe(0)
      expect(r.stdout).toContain('lib#build')
      expect(r.stdout).toContain('app#build')
      expect(r.stdout).not.toContain('tool#build')
      expect(r.stdout).toContain('2 affected · 3 total')
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
      expect(r.stdout).toContain('1 affected · 3 total')
    },
    TIMEOUT,
  )
})
