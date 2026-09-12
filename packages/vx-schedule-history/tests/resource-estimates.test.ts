// The estimator behind the plugin's `graph` hook: what a task should
// reserve, from what its executions used. Pure over the history table the
// scheduler already reads; the pins here are the rounding, the headroom,
// the thresholds, the packing rule and the one rule that matters most — a
// declared reservation is never overridden.
import { describe, expect, it } from 'bun:test'
import type { HistoryTable, TaskHistory, TaskNode } from '@vzn/vx'
import { admits, resourceEstimates, withDeclared } from '../src/index.js'

const MB = 1024 * 1024

function node(id: string, exec: TaskNode['config']['exec'] | null = { command: 'echo' }): TaskNode {
  const [projectName, taskName] = id.split('#') as [string, string]
  return {
    id,
    projectName,
    projectDir: '/ws/' + projectName,
    taskName,
    config: (exec === null ? {} : { exec }) as TaskNode['config'],
    deps: [],
    requested: false,
  }
}

function hist(extra: Partial<TaskHistory>): TaskHistory {
  return {
    runs: 3,
    p50DurationMs: 1000,
    p99DurationMs: 2000,
    successRate: 1,
    hitRate: 0,
    failureMode: 'stable',
    ...extra,
  }
}

function table(entries: Record<string, TaskHistory>): HistoryTable {
  return new Map(Object.entries(entries))
}

describe('resourceEstimates', () => {
  it('memory is the largest peak RSS times the headroom, rounded UP to 64 MB', () => {
    // 300 MB × 1.25 = 375 MB → 384 MB. Rounding up, never down: the
    // reservation is a floor under the OOM killer, and a step keeps a
    // jittery RSS from re-keying the packing every run.
    const nodes = new Map([['a#build', node('a#build')]])
    const est = resourceEstimates(nodes, table({ 'a#build': hist({ maxPeakRssBytes: 300 * MB }) }))
    expect(est.get('a#build')).toEqual({ memory: 384 })
  })

  it('the headroom is the caller’s', () => {
    const nodes = new Map([['a#build', node('a#build')]])
    const est = resourceEstimates(
      nodes,
      table({ 'a#build': hist({ maxPeakRssBytes: 300 * MB }) }),
      2,
    )
    expect(est.get('a#build')).toEqual({ memory: 640 })
  })

  it('cpus is the parallelism seen, rounded, and omitted at one core', () => {
    // A worker slot already is one core; reserving it would double-count.
    const nodes = new Map([
      ['one#build', node('one#build')],
      ['two#build', node('two#build')],
      ['four#build', node('four#build')],
    ])
    const est = resourceEstimates(
      nodes,
      table({
        'one#build': hist({ maxCpuParallelism: 1.4 }),
        'two#build': hist({ maxCpuParallelism: 1.6 }),
        'four#build': hist({ maxCpuParallelism: 3.7 }),
      }),
    )
    expect(est.has('one#build')).toBe(false)
    expect(est.get('two#build')).toEqual({ cpus: 2 })
    expect(est.get('four#build')).toEqual({ cpus: 4 })
  })

  it('a task with no execution in the window, or usage under a step, gets nothing', () => {
    // Nothing to pack: the task is admitted freely, exactly as with no
    // plugin. An entry with an empty estimate would still flip the
    // scheduler into its resource path for no reason.
    const nodes = new Map([
      ['cold#build', node('cold#build')],
      ['tiny#build', node('tiny#build')],
    ])
    const est = resourceEstimates(
      nodes,
      table({ 'tiny#build': hist({ maxPeakRssBytes: 20 * MB }) }),
    )
    expect(est.size).toBe(0)
  })
})

describe('admits — the packing rule the admit hook applies', () => {
  const budgets = { cpus: 4, memory: 1024 }
  const res = (entries: Record<string, { cpus?: number; memory?: number }>) =>
    new Map(Object.entries(entries))

  it('a task reserving nothing is admitted whatever runs', () => {
    expect(admits('free#build', ['a#build'], res({ 'a#build': { memory: 1024 } }), budgets)).toBe(
      true,
    )
  })

  it('a task within the budget needs the headroom left by what runs', () => {
    const r = res({
      'a#build': { memory: 640 },
      'b#build': { memory: 384 },
      'c#build': { memory: 385 },
    })
    expect(admits('b#build', ['a#build'], r, budgets)).toBe(true)
    expect(admits('c#build', ['a#build'], r, budgets)).toBe(false)
  })

  it('a task over the whole budget runs alone, from idle', () => {
    const r = res({ 'big#build': { memory: 4096 }, 'a#build': { memory: 64 } })
    expect(admits('big#build', [], r, budgets)).toBe(true)
    expect(admits('big#build', ['a#build'], r, budgets)).toBe(false)
  })

  it('cpus pack the same way against the worker count', () => {
    const r = res({ 'a#build': { cpus: 3 }, 'b#build': { cpus: 2 }, 'c#build': { cpus: 1 } })
    expect(admits('b#build', ['a#build'], r, budgets)).toBe(false)
    expect(admits('c#build', ['a#build'], r, budgets)).toBe(true)
  })

  it('a running task with no reservation holds nothing', () => {
    const r = res({ 'b#build': { memory: 1024 } })
    expect(admits('b#build', ['unknown#build'], r, budgets)).toBe(true)
  })
})

describe('withDeclared', () => {
  it('a declared reservation wins over a learned one, even a smaller one', () => {
    // The developer said 128; history says 2 GB. The declaration is the
    // contract, and the mismatch is theirs to see and fix.
    const merged = withDeclared(new Map([['a#build', { memory: 2048 }]]), {
      'a#build': { memory: 128 },
    })
    expect(merged.get('a#build')).toEqual({ memory: 128 })
  })

  it('declared reservations reach tasks the history never saw', () => {
    const merged = withDeclared(new Map(), { 'cold#build': { cpus: 2 } })
    expect(merged.get('cold#build')).toEqual({ cpus: 2 })
  })
})
