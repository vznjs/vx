import { describe, expect, it } from 'bun:test'
import { computeGroupHash } from '../src/orchestrator/task-hash.js'
import type { TaskNode, TaskOutcome } from '../src/graph/index.js'
import { xxh3hex } from '../src/util/index.js'

function outcome(id: string, hash: string | undefined): TaskOutcome {
  const [projectName, taskName] = id.split('#') as [string, string]
  const node: TaskNode = {
    id,
    projectName,
    projectDir: '/tmp',
    taskName,
    config: { exec: { command: 'noop' } },
    deps: [],
    requested: false,
  }
  return { node, status: 'success', exitCode: 0, durationMs: 0, ...(hash ? { hash } : {}) }
}

describe('computeGroupHash', () => {
  it('an empty group yields a stable, deterministic sentinel', () => {
    // ids = ''.sort().join('|') = '', so the digest is xxh3hex('group|').
    expect(computeGroupHash([])).toBe(xxh3hex('group|'))
    expect(computeGroupHash([])).toBe(computeGroupHash([]))
  })

  it('is order-independent (members are sorted before hashing)', () => {
    const a = outcome('p#a', 'h-a')
    const b = outcome('p#b', 'h-b')
    expect(computeGroupHash([a, b])).toBe(computeGroupHash([b, a]))
  })

  it('changes when an upstream hash changes', () => {
    const before = computeGroupHash([outcome('p#a', 'h1'), outcome('p#b', 'h-b')])
    const after = computeGroupHash([outcome('p#a', 'h2'), outcome('p#b', 'h-b')])
    expect(after).not.toBe(before)
  })

  it('folds a missing upstream hash as the empty string (present member still counts)', () => {
    // A member with no hash contributes `id:` — distinct from having no
    // such member at all.
    const withMissing = computeGroupHash([outcome('p#a', undefined)])
    expect(withMissing).toBe(xxh3hex('group|p#a:'))
    expect(withMissing).not.toBe(computeGroupHash([]))
  })
})
