// A bare task name under a diff-derived scope (`--affected`, `[ref]`),
// end to end through the CLI: which projects are in scope depends on what
// changed, so a name only unchanged projects declare is not a typo.
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

// `app` declares `test`, `docs` declares `lint` only; `docs` is what changed.
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-affected-sparse-'))
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'r', workspaces: ['pkgs/*'] }),
  )
  await writeLocalWorkspace(root)
  for (const [name, tasks] of [
    ['app', "test: { exec: { command: 'echo app-test' } }"],
    ['docs', "lint: { exec: { command: 'echo docs-lint' } }"],
  ] as const) {
    await mkdir(path.join(root, 'pkgs', name), { recursive: true })
    await writeFile(path.join(root, 'pkgs', name, 'package.json'), JSON.stringify({ name }))
    await writeFile(
      path.join(root, 'pkgs', name, 'vx.config.mjs'),
      `export default { tasks: { ${tasks} } }\n`,
    )
    await writeFile(path.join(root, 'pkgs', name, 'in.txt'), 'x\n')
  }
  await writeFile(path.join(root, '.gitignore'), '.vx/\n')
  git(root, 'init', '-q', '-b', 'feat')
  git(root, 'config', 'user.email', 'test@vx.local')
  git(root, 'config', 'user.name', 'vx test')
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'one')
  await writeFile(path.join(root, 'pkgs', 'docs', 'in.txt'), 'y\n')
  git(root, 'commit', '-qam', 'docs only')
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

// Item 1024: the typo guard judged a bare name against the scope, and under
// `--affected` the scope is whatever changed. A docs-only commit turned
// `vx run test --affected` red: "No projects declare task(s): test".
describe('--affected: a task only unchanged projects declare is not a typo', () => {
  it('a run with nothing affected declaring the task exits 0, and says so', () => {
    const run = vx(root, 'run', 'test', '--affected=HEAD~1')
    const dry = vx(root, 'run', 'test', '--affected=HEAD~1', '--dry')
    const filter = vx(root, 'run', 'test', '--filter', '[HEAD~1]')
    expect({
      run: [run.exitCode, run.out.includes('No affected project declares task(s): test.')],
      dry: [dry.exitCode, dry.out.includes('no affected project declares task(s): test.')],
      filter: filter.exitCode,
    }).toEqual({ run: [0, true], dry: [0, true], filter: 0 })
  })

  it('the names an affected project declares run; the others do not stop them', () => {
    const r = vx(root, 'run', 'lint', 'test', '--affected=HEAD~1')
    expect([r.exitCode, r.out.includes('docs#lint'), r.out.includes('app#test')]).toEqual([
      0,
      true,
      false,
    ])
  })

  it('a name no project declares is still refused (control)', () => {
    const r = vx(root, 'run', 'tset', '--affected=HEAD~1')
    expect([r.exitCode, r.out.includes('vx run: no projects declare task(s): tset.')]).toEqual([
      1,
      true,
    ])
  })

  it('a scope the user named is judged as before (control)', () => {
    const r = vx(root, 'run', 'test', '--filter', 'docs')
    expect([r.exitCode, r.out.includes('vx run: no projects declare task(s): test.')]).toEqual([
      1,
      true,
    ])
  })
})

// C-3: the guard judged a bare name against the whole workspace only when
// the load was partial. `docs` depending on `app` loaded `app` for the
// closure, so the load was whole and the check was skipped: `app` declared
// `test` all along, and the run still said "No projects declare task(s)".
describe('--affected: a task only an unaffected dependency declares is not a typo', () => {
  it('exits 0 and says no affected project declares it', async () => {
    await writeFile(
      path.join(root, 'pkgs', 'docs', 'package.json'),
      JSON.stringify({ name: 'docs', dependencies: { app: 'workspace:*' } }),
    )
    git(root, 'commit', '-qam', 'docs depends on app')
    await writeFile(path.join(root, 'pkgs', 'docs', 'in.txt'), 'z\n')
    git(root, 'commit', '-qam', 'docs only')
    const run = vx(root, 'run', 'test', '--affected=HEAD~1')
    const both = vx(root, 'run', 'lint', 'test', '--affected=HEAD~1')
    const typo = vx(root, 'run', 'tset', '--affected=HEAD~1')
    expect({
      run: [run.exitCode, run.out.includes('No affected project declares task(s): test.')],
      both: [both.exitCode, both.out.includes('docs#lint'), both.out.includes('app#test')],
      typo: [typo.exitCode, typo.out.includes('vx run: no projects declare task(s): tset.')],
    }).toEqual({ run: [0, true], both: [0, true, false], typo: [1, true] })
  })
})

// X-129: a changed project with no vx config left the scope with no
// project to ask, and the run refused: "no projects declare task(s): test",
// exit 1, though `app` declares it.
describe('--affected: a changed project with no vx config', () => {
  it('exits 0 and says no affected project declares the task', async () => {
    await rm(path.join(root, 'pkgs', 'docs', 'vx.config.mjs'))
    git(root, 'commit', '-qam', 'docs has no config')
    await writeFile(path.join(root, 'pkgs', 'docs', 'in.txt'), 'z\n')
    git(root, 'commit', '-qam', 'docs only')
    const run = vx(root, 'run', 'test', '--affected=HEAD~1')
    const dry = vx(root, 'run', 'test', '--affected=HEAD~1', '--dry')
    const typo = vx(root, 'run', 'tset', '--affected=HEAD~1')
    expect({
      run: [run.exitCode, run.out.includes('No affected project declares task(s): test.')],
      dry: [dry.exitCode, dry.out.includes('no affected project declares task(s): test.')],
      typo: [typo.exitCode, typo.out.includes('vx run: no projects declare task(s): tset.')],
    }).toEqual({ run: [0, true], dry: [0, true], typo: [1, true] })
  })
})
