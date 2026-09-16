// `--affected` with no value in the two clone shapes CI produces, end to
// end through the CLI: a single-branch clone whose `origin/HEAD` is the
// branch under test (the base is HEAD itself, so nothing is ever affected
// — an exit-0 note was the only sign), and a depth-1 checkout with no
// `origin/HEAD` and no parent (no base at all; the old error named a
// `HEAD~1` nobody typed). Found by walking the CI persona, 2026-09-16.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { writeLocalWorkspace } from './helpers/local-workspace.js'

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

function vx(cwd: string, ...args: string[]): { out: string; exitCode: number } {
  const p = Bun.spawnSync({
    cmd: ['bun', CLI, ...args],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, CI: '', GITHUB_ACTIONS: '', NO_COLOR: '1' },
  })
  return {
    out: new TextDecoder().decode(p.stdout) + new TextDecoder().decode(p.stderr),
    exitCode: p.exitCode ?? 1,
  }
}

let root: string

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-affected-base-'))
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'r', workspaces: ['pkgs/*'] }),
  )
  await writeLocalWorkspace(root)
  await mkdir(path.join(root, 'pkgs/app/src'), { recursive: true })
  await writeFile(path.join(root, 'pkgs/app/package.json'), JSON.stringify({ name: 'app' }))
  await writeFile(
    path.join(root, 'pkgs/app/vx.config.mjs'),
    `export default { tasks: { build: { exec: { command: 'cat src/a.txt > out.txt' }, cache: { inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] } } } } }\n`,
  )
  await writeFile(path.join(root, 'pkgs/app/src/a.txt'), 'a1\n')
  await writeFile(path.join(root, '.gitignore'), 'out.txt\n.vx/\n')
  git(root, 'init', '-q', '-b', 'feat')
  git(root, 'config', 'user.email', 'test@vx.local')
  git(root, 'config', 'user.name', 'vx test')
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'one')
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('--affected with no value, in the clone shapes CI produces', () => {
  it('a base that is HEAD itself is named as such, with the two bases you probably meant', () => {
    git(root, 'update-ref', 'refs/remotes/origin/feat', 'HEAD')
    git(root, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/feat')
    const r = vx(root, 'run', 'build', '--affected')
    expect(r.exitCode).toBe(0)
    expect(r.out).toContain('nothing affected since origin/feat')
    expect(r.out).toContain(
      'origin/feat is HEAD itself: compare with the branch you merge into (--affected=origin/main) or the previous commit (--affected=HEAD~1)',
    )
  })

  it('CONTROL: a real base that happens to select nothing keeps the plain note', async () => {
    await writeFile(path.join(root, 'README.md'), 'docs only\n')
    git(root, 'add', '-A')
    git(root, 'commit', '-q', '-m', 'docs')
    const r = vx(root, 'run', 'build', '--affected=HEAD~1')
    expect(r.exitCode).toBe(0)
    expect(r.out).toContain('nothing affected since HEAD~1')
    expect(r.out).not.toContain('HEAD itself')
  })

  it('no origin/HEAD and no parent commit: no base at all, said in CI terms, exit 1', () => {
    const r = vx(root, 'run', 'build', '--affected')
    expect(r.exitCode).toBe(1)
    expect(r.out).toContain('vx run: --affected has no base here')
    expect(r.out).toContain('a shallow clone? Fetch history (actions/checkout: fetch-depth: 0)')
    expect(r.out).not.toContain('did not resolve')
  })
})
