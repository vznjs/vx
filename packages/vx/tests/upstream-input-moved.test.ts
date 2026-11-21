// A key folds each dependency's input key, never its bytes. An edit to a
// dependency's input while its dependant ran (an editor, a sibling task
// writing there) let the dependant build from bytes no key names, and the
// save filed them under the dependency's old key: once the edit was undone,
// every later hit replayed the edited build under a green run.

import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import type { Logger } from '../src/report/index.js'
import { run } from './helpers/orchestrator.js'
import { addProject, makeWorkspace } from './helpers/workspace.js'

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
  root = await makeWorkspace({ prefix: 'vx-upstream-input-', edges: { app: ['lib'] } })
  marks = await mkdtemp(path.join(os.tmpdir(), 'vx-upstream-input-marks-'))
  status = []
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  await rm(marks, { recursive: true, force: true })
})

it("a dependency's input edited while the dependant runs leaves the dependant unsaved", async () => {
  const lib = await addProject(root, 'lib', {
    config: `export default { tasks: { build: {
      exec: { command: 'true' },
      inputs: { files: ['src/**'] }, outputs: { files: [] }, cache: true,
    } } }`,
    files: { 'src/a': 'A\n' },
  })
  // app reads lib's source itself, as a bundler resolving a workspace package does.
  const app = await addProject(root, 'app', {
    config: `export default { tasks: { build: {
      exec: { command: 'touch ${marks}/started && while [ ! -f ${marks}/go ]; do sleep 0.01; done && mkdir -p dist && cat ../lib/src/a > dist/o' },
      dependsOn: ['^build'], inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] }, cache: true,
    } } }`,
    files: { 'src/a': 'x\n' },
  })
  const running = run({ cwd: root, tasks: ['build'], log: logger })
  while (!existsSync(path.join(marks, 'started'))) await Bun.sleep(5)
  await writeFile(path.join(lib, 'src/a'), 'B\n')
  await writeFile(path.join(marks, 'go'), '')
  expect((await running).ok).toBe(true)
  expect(await readFile(path.join(app, 'dist/o'), 'utf8')).toBe('B\n')
  expect(status.some((l) => l.includes('app#build') && l.includes('packages/lib/src/a'))).toBe(true)

  // The edit undone. Before the fix: app#build hit and restored B.
  await writeFile(path.join(lib, 'src/a'), 'A\n')
  await rm(path.join(app, 'dist'), { recursive: true })
  expect((await run({ cwd: root, tasks: ['build'], log: logger })).ok).toBe(true)
  expect(await readFile(path.join(app, 'dist/o'), 'utf8')).toBe('A\n')
}, 30_000)
