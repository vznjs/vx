// The run key token (orchestrator/run-keys.ts) is a pure function of the
// nodes it is given: these cases build it in-process, without a run.

import { expect, it, spyOn } from 'bun:test'
import { GitFilesCache, type FoldMemo } from '../src/cache/index.js'
import type { TaskNode } from '../src/graph/index.js'
import { readRunKeys, runKeysToken, writeRunKeys } from '../src/orchestrator/run-keys.js'
import { createHashCache } from '../src/orchestrator/task-hash.js'

const dir = '/w/packages/a'

function args(
  nodes: TaskNode[],
  opts: {
    digest?: string
    nested?: string[]
    graph?: string
    clean?: boolean | undefined
    strategy?: Parameters<typeof createHashCache>[2]
  } = {},
): Parameters<typeof runKeysToken>[0] {
  const gitFilesCache = new GitFilesCache()
  const snapshot = ['src/a.ts']
  gitFilesCache.set(dir, snapshot)
  gitFilesCache.noteFilesDigest(dir, snapshot, () => opts.digest ?? 'digest')
  const rows = new Map<string, string>()
  const folds: FoldMemo = {
    get: (id, probe) => rows.get(`${id}\0${probe}`),
    set: (id, probe, key) => void rows.set(`${id}\0${probe}`, key),
  }
  const hashCache = createHashCache(folds, opts.clean, opts.strategy)
  hashCache.graph = opts.graph ?? 'graph'
  return {
    nodes: new Map(nodes.map((n) => [n.id, n])),
    workspaceRoot: '/w',
    claimedFiles: [],
    nestedDirsByProject: new Map(opts.nested === undefined ? [] : [['a', opts.nested]]),
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

const declared = (): TaskNode['config'] => ({
  exec: { command: 'noop' },
  inputs: { files: ['src/**'] },
  outputs: { files: ['out.txt'] },
  cache: true,
})

// A files token in full is ~200 characters per node, joined into the run's
// token and hashed again: 2 MB at 8,002 tasks. Each distinct token is
// hashed once, and the run's token names that hash.
it('hashes each distinct files token once, not once per node', () => {
  const digest = 'd'.repeat(5000)
  const hash = spyOn(Bun.hash, 'xxHash3')
  try {
    expect(runKeysToken(args(nodesOf(declared), { digest }))).toBeDefined()
    const lengths = hash.mock.calls.map(([input]) => (input as string).length)
    // CONTROL: the files token itself is hashed, digest and all.
    expect(lengths.filter((n) => n >= digest.length)).toHaveLength(1)
    expect(lengths.filter((n) => n >= digest.length * 2)).toEqual([])
  } finally {
    hash.mockRestore()
  }
})

// The hash stands for the whole files token: each thing it folds still moves
// the run's token, and the delta's files of the nodes it names.
it('moves the token for each ingredient of a files token', () => {
  const at = (
    opts: Parameters<typeof args>[1] = {},
    config: () => TaskNode['config'] = declared,
  ): { token: string; files: string; global: string } => {
    const got = runKeysToken(args(nodesOf(config), opts))!
    const delta = got.delta!()
    return { token: got.token, files: delta.files.get('a#t0')!, global: delta.global }
  }
  const base = at()
  // CONTROL: the same facts, the same token.
  expect(at()).toEqual(base)
  // Nested project dirs are in the global part as well.
  const nested = at({ nested: ['/w/packages/a/sub'] })
  expect(nested.token).not.toBe(base.token)
  expect(nested.files).not.toBe(base.files)
  const moved = [
    at({ digest: 'other' }),
    at({}, () => ({ ...declared(), inputs: { files: ['src/a.ts'] } })),
    at({}, () => ({ ...declared(), inputs: { files: ['src/**', '!src/x'] } })),
    at({}, () => ({ ...declared(), outputs: { files: ['dist/**'] } })),
  ]
  for (const m of moved) {
    expect(m.token).not.toBe(base.token)
    expect(m.files).not.toBe(base.files)
    // Only the files moved: the delta derives just the keys they reach.
    expect(m.global).toBe(base.global)
  }
  expect(new Set(moved.map((m) => m.token)).size).toBe(moved.length)
  expect(at({ graph: 'other' }).global).not.toBe(base.global)
})

// The memo row names each key's node by its place in the run's node order,
// which the token pins: read by id, the row's ids and a lookup per node
// were ~5 ms of 8,002 (2026-11-07).
it('reads remembered keys back by node place, under a token that pins the order', () => {
  const nodes = nodesOf(declared)
  const a = args(nodes)
  const at = runKeysToken(a)!
  const stableKeys = nodes.slice(0, 30).map((node, i) => ({ node, hash: `s${i}` }))
  const uncachedKeys = new Map(nodes.slice(30).map((n, i) => [n.id, `u${i}`]))
  writeRunKeys(a, at, { stableKeys, uncachedKeys })
  const get = spyOn(a.nodes, 'get')
  try {
    const read = readRunKeys(a, at)!
    expect(read.stableKeys.map((k) => [k.node.id, k.hash])).toEqual(
      stableKeys.map((k) => [k.node.id, k.hash]),
    )
    expect(read.stableKeys[0]!.node).toBe(nodes[0]!)
    expect([...read.uncachedKeys]).toEqual([...uncachedKeys])
    expect(get).toHaveBeenCalledTimes(0)
  } finally {
    get.mockRestore()
  }
  // The same nodes in another order are another token: no row of this one.
  const reordered = args([...nodes].reverse())
  expect(runKeysToken(reordered)!.id).not.toBe(at.id)
})

// A remembered graph's token names the lock, which never holds
// `.vx/workspace`: its `outputs.clean: false` moved no token, and the
// keys of the unclean run were read back after the clean was on again.
it("moves with the workspace's outputs.clean under a remembered graph", () => {
  const token = (clean?: boolean) => runKeysToken(args(nodesOf(declared), { clean }))?.token
  expect(token(false)).toBeDefined()
  expect(token(false)).not.toBe(token(undefined))
  expect(token(false)).not.toBe(token(true))
})

// The same for the strategy a task runs under: the workspace's and the
// variable's fold into a config's key, and neither is in the lock.
it('moves with the inputs.stability.strategy of the workspace and the variable', () => {
  const token = (strategy?: Parameters<typeof createHashCache>[2]) =>
    runKeysToken(args(nodesOf(declared), { strategy }))?.token
  expect(token()).toBeDefined()
  expect(token({ workspace: 'unchecked' })).not.toBe(token())
  expect(token({ run: 'unchecked' })).not.toBe(token())
  expect(token({ run: 'unchecked' })).not.toBe(token({ workspace: 'unchecked' }))
})
