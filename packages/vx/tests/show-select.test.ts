// `turbo ls --filter`, `turbo ls --affected` and `nx show projects
// --affected [--with-target t]` narrow a listing; `vx show` and
// `vx show <task>` take `--filter` and `--affected` as `vx run` reads them.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { writeEdges } from './helpers/plugin.js'
import { git } from './helpers/workspace.js'

// `vx lock`, then `vx show`: show reads the lock.
const BIN = path.resolve(import.meta.dir, 'helpers', 'vx-locked.ts')
let root: string

async function write(rel: string, content: string): Promise<void> {
  await mkdir(path.dirname(path.join(root, rel)), { recursive: true })
  await writeFile(path.join(root, rel), content)
}

function names(...args: string[]): { code: number | null; names: string[]; err: string } {
  const r = Bun.spawnSync({
    cmd: [process.execPath, BIN, 'show', ...args, '--format', 'json'],
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const out = r.stdout.toString()
  return {
    code: r.exitCode,
    // A refusal's stdout is its error document (cli.md § Error codes), not a list.
    names:
      out === '' || out.startsWith('{"ok":false')
        ? []
        : (JSON.parse(out) as { name: string }[]).map((p) => p.name),
    err: r.stderr.toString(),
  }
}

// lint reads its own files: one with no `inputs` is marked by any change.
const LINT = `export default { tasks: { lint: { exec: { command: 'true' }, inputs: { files: ['**'] } } } }\n`

// app depends on lib; tool stands alone; lib and tool declare lint.
beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-show-select-'))
  await write('package.json', JSON.stringify({ name: 'r', private: true, workspaces: ['pkgs/*'] }))
  await writeEdges(root, { app: ['lib'] })
  await write('pkgs/lib/package.json', JSON.stringify({ name: 'lib' }))
  await write('pkgs/lib/vx.config.mjs', LINT)
  await write('pkgs/app/package.json', JSON.stringify({ name: 'app' }))
  await write('pkgs/tool/package.json', JSON.stringify({ name: 'tool' }))
  await write('pkgs/tool/vx.config.mjs', LINT)
  git(root, 'init', '-q')
  git(root, 'add', '-A')
  git(root, 'commit', '-qm', 'init')
  await write('pkgs/lib/src.ts', 'export {}\n')
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('vx show --filter / --affected', () => {
  it('narrows the project list', () => {
    expect([names(), names('--filter', '...lib'), names('--filter=!lib')]).toEqual([
      { code: 0, names: ['app', 'lib', 'tool'], err: '' },
      { code: 0, names: ['app', 'lib'], err: '' },
      { code: 0, names: ['app', 'tool'], err: '' },
    ])
  })

  // app declares no task: only the default build, which a run never selects.
  it('lists the projects with an affected task, and a task among them', () => {
    expect([names('--affected=HEAD'), names('lint', '--affected=HEAD')]).toEqual([
      { code: 0, names: ['lib'], err: '' },
      { code: 0, names: ['lib'], err: '' },
    ])
  })

  it('refuses a filter of several that matched nothing', () => {
    const r = names('--filter', 'lib', '--filter', 'tol')
    expect([r.code, r.err]).toEqual([
      1,
      '✗ vx show  no projects matched filter(s): "tol"\n\n  fix  tool\n',
    ])
  })

  it('refuses them beside one project', () => {
    const r = names('lib', '--affected')
    expect([r.code, r.err]).toEqual([
      1,
      '✗ vx show  --filter and --affected narrow a list: `vx show` or `vx show <task>`\n',
    ])
  })
})

// With nothing changed, `vx show <task> --affected` said "nothing affected",
// then "no selected project declares lint (2 outside the selection do)":
// no filter left them out.
describe('vx show <task> --affected with nothing changed', () => {
  it('says only that nothing is affected', () => {
    git(root, 'add', '-A')
    git(root, 'commit', '-qm', 'two')
    const r = Bun.spawnSync({
      cmd: [process.execPath, BIN, 'show', 'lint', '--affected=HEAD'],
      cwd: root,
      env: { ...process.env, NO_COLOR: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect([r.exitCode, r.stdout.toString(), r.stderr.toString().split('\n').length]).toEqual([
      0,
      '',
      2,
    ])
    expect(r.stderr.toString()).toStartWith('› vx show  nothing affected since HEAD')
  })
})
