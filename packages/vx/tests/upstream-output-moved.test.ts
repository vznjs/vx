// A key folds each dependency's input key, never its bytes. A checkout or
// stash that put a dependency's committed output back while its dependant
// ran let the dependant build from bytes no key names, and the save filed
// them under one that does: every later hit replayed them under a green
// run. The dependant's save is withheld when a dependency's output no
// longer holds what that task left.

import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import type { Logger } from '../src/report/index.js'
import { run } from './helpers/orchestrator.js'
import { addProject, gitIn, makeWorkspace } from './helpers/workspace.js'

let root: string
let marks: string
let status: string[]
const logger: Logger = {
  status: (line) => status.push(line),
  taskStdout: () => {},
  taskStderr: () => {},
  taskComplete: () => {},
}

beforeEach(async () => {
  root = await makeWorkspace({ prefix: 'vx-upstream-moved-', edges: { app: ['lib'] } })
  marks = await mkdtemp(path.join(os.tmpdir(), 'vx-upstream-marks-'))
  status = []
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  await rm(marks, { recursive: true, force: true })
})

it('a dependency output a checkout puts back mid-run leaves the dependant unsaved', async () => {
  const lib = await addProject(root, 'lib', {
    config: `export default { tasks: { build: {
      exec: { command: 'mkdir -p dist && cat src/a > dist/o' },
      inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] }, cache: true,
    } } }`,
    files: { 'src/a': 'A\n' },
  })
  const app = await addProject(root, 'app', {
    config: `export default { tasks: { build: {
      exec: { command: 'touch ${marks}/started && while [ ! -f ${marks}/go ]; do sleep 0.01; done && mkdir -p dist && cat ../lib/dist/o > dist/o' },
      dependsOn: ['^build'], inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] }, cache: true,
    } } }`,
    files: { 'src/a': 'x\n' },
  })
  await writeFile(path.join(root, '.gitignore'), '.vx/cache/\n')
  await writeFile(path.join(marks, 'go'), '')
  expect((await run({ cwd: root, tasks: ['build'], log: logger })).ok).toBe(true)
  // The outputs are committed, as generated code often is.
  gitIn(root)('add', '-A')
  gitIn(root)('commit', '-q', '-m', 'fixture')

  await rm(path.join(marks, 'go'))
  await rm(path.join(marks, 'started'))
  await writeFile(path.join(lib, 'src/a'), 'B\n')
  status = []
  const running = run({ cwd: root, tasks: ['build'], log: logger })
  while (!existsSync(path.join(marks, 'started'))) await Bun.sleep(5)
  gitIn(root)('checkout', '--', 'packages/lib/dist')
  await writeFile(path.join(marks, 'go'), '')
  expect((await running).ok).toBe(true)
  expect(status.filter((l) => l.includes('changed while it ran'))).toEqual([
    '[vx] app#build: an output of lib#build changed while it ran (a checkout, a stash, another process) — the result stands, but is not saved under a key that names the bytes it was built from',
  ])

  // Before the fix: app#build was up-to-date here and kept lib's old bytes.
  expect((await run({ cwd: root, tasks: ['build'], log: logger })).ok).toBe(true)
  expect(await readFile(path.join(lib, 'dist/o'), 'utf8')).toBe('B\n')
  expect(await readFile(path.join(app, 'dist/o'), 'utf8')).toBe('B\n')
}, 30_000)

