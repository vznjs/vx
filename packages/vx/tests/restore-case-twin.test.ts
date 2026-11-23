// A hit restores over the outputs it finds and removes the found ones the
// entry does not hold. On a case-insensitive volume (macOS's default)
// `dist/Out.txt` and the entry's `dist/out.txt` are one file: removing the
// found name after the restore would remove the restored file. The same
// check holds on Linux, where they are two files and the found one goes.

import { readdirSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { localWorkspaceSource } from './helpers/local-workspace.js'
import { run } from './helpers/orchestrator.js'

let root: string
let app: string

const quiet = {
  status: () => undefined,
  taskStdout: () => undefined,
  taskStderr: () => undefined,
  taskComplete: () => undefined,
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-case-twin-'))
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'r', private: true }))
  await Bun.write(path.join(root, '.vx/workspace.mjs'), localWorkspaceSource())
  app = path.join(root, 'packages', 'app')
  await mkdir(path.join(app, 'src'), { recursive: true })
  await writeFile(path.join(app, 'package.json'), JSON.stringify({ name: 'app' }))
  await writeFile(path.join(app, 'src', 'x'), 'x\n')
  await writeFile(
    path.join(app, 'vx.config.mjs'),
    `export default { tasks: { b: { exec: { command: 'mkdir -p dist && echo built > dist/out.txt' },
      inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] }, cache: true } } }\n`,
  )
  await Bun.spawn(['git', 'init', '-q'], { cwd: root }).exited
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const build = () =>
  run({ cwd: root, tasks: ['b'], projects: ['app'], log: quiet, handleSignals: false })

it('a found output differing only in case from a restored one leaves the restored file', async () => {
  expect((await build()).ok).toBe(true)
  const dist = path.join(app, 'dist')
  await rename(path.join(dist, 'out.txt'), path.join(dist, 'Out.txt'))
  await writeFile(path.join(dist, 'Out.txt'), 'stale\n')

  const again = await build()
  expect(again.ok).toBe(true)
  expect(again.outcomes.map((o) => o.status)).toEqual(['cache-hit'])
  expect(readdirSync(dist).map((n) => n.toLowerCase())).toEqual(['out.txt'])
  expect(readFileSync(path.join(dist, 'out.txt'), 'utf8')).toBe('built\n')
})
