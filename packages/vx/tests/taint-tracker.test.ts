// The taint rule as a rule, apart from the run that exercises it.
//
// `continue-taint.test.ts` drives `--continue=always` end to end and reaches
// exactly two of the four upstream outcomes `taintTracker` treats as poison:
// a `failed` upstream and the transitive hop through it. Dropping `'aborted'`
// or `'skipped'` from the rule survives every test in the repo (measured
// 2026-09-20), and no e2e can close that: the run shapes that produce those
// statuses under `--continue=always` are the ones a SIGINT or a filter
// creates, and arranging them races the thing being tested.
//
// `taintTracker` takes the upstream outcomes directly, which is exactly the
// fabrication an e2e cannot do — and it lives here rather than in that file
// because that file's fixture builds a git repo per case, which these rows
// have no use for.

import { describe, expect, it } from 'bun:test'
import { taintTracker } from '../src/orchestrator/admission.js'
import type { TaskNode, TaskOutcome } from '../src/graph/index.js'

describe('taintTracker — which upstream outcomes poison a task', () => {
  const node = (id: string): TaskNode => ({ id }) as TaskNode
  const from = (id: string, status: TaskOutcome['status']): TaskOutcome =>
    ({ node: node(id), status }) as TaskOutcome

  for (const status of ['failed', 'aborted', 'skipped'] as const) {
    it(`an upstream that ${status} taints its dependent`, () => {
      const isTainted = taintTracker(true)
      expect(isTainted(node('b'), [from('a', status)])).toBe(true)
    })
  }

  it('a successful upstream does not', () => {
    const isTainted = taintTracker(true)
    expect(isTainted(node('b'), [from('a', 'success')])).toBe(false)
    expect(isTainted(node('c'), [from('a', 'cache-hit')])).toBe(false)
  })

  it('the taint is TRANSITIVE: a grand-dependent of a failure is poisoned too', () => {
    // Without this the grand-dependent caches the same partial tree one hop
    // later, which is the comment's own reason for tracking at all.
    const isTainted = taintTracker(true)
    expect(isTainted(node('b'), [from('a', 'failed')])).toBe(true)
    expect(isTainted(node('c'), [from('b', 'success')])).toBe(true)
  })

  it('disabled unless the run is --continue=always: nothing is poison', () => {
    // The zero-cost gate for every other mode. Only `always` ever executes a
    // task behind a failure, so the other modes carry no check at all.
    const isTainted = taintTracker(false)
    expect(isTainted(node('b'), [from('a', 'failed')])).toBe(false)
    expect(isTainted(node('c'), [from('b', 'aborted')])).toBe(false)
  })
})
