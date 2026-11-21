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
import type { RemoteCacheLayer } from '../src/cache/index.js'
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

it("a dependency's input edited under a deeper dependant never reaches the remote", async () => {
  // mid's save finds lib's input unmoved before app starts, so app's own save
  // has no window over lib: only the sweep once the graph is done finds the
  // edit. Its upload must wait for that sweep, or another machine replays it.
  await rm(root, { recursive: true, force: true })
  root = await makeWorkspace({
    prefix: 'vx-upstream-remote-',
    edges: { app: ['mid'], mid: ['lib'] },
  })
  const lib = await addProject(root, 'lib', {
    config: `export default { tasks: { build: {
      exec: { command: 'true' },
      inputs: { files: ['src/**'] }, outputs: { files: [] }, cache: true,
    } } }`,
    files: { 'src/a': 'A\n' },
  })
  await addProject(root, 'mid', {
    config: `export default { tasks: { build: {
      exec: { command: 'true' }, dependsOn: ['^build'],
      inputs: { files: ['src/**'] }, outputs: { files: [] }, cache: true,
    } } }`,
    files: { 'src/a': 'm\n' },
  })
  await addProject(root, 'app', {
    config: `export default { tasks: { build: {
      exec: { command: 'touch ${marks}/started && while [ ! -f ${marks}/go ]; do sleep 0.01; done && mkdir -p dist && cat ../lib/src/a > dist/o' },
      dependsOn: ['^build'], inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] }, cache: true,
    } } }`,
    files: { 'src/a': 'x\n' },
  })
  const store = new Map<string, Uint8Array>()
  const remote: RemoteCacheLayer = {
    has: async (hash) => (store.has(hash) ? {} : null),
    get: async (hash) => {
      const bytes = store.get(hash)
      return bytes === undefined ? null : { body: new Blob([bytes]), durationMs: 1 }
    },
    put: async (hash, body) => {
      store.set(hash, new Uint8Array(await body.arrayBuffer()))
    },
  }
  const running = run({ cwd: root, tasks: ['build'], log: logger, remoteCache: remote })
  while (!existsSync(path.join(marks, 'started'))) await Bun.sleep(5)
  await writeFile(path.join(lib, 'src/a'), 'B\n')
  await writeFile(path.join(marks, 'go'), '')
  const first = await running
  expect(first.ok).toBe(true)
  expect(status.some((l) => l.includes('app#build') && l.includes('packages/lib/src/a'))).toBe(true)
  // The sweep drops every entry folding lib's moved key (mid's and app's):
  // only lib's went up. Before the fix app's, built over B under A's key, did too.
  expect(store.size).toBe(1)
}, 30_000)
