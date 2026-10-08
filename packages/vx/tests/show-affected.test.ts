// `vx show <task> --affected` lists the projects whose task `vx run <task>
// --affected` keeps: a change reaches another project only along a task
// edge (owner, 2026-10-04), so a package dependent with no edge to the
// changed project's task is not listed (X-147).
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const roots: string[] = []

function git(root: string, ...args: string[]): void {
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

function vx(root: string, ...args: string[]): { code: number | null; out: string; err: string } {
  const r = Bun.spawnSync({
    cmd: [process.execPath, BIN, ...args],
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() }
}

function shown(root: string, ...args: string[]): string[] {
  const r = vx(root, 'show', ...args, '--format', 'json')
  if (r.code !== 0) throw new Error(`vx show ${args.join(' ')}: ${r.err}`)
  return (JSON.parse(r.out) as { name: string }[]).map((p) => p.name)
}

/** The project of each task `vx run <task> --affected --dry=json` plans. */
function planned(root: string, task: string): string[] {
  const r = vx(root, 'run', task, '--affected=HEAD', '--dry=json')
  if (r.code !== 0) throw new Error(`vx run --dry: ${r.err}`)
  const plan = JSON.parse(r.out) as { tasks: { id: string }[] }
  return plan.tasks
    .map((t) => t.id)
    .filter((id) => id.endsWith(`#${task}`))
    .map((id) => id.slice(0, id.indexOf('#')))
    .sort()
}

// y depends on x in package.json; each declares `test`; x changes.
async function fixture(yTest: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vx-show-affected-'))
  roots.push(root)
  const write = async (rel: string, content: string): Promise<void> => {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true })
    await writeFile(path.join(root, rel), content)
  }
  await write('package.json', JSON.stringify({ name: 'r', private: true, workspaces: ['pkgs/*'] }))
  await write('pkgs/x/package.json', JSON.stringify({ name: 'x' }))
  await write(
    'pkgs/x/vx.config.mjs',
    `export default { tasks: { test: { exec: { command: 'echo t' } } } }\n`,
  )
  await write('pkgs/y/package.json', JSON.stringify({ name: 'y', dependencies: { x: '*' } }))
  await write('pkgs/y/vx.config.mjs', `export default { tasks: { test: ${yTest} } }\n`)
  git(root, 'init', '-q')
  git(root, 'add', '-A')
  git(root, 'commit', '-qm', 'init')
  await write('pkgs/x/f.txt', 'q\n')
  return root
}

let noEdge: string
let edge: string

beforeAll(async () => {
  noEdge = await fixture(`{ exec: { command: 'echo t' } }`)
  edge = await fixture(`{ dependsOn: ['^test'], exec: { command: 'echo t' } }`)
})

afterAll(async () => {
  await Promise.all(roots.map((r) => rm(r, { recursive: true, force: true })))
})

describe('vx show <task> --affected', () => {
  it('lists only the projects whose task the run keeps: no task edge, no y', () => {
    expect([shown(noEdge, 'test', '--affected=HEAD'), planned(noEdge, 'test')]).toEqual([
      ['x'],
      ['x'],
    ])
  })

  it('a ^test edge makes the dependent affected, in the list and the run alike', () => {
    expect([shown(edge, 'test', '--affected=HEAD'), planned(edge, 'test')]).toEqual([
      ['x', 'y'],
      ['x', 'y'],
    ])
  })

  it('with no task, lists the run candidates: the changed projects and their dependents', () => {
    expect([shown(noEdge, '--affected=HEAD'), shown(edge, '--affected=HEAD')]).toEqual([
      ['x', 'y'],
      ['x', 'y'],
    ])
  })
})
