import { describe, expect, it } from 'bun:test'
import { filterUpstreamHashes } from '../src/orchestrator/upstream.js'
import type { TaskNode, TaskOutcome } from '../src/graph/index.js'
import { UserError } from '../src/util/index.js'

// filterUpstreamHashes(upstream, filter, selfProjectName, selfTaskId) →
// Array<[upstreamTaskId, hash]>. The filter is Turbo/Nx micro-syntax
// (`*`, `^*`, `name`, `^name`, `pkg#task`, and `!<form>` negation),
// applied in order with last-write-wins, deduped by hash.

function outcome(id: string, hash: string): TaskOutcome {
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
  return { node, status: 'success', exitCode: 0, durationMs: 0, hash }
}

describe('filterUpstreamHashes', () => {
  it('undefined filter → every upstream with a hash contributes, keyed by node id', () => {
    const up = [outcome('self#a', 'h-a'), outcome('dep#b', 'h-b')]
    expect(filterUpstreamHashes(up, undefined, 'self', 'self#build')).toEqual([
      ['self#a', 'h-a'],
      ['dep#b', 'h-b'],
    ])
  })

  it('empty filter → nothing contributes (fully decoupled)', () => {
    const up = [outcome('self#a', 'h-a'), outcome('dep#b', 'h-b')]
    expect(filterUpstreamHashes(up, [], 'self', 'self#build')).toEqual([])
  })

  it('!name (self-project negation) removes only that same-project task', () => {
    const up = [outcome('self#foo', 'h-foo'), outcome('self#bar', 'h-bar')]
    // `*` selects both same-project upstreams, then `!foo` deletes foo.
    const out = filterUpstreamHashes(up, ['*', '!foo'], 'self', 'self#build')
    expect(out).toEqual([['self#bar', 'h-bar']])
    // The negated hash must be gone entirely.
    expect(out.some(([, h]) => h === 'h-foo')).toBe(false)
  })

  it('!^noisy (dep-workspace negation) removes only that dep task', () => {
    const up = [outcome('dep#noisy', 'h-noisy')]
    // `^*` selects every dep-workspace upstream; `!^noisy` deletes noisy.
    expect(filterUpstreamHashes(up, ['^*', '!^noisy'], 'self', 'self#build')).toEqual([])
  })

  it("['*','^*','!^noisy'] applies in order (last write wins): keeps self + non-noisy deps", () => {
    const up = [outcome('self#a', 'h-a'), outcome('dep#b', 'h-b'), outcome('dep#noisy', 'h-noisy')]
    const out = filterUpstreamHashes(up, ['*', '^*', '!^noisy'], 'self', 'self#build')
    expect(out).toEqual([
      ['self#a', 'h-a'],
      ['dep#b', 'h-b'],
    ])
    expect(out.some(([, h]) => h === 'h-noisy')).toBe(false)
  })

  it('dedups by hash, keeping the FIRST upstream id seen for that hash', () => {
    const up = [outcome('self#x', 'dup'), outcome('self#y', 'dup')]
    // Both tasks share the hash `dup`; only one pair survives, named by
    // the first task encountered (self#x).
    expect(filterUpstreamHashes(up, ['*'], 'self', 'self#build')).toEqual([['self#x', 'dup']])
  })

  it('wraps an invalid filter spec in a UserError naming the task', () => {
    const up = [outcome('self#a', 'h-a')]
    expect(() => filterUpstreamHashes(up, ['^'], 'self', 'self#build')).toThrow(UserError)
    expect(() => filterUpstreamHashes(up, ['^'], 'self', 'self#build')).toThrow(
      /self#build: cache\.inputs\.tasks/,
    )
  })
})
