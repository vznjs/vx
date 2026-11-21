// A dependant's save re-checks a task under it only while a window (a command,
// restore or fetch that may write its project) opened since its inputs were
// last found unmoved. The check awaits (a hash, a hit's input listing): a
// window that opened during that await was dropped with the task, so a write
// it then made was judged only by the sweep once the graph was done.

import { lstatSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, spyOn } from 'bun:test'
import type { TaskNode } from '../src/graph/index.js'
import { commandWindows } from '../src/orchestrator/command-windows.js'
import type { ExecuteArgs } from '../src/orchestrator/execute-task.js'
import { KeyedTasks } from '../src/orchestrator/upstream-inputs.js'

let root: string | undefined
afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
})

function node(id: string, projectDir: string, deps: string[] = []): TaskNode {
  return {
    id,
    projectName: id.split('#')[0]!,
    projectDir,
    taskName: 'build',
    config: { exec: { command: 'true' }, inputs: { files: ['src/**'] }, outputs: { files: [] } },
    deps,
    requested: false,
  } as unknown as TaskNode
}

it('a window opened while a re-check awaits keeps its project checked', async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-window-race-'))
  const lib = path.join(root, 'lib')
  await mkdir(path.join(lib, 'src'), { recursive: true })
  const file = path.join(lib, 'src/a')
  writeFileSync(file, 'A\n')
  const nodes = new Map<string, TaskNode>([
    ['lib#build', node('lib#build', lib)],
    ['app#build', node('app#build', path.join(root, 'app'), ['lib#build'])],
    ['web#build', node('web#build', path.join(root, 'web'), ['lib#build'])],
  ])
  const windows = commandWindows()
  const keyed = new KeyedTasks(nodes, 0, 0, windows)
  // The fact's digest is its file's as read: a hash finds it unmoved.
  const run = {
    workspaceRoot: root,
    cacheDir: root,
    cache: { memo: { hashFile: async () => 'A' } },
  }
  const args = (id: string) =>
    ({ node: nodes.get(id)!, run, executor: {} }) as unknown as ExecuteArgs
  keyed.dispatched(args('lib#build'))
  const ctime = lstatSync(file).ctimeMs
  // Read in its own tick: judged by its bytes, so the check awaits a hash.
  keyed.ran(args('lib#build'), [{ path: file, digest: 'A', since: ctime }], ctime + 1)

  let now = 1_000
  const clock = spyOn(Date, 'now').mockImplementation(() => now)
  try {
    const checking = keyed.moved(args('app#build'))
    // While it awaits, lib#gen starts: its command may write lib.
    now = 1_005
    const close = windows.open('lib#gen', lib, 'project')
    expect(await checking).toBeUndefined()
    now = 1_010
    clock.mockRestore()
    await Bun.sleep(20)
    writeFileSync(file, 'B\n')
    close()
    // Before the fix: lib#build left the checked set, and web's save took B.
    expect((await keyed.moved(args('web#build')))?.file).toBe(file)
  } finally {
    clock.mockRestore()
  }
})