// Ignored outputs too: a sibling task or another process rewrites them as
// readily as a checkout puts committed ones back.
it('a dependency output git ignores, rewritten mid-run, is not replayed', async () => {
  const lib = await addProject(root, 'lib', {
    config: `export default { tasks: { build: {
      exec: { command: 'mkdir -p dist && cat src/a > dist/o' },
      inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] }, cache: true,
    } } }`,
    files: { 'src/a': 'A\n' },
  })
  const app = await addProject(root, 'app', {
    config: `export default { tasks: { build: {
      exec: { command: 'touch ${marks}/started && while [ ! -f ${marks}/go ]; do sleep 0.01; done && mkdir -p dist && cat ../lib/dist/o > dist/o' },
      dependsOn: ['^build'], inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] }, cache: true,
    } } }`,
    files: { 'src/a': 'x\n' },
  })
  await writeFile(path.join(root, '.gitignore'), '.vx/cache/\ndist/\n')
  gitIn(root)('add', '-A')
  gitIn(root)('commit', '-q', '-m', 'fixture')

  const running = run({ cwd: root, tasks: ['build'], log: logger })
  while (!existsSync(path.join(marks, 'started'))) await Bun.sleep(5)
  await writeFile(path.join(lib, 'dist/o'), 'B\n')
  await writeFile(path.join(marks, 'go'), '')
  expect((await running).ok).toBe(true)
  expect(await readFile(path.join(app, 'dist/o'), 'utf8')).toBe('B\n')

  await rm(path.join(lib, 'dist'), { recursive: true })
  await rm(path.join(app, 'dist'), { recursive: true })
  // Before the fix: lib restored A and app hit, replaying B.
  expect((await run({ cwd: root, tasks: ['build'], log: logger })).ok).toBe(true)
  expect(await readFile(path.join(lib, 'dist/o'), 'utf8')).toBe('A\n')
  expect(await readFile(path.join(app, 'dist/o'), 'utf8')).toBe('A\n')
}, 30_000)

// `--force` re-runs a stored key. The dependency's own fresh write is not a
// move: once every forced chain warned here and saved no dependant.
it('a --force run over a stored chain saves its dependants', async () => {
  await addProject(root, 'lib', {
    config: `export default { tasks: { build: {
      exec: { command: 'mkdir -p dist && cat src/a > dist/o' },
      inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] }, cache: true,
    } } }`,
    files: { 'src/a': 'A\n' },
  })
  await addProject(root, 'app', {
    config: `export default { tasks: { build: {
      exec: { command: 'mkdir -p dist && cat ../lib/dist/o > dist/o' },
      dependsOn: ['^build'], inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] }, cache: true,
    } } }`,
    files: { 'src/a': 'x\n' },
  })
  await writeFile(path.join(root, '.gitignore'), '.vx/cache/\ndist/\n')
  gitIn(root)('add', '-A')
  gitIn(root)('commit', '-q', '-m', 'fixture')
  expect((await run({ cwd: root, tasks: ['build'], log: logger })).ok).toBe(true)
  // Past the mtime grain, so the forced write is another mtime.
  await Bun.sleep(1_100)

  status = []
  expect(
    (await run({ cwd: root, tasks: ['build'], log: logger, cacheFlags: { force: true } })).ok,
  ).toBe(true)
  expect(status.filter((l) => l.includes('changed while it ran'))).toEqual([])
}, 30_000)

it('a --force run still withholds a dependant whose dependency output moved', async () => {
  const lib = await addProject(root, 'lib', {
    config: `export default { tasks: { build: {
      exec: { command: 'mkdir -p dist && cat src/a > dist/o' },
      inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] }, cache: true,
    } } }`,
    files: { 'src/a': 'A\n' },
  })
  const app = await addProject(root, 'app', {
    config: `export default { tasks: { build: {
      exec: { command: 'touch ${marks}/started && while [ ! -f ${marks}/go ]; do sleep 0.01; done && mkdir -p dist && cat ../lib/dist/o > dist/o' },
      dependsOn: ['^build'], inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] }, cache: true,
    } } }`,
    files: { 'src/a': 'x\n' },
  })
  await writeFile(path.join(root, '.gitignore'), '.vx/cache/\ndist/\n')
  gitIn(root)('add', '-A')
  gitIn(root)('commit', '-q', '-m', 'fixture')
  await writeFile(path.join(marks, 'go'), '')
  expect((await run({ cwd: root, tasks: ['build'], log: logger })).ok).toBe(true)
  await rm(path.join(marks, 'go'))
  await rm(path.join(marks, 'started'))
  await rm(path.join(app, 'dist'), { recursive: true })

  status = []
  const running = run({ cwd: root, tasks: ['build'], log: logger, cacheFlags: { force: true } })
  while (!existsSync(path.join(marks, 'started'))) await Bun.sleep(5)
  await writeFile(path.join(lib, 'dist/o'), 'B\n')
  await writeFile(path.join(marks, 'go'), '')
  expect((await running).ok).toBe(true)
  expect(status.filter((l) => l.includes('changed while it ran'))).toHaveLength(1)
}, 30_000)
