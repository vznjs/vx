// A save re-checks each task under it whose project a window may have
// written since. On a one-project chain every command's window marks every
// task again, and the shared inputs were lstat'd once per task per save:
// N² stats, a 10,000-task chain 89 s cold against 33 s with one stat of a
// file per save.

import * as fs from 'node:fs'
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

const N = 300

it('a save stats a file its tasks share once, however many read it', async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-chain-'))
  const dir = path.join(root, 'a')
  await mkdir(path.join(dir, 'src'), { recursive: true })
  const file = path.join(dir, 'src/a')
  writeFileSync(file, 'A\n')
  const nodes = new Map<string, TaskNode>()
  for (let i = 0; i < N; i++) {
    const id = `a#t${i}`
    nodes.set(id, {
      id,
      projectName: 'a',
      projectDir: dir,
      taskName: `t${i}`,
      config: { exec: { command: 'true' }, inputs: { files: ['src/**'] }, outputs: { files: [] } },
      deps: i === 0 ? [] : [`a#t${i - 1}`],
      requested: false,
    } as unknown as TaskNode)
  }
  const windows = commandWindows()
  const keyed = new KeyedTasks(nodes, 0, 0, windows)
  const run = {
    workspaceRoot: root,
    cacheDir: root,
    cache: { memo: { hashFile: async () => 'A' } },
  }
  const args = (i: number) =>
    ({ node: nodes.get(`a#t${i}`)!, run, executor: {} }) as unknown as ExecuteArgs
  // Read well before any task took its key: judged by its ctime alone.
  const since = lstatSync(file).ctimeMs + 10_000
  const stats = spyOn(fs, 'lstatSync')
  try {
    let saves = 0
    for (let i = 0; i < N; i++) {
      // The task's command: a window over the project, as each task's is.
      const close = windows.open(`a#t${i}`, dir, 'project')
      keyed.dispatched(args(i))
      keyed.ran(args(i), [{ path: file, digest: 'A', since }], since)
      close()
      if (i > 0) {
        expect(await keyed.moved(args(i))).toBeUndefined()
        saves++
      }
    }
    expect(stats.mock.calls.filter(([p]) => p === file).length).toBe(saves)
  } finally {
    stats.mockRestore()
  }
})
