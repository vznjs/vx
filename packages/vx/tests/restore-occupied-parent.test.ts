// A hit whose entry needs a path the tree now holds as something else.
// nx#37661 (2026-11): Nx's restore turned every parent of a matched path
// into a directory, replacing a file or link there, and replaced a
// directory holding negated outputs with the cached file, deleting the
// excluded files under it. vx refuses such a restore and keeps the tree.

import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { run } from './helpers/orchestrator.js'
import { localWorkspaceSource } from './helpers/local-workspace.js'

let root: string
let app: string

const quiet = {
  runStart: () => undefined,
  taskStart: () => undefined,
  taskStdout: () => undefined,
  taskComplete: () => undefined,
  runStatus: () => undefined,
  runEnd: () => undefined,
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-occupied-'))
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'r', private: true }))
  await Bun.write(path.join(root, '.vx/workspace.mjs'), localWorkspaceSource())
  app = path.join(root, 'packages', 'app')
  await mkdir(path.join(app, 'src'), { recursive: true })
  await writeFile(path.join(app, 'package.json'), JSON.stringify({ name: 'app' }))
  await writeFile(path.join(app, 'src', 'index.js'), 'export {}\n')
  await Bun.spawn(['git', 'init', '-q'], { cwd: root }).exited
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function config(command: string, outputs: string[]): Promise<void> {
  await writeFile(
    path.join(app, 'vx.config.mjs'),
    `export default { tasks: { b: { exec: { command: ${JSON.stringify(command)} },
      inputs: { files: ['src/**'] }, cache: { outputs: { files: ${JSON.stringify(outputs)} } } } } }\n`,
  )
}

async function build(): Promise<{ ok: boolean; restored: boolean | undefined; said: string[] }> {
  const said: string[] = []
  const summary = await run({
    cwd: root,
    tasks: ['b'],
    projects: ['app'],
    log: {
      ...quiet,
      status: () => undefined,
      taskStderr: (_node: unknown, line: string) => {
        said.push(line.trim())
      },
    },
    handleSignals: false,
  })
  return { ok: summary.ok, restored: summary.outcomes[0]?.restored, said }
}

it('a file where a glob match needs a directory: the restore is refused and the file kept', async () => {
  await config('mkdir -p dist/a && echo x > dist/a/x.js', ['dist/*/x.js'])
  expect((await build()).ok).toBe(true)
  await rm(path.join(app, 'dist', 'a'), { recursive: true })
  await writeFile(path.join(app, 'dist', 'a'), 'mine')
  const second = await build()
  expect(second.ok).toBe(false)
  expect(second.said.join('\n')).toContain('a file stands where the entry needs a directory')
  expect(await readFile(path.join(app, 'dist', 'a'), 'utf8')).toBe('mine')
})

it('a directory holding negated outputs where the entry holds a file: refused, nothing under it deleted', async () => {
  await config(
    'mkdir -p dist && { [ -d dist/keep ] || echo out > dist/keep; } && echo a > dist/a.js',
    ['dist/**', '!dist/keep/**'],
  )
  expect((await build()).ok).toBe(true)
  await rm(path.join(app, 'dist', 'keep'))
  await mkdir(path.join(app, 'dist', 'keep'))
  await writeFile(path.join(app, 'dist', 'keep', 'precious.txt'), 'mine')
  const second = await build()
  expect(second.ok).toBe(false)
  expect(second.said.join('\n')).toContain('a directory stands where the entry holds a file')
  expect(await readFile(path.join(app, 'dist', 'keep', 'precious.txt'), 'utf8')).toBe('mine')
})

it('CONTROL: a link inside the project at a glob parent is written through, as the task does', async () => {
  await config('mkdir -p dist/a && echo x > dist/a/x.js', ['dist/*/x.js'])
  expect((await build()).ok).toBe(true)
  await rm(path.join(app, 'dist', 'a'), { recursive: true })
  await mkdir(path.join(app, 'other'))
  await symlink('../other', path.join(app, 'dist', 'a'))
  expect(await build()).toMatchObject({ ok: true, restored: true })
  expect((await lstat(path.join(app, 'dist', 'a'))).isSymbolicLink()).toBe(true)
  expect(await readdir(path.join(app, 'other'))).toEqual(['x.js'])
})
