import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, expect, it, mock } from 'bun:test'

const read: string[] = []
const realReaddir = fs.readdir
await mock.module('node:fs/promises', () => ({
  ...fs,
  readdir: (dir: string, opts: never) => {
    read.push(dir)
    return realReaddir(dir, opts)
  },
}))
const { outputFiles } = await import('../src/outputs.js')

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vx-dte-outputs-'))
afterAll(() => fs.rm(root, { recursive: true, force: true }))

it('finds a task’s outputs reading only the trees its globs reach', async () => {
  for (let i = 0; i < 50; i++) {
    await fs.mkdir(path.join(root, `p/out/d${i}`), { recursive: true })
    await fs.writeFile(path.join(root, `p/out/d${i}/v`), '')
  }
  await fs.mkdir(path.join(root, 'p/src'), { recursive: true })
  await fs.writeFile(path.join(root, 'p/src/n'), '')
  await fs.writeFile(path.join(root, 'p/src/a.js'), '')
  read.length = 0
  expect(
    await outputFiles(root, 'p', {
      files: ['out/d7/**', 'src/n', '!src/*.map'],
      workspaceFiles: [],
    }),
  ).toEqual(['p/out/d7/v', 'p/src/n'])
  // Walking the project read every one of 50 dirs, per task: 450 ms a task
  // on a worker in a project of 9000 (2026-10-25).
  expect(read.map((d) => path.relative(root, d)).toSorted()).toEqual(['p/out/d7', 'p/src/n'])
  // A root-anchored glob still reaches the whole project.
  expect(await outputFiles(root, 'p', { files: ['**/*.js'], workspaceFiles: [] })).toEqual([
    'p/src/a.js',
  ])
})

it('names no file under a path that is a file', async () => {
  await fs.mkdir(path.join(root, 'q'), { recursive: true })
  await fs.writeFile(path.join(root, 'q/dist'), '')
  await fs.writeFile(path.join(root, 'q/bin'), '')
  expect(
    await outputFiles(root, 'q', { files: ['dist/index.js', 'bin'], workspaceFiles: [] }),
  ).toEqual(['q/bin'])
})
