import { describe, expect, it } from 'bun:test'
import { computeGroupHash, hashTaskConfig } from '../src/orchestrator/task-hash.js'
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
  const g = outcome('p#g', undefined).node
  const cfg = hashTaskConfig(g.config)
  it('an empty group yields a stable, deterministic sentinel', () => {
    // ids = ''.sort().join('|') = '', so the digest is its definition's alone.
    expect(computeGroupHash(g, [])).toBe(xxh3hex(`group|${cfg}|`))
    expect(computeGroupHash(g, [])).toBe(computeGroupHash(g, []))
  })

  it('is order-independent (members are sorted before hashing)', () => {
    const a = outcome('p#a', 'h-a')
    const b = outcome('p#b', 'h-b')
    expect(computeGroupHash(g, [a, b])).toBe(computeGroupHash(g, [b, a]))
  })

  it('changes when an upstream hash changes', () => {
    const before = computeGroupHash(g, [outcome('p#a', 'h1'), outcome('p#b', 'h-b')])
    const after = computeGroupHash(g, [outcome('p#a', 'h2'), outcome('p#b', 'h-b')])
    expect(after).not.toBe(before)
  })

  it('folds a missing upstream hash as the empty string (present member still counts)', () => {
    // A member with no hash contributes `id:` — distinct from having no
    // such member at all.
    const withMissing = computeGroupHash(g, [outcome('p#a', undefined)])
    expect(withMissing).toBe(xxh3hex(`group|${cfg}|p#a:`))
    expect(withMissing).not.toBe(computeGroupHash(g, []))
  })
})

// A `project` or `graph` plugin writes a config the lock never sorted: the
// same task, injected, keyed apart from the one a file declared (2026-10-25).
it('keys a config whatever order it spells its keys in, all the way down', () => {
  const a = {
    exec: { command: 'x', env: { define: { A: '1', B: '2' } } },
    outputs: { files: ['dist/**'] },
    cache: true,
  }
  const b = {
    outputs: { files: ['dist/**'] },
    cache: true,
    exec: { env: { define: { B: '2', A: '1' } }, command: 'x' },
  }
  expect(hashTaskConfig(b as never)).toBe(hashTaskConfig(a as never))
  // An array keeps its order where it may say something (`inputs.tasks`);
  // one that is a set (globs, dependsOn, env names) is sorted.
  const c = { ...a, inputs: { files: [], tasks: ['b', 'a'] } }
  const d = { ...a, inputs: { files: [], tasks: ['a', 'b'] } }
  expect(hashTaskConfig(c as never)).not.toBe(hashTaskConfig(d as never))
  const e = { ...a, outputs: { files: ['b', 'a'] } }
  const f = { ...a, outputs: { files: ['a', 'b'] } }
  expect(hashTaskConfig(e as never)).toBe(hashTaskConfig(f as never))
})
