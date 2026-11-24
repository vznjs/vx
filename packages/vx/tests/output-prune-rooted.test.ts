// A clean prunes the directories it empties only inside the declared trees.
// A glob with no static directory (Turbo's `**/dist/**`, `{dist,types}/**`)
// pruned nothing, so a directory emptied by a miss's clean was saved as an
// empty output of the new build, and one emptied by a hit's clean was a stray
// on every later hit: each warm run restored again (2026-11-23).

import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-prune-rooted-'))
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'r', private: true }))
  await Bun.write(path.join(root, '.vx/workspace.mjs'), localWorkspaceSource())
  app = path.join(root, 'packages', 'app')
  await mkdir(path.join(app, 'src'), { recursive: true })
  await writeFile(path.join(app, 'package.json'), JSON.stringify({ name: 'app' }))
  await writeFile(path.join(app, 'src', 'x'), 'x\n')
  await Bun.spawn(['git', 'init', '-q'], { cwd: root }).exited
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const configure = (glob: string) =>
  writeFile(
    path.join(app, 'vx.config.mjs'),
    `export default { tasks: { b: { exec: { command: 'mkdir -p dist/s && cat src/x > dist/s/a.js' },
      inputs: { files: ['src/**'] }, outputs: { files: [${JSON.stringify(glob)}] }, cache: true } } }\n`,
  )

const build = () =>
  run({ cwd: root, tasks: ['b'], projects: ['app'], log: quiet, handleSignals: false })

for (const glob of ['**/dist/**', '{dist,types}/**', 'd[i]st/**']) {
  it(`a hit takes a stray tree under ${glob} whole, and the next hit is current`, async () => {
    await configure(glob)
    expect((await build()).ok).toBe(true)
    await mkdir(path.join(app, 'dist/s/deep'), { recursive: true })
    await writeFile(path.join(app, 'dist/s/deep/q.js'), 'stray\n')
    const hit = await build()
    expect(hit.outcomes[0]!.cache?.restored).toBe(true)
    expect(existsSync(path.join(app, 'dist/s/deep'))).toBe(false)
    expect((await build()).outcomes[0]!.cache?.restored).toBe(false)
  })

  it(`a miss under ${glob} saves no directory its clean emptied`, async () => {
    await configure(glob)
    await mkdir(path.join(app, 'dist/old'), { recursive: true })
    await writeFile(path.join(app, 'dist/old/x.js'), 'old\n')
    expect((await build()).ok).toBe(true)
    expect(existsSync(path.join(app, 'dist/old'))).toBe(false)
    await rm(path.join(app, 'dist'), { recursive: true })
    expect((await build()).outcomes[0]!.cache?.restored).toBe(true)
    expect(existsSync(path.join(app, 'dist/old'))).toBe(false)
  })
}

it('CONTROL: the root of a glob with no static directory stays, as `dist/**` keeps `dist`', async () => {
  await configure('**/dist/**')
  expect((await build()).ok).toBe(true)
  await writeFile(path.join(app, 'src', 'x'), 'y\n')
  expect((await build()).ok).toBe(true)
  expect(existsSync(path.join(app, 'dist/s/a.js'))).toBe(true)
  await rm(path.join(app, 'dist/s'), { recursive: true })
  expect((await build()).outcomes[0]!.cache?.restored).toBe(true)
  expect(existsSync(path.join(app, 'dist'))).toBe(true)
})
