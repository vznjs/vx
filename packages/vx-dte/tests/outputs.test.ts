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
const { leftUnder, outputFiles } = await import('../src/outputs.js')

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

it('sorts the files under outputs into stale and an upstream’s in time linear in them', () => {
  const under = Array.from({ length: 40_000 }, (_, i) => `web/.next/chunks/${i}.js`)
  under.push('web/.next/BUILD_ID', 'web/.next/kept.txt', 'web/.next/sub/x.js', 'web/.next/lib/a.js')
  const start = process.cpuUsage()
  const { cleared, held } = leftUnder(
    under,
    new Set(['web/.next/kept.txt']),
    ['web/.next/sub'],
    [(f) => f.startsWith('web/.next/lib/')],
  )
  const { user, system } = process.cpuUsage(start)
  expect(held).toEqual(['web/.next/lib/a.js'])
  expect(cleared).toHaveLength(40_001)
  expect(cleared.at(-1)).toBe('web/.next/BUILD_ID')
  expect((user + system) / 1000).toBeLessThan(500)
})

// Core measured `dist -> ../victim` under `dist/**` deleting a file outside
// the project, and `dist -> .git` the repository (inputs.ts `containedIn`):
// a worker clears what this names before the task runs.
it('names no file through a link out of the project, or into .git', async () => {
  await fs.mkdir(path.join(root, 'victim'), { recursive: true })
  await fs.writeFile(path.join(root, 'victim/precious.txt'), '')
  await fs.mkdir(path.join(root, 'l/.git'), { recursive: true })
  await fs.writeFile(path.join(root, 'l/.git/HEAD'), '')
  await fs.mkdir(path.join(root, 'l/real'), { recursive: true })
  await fs.writeFile(path.join(root, 'l/real/a.js'), '')
  await fs.symlink('../victim', path.join(root, 'l/dist'))
  await fs.symlink('.git', path.join(root, 'l/meta'))
  await fs.symlink('real', path.join(root, 'l/build'))
  // Out of the workspace, for its own outputs.
  const away = await fs.mkdtemp(path.join(os.tmpdir(), 'vx-dte-away-'))
  await fs.writeFile(path.join(away, 'precious.txt'), '')
  await fs.symlink(away, path.join(root, 'away'))
  try {
    expect(
      await outputFiles(root, 'l', {
        files: ['dist/**', 'meta/**', 'build/**'],
        workspaceFiles: ['away/**'],
      }),
    ).toEqual(['l/build/a.js'])
  } finally {
    await fs.rm(away, { recursive: true, force: true })
  }
})
