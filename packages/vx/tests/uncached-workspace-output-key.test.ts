// A task with no `cache: true` that declares a workspace output in another
// project: no save marks what it wrote, and the run forgot only its own
// project's facts. Its dependant there was keyed on the run-start bytes,
// so every run withheld its save ("its inputs changed after its key was
// taken") and it was never cached.

import { readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import type { Logger } from '../src/report/index.js'
import { run } from './helpers/orchestrator.js'
import { addProject, gitIn, makeWorkspace } from './helpers/workspace.js'

let root: string
let status: string[]
const logger: Logger = {
  status: (line) => status.push(line),
  taskStdout: () => {},
  taskStderr: () => {},
  taskComplete: () => {},
}

beforeEach(async () => {
  root = await makeWorkspace({ prefix: 'vx-uncached-ws-output-' })
  status = []
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

it("a dependant keyed after an uncached task's workspace output reads it, and is saved", async () => {
  const lib = await addProject(root, 'lib', {
    config: `export default { tasks: { check: {
      dependsOn: ['app#write'],
      exec: { command: 'cat src/gen.txt > seen.txt' },
      inputs: { files: ['src/**'], tasks: [] }, outputs: { files: ['seen.txt'] }, cache: true,
    } } }`,
    files: { 'src/gen.txt': '0\n' },
  })
  await addProject(root, 'app', {
    config: `export default { tasks: { write: {
      exec: { command: 'cat ../../next.txt > ../lib/src/gen.txt' },
      inputs: { files: [] },
      outputs: { files: [], workspaceFiles: ['packages/lib/src/gen.txt'] },
    } } }`,
  })
  await writeFile(path.join(root, '.gitignore'), '.vx/cache/\nnext.txt\nseen.txt\n')
  gitIn(root)('add', '-A')
  gitIn(root)('commit', '-qm', 'init')

  const once = async (next: string): Promise<string | undefined> => {
    await writeFile(path.join(root, 'next.txt'), next)
    status = []
    const r = await run({ cwd: root, tasks: ['lib#check'], log: logger })
    expect(r.ok).toBe(true)
    expect(status.filter((l) => l.includes('lib#check'))).toEqual([])
    expect(await readFile(path.join(lib, 'seen.txt'), 'utf8')).toBe(next)
    return r.outcomes.find((o) => o.node.id === 'lib#check')?.status
  }
  expect(await once('A\n')).toBe('success')
  expect(await once('B\n')).toBe('success')
  // A key on A's bytes now, saved by the first run.
  expect(await once('A\n')).toBe('cache-hit')
}, 30_000)
