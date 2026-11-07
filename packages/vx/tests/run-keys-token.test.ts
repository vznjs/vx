// The run key token (orchestrator/run-keys.ts) is a pure function of the
// nodes it is given: these cases build it in-process, without a run.

import { expect, it, spyOn } from 'bun:test'
import { GitFilesCache, type FoldMemo } from '../src/cache/index.js'
import type { TaskNode } from '../src/graph/index.js'
import { runKeysToken } from '../src/orchestrator/run-keys.js'
import { createHashCache } from '../src/orchestrator/task-hash.js'

const dir = '/w/packages/a'

function args(nodes: TaskNode[]): Parameters<typeof runKeysToken>[0] {
  const gitFilesCache = new GitFilesCache()
  const snapshot = ['src/a.ts']
  gitFilesCache.set(dir, snapshot)
  gitFilesCache.noteFilesDigest(dir, snapshot, () => 'digest')
  const hashCache = createHashCache({} as FoldMemo)
  hashCache.graph = 'graph'
  return {
    nodes: new Map(nodes.map((n) => [n.id, n])),
    workspaceRoot: '/w',
    claimedFiles: [],
    nestedDirsByProject: new Map(),
    gitFilesCache,
    hashCache,
  }
}

const nodesOf = (config: () => TaskNode['config']): TaskNode[] =>
  Array.from({ length: 50 }, (_, i) => ({
    id: `a#t${i}`,
    projectName: 'a',
    projectDir: dir,
    taskName: `t${i}`,
    config: config(),
    deps: [],
    requested: true,
  }))

// The lock shares one config among the tasks that declare it alike; a
// stringify of its declaration per node was ~6 ms of 9,603 (2026-11-07).
it('takes a shared config declaration once, and the token is the one per-node configs give', () => {
  const shared: TaskNode['config'] = {
    exec: { command: 'noop' },
    inputs: { files: ['src/**'] },
    outputs: { files: ['out.txt'] },
    cache: true,
  }
  const spy = spyOn(JSON, 'stringify')
  let token: string | undefined
  try {
    token = runKeysToken(args(nodesOf(() => shared)))?.token
    expect(spy.mock.calls.length).toBeLessThan(10)
  } finally {
    spy.mockRestore()
  }
  expect(token).toBeDefined()
  expect(token).toBe(runKeysToken(args(nodesOf(() => structuredClone(shared))))?.token)
})
