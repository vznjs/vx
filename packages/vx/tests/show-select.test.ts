// `turbo ls --filter`, `turbo ls --affected` and `nx show projects
// --affected [--with-target t]` narrow a listing; `vx show` and
// `vx show <task>` take `--filter` and `--affected` as `vx run` reads them.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
let root: string

function git(...args: string[]): void {
  const r = Bun.spawnSync({
    cmd: [
      'git',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@t',
      ...args,
    ],
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`)
}

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
    names: out === '' ? [] : (JSON.parse(out) as { name: string }[]).map((p) => p.name),
    err: r.stderr.toString(),
  }
}

const LINT = `export default { tasks: { lint: { exec: { command: 'true' } } } }\n`

// app depends on lib; tool stands alone; lib and tool declare lint.
beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-show-select-'))
  await write('package.json', JSON.stringify({ name: 'r', private: true, workspaces: ['pkgs/*'] }))
  await write('pkgs/lib/package.json', JSON.stringify({ name: 'lib' }))
  await write('pkgs/lib/vx.config.mjs', LINT)
  await write('pkgs/app/package.json', JSON.stringify({ name: 'app', dependencies: { lib: '*' } }))
  await write('pkgs/tool/package.json', JSON.stringify({ name: 'tool' }))
  await write('pkgs/tool/vx.config.mjs', LINT)
  git('init', '-q')
  git('add', '-A')
  git('commit', '-qm', 'init')
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

  it('lists the changed projects and their dependents, and a task among them', () => {
    expect([names('--affected=HEAD'), names('lint', '--affected=HEAD')]).toEqual([
      { code: 0, names: ['app', 'lib'], err: '' },
      { code: 0, names: ['lib'], err: '' },
    ])
  })

  it('refuses them beside one project', () => {
    const r = names('lib', '--affected')
    expect([r.code, r.err]).toEqual([
      1,
      'vx show: --filter and --affected narrow a list: `vx show` or `vx show <task>`\n',
    ])
  })
})
