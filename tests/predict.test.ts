import { describe, expect, it } from 'bun:test'
import type { TaskNode } from '../src/graph/index.js'
import {
  computePredictedPriorities,
  type HistoryTable,
  type TaskHistory,
} from '../src/orchestrator/index.js'

function node(id: string, deps: string[] = []): TaskNode {
  const [projectName, taskName] = id.split('#') as [string, string]
  return {
    id,
    projectName,
    projectDir: '/ws/' + projectName,
    taskName,
    config: { exec: { command: 'echo' } } as TaskNode['config'],
    deps,
    requested: false,
  }
}

function hist(p50: number, runs = 5): TaskHistory {
  return {
    runs,
    p50DurationMs: p50,
    p99DurationMs: p50 * 2,
    successRate: 1,
    hitRate: 0,
    failureMode: 'stable',
  }
}

describe('computePredictedPriorities', () => {
  it('a leaf node gets its own p50 as priority', () => {
    const history: HistoryTable = new Map([['pkg#test', hist(2000)]])
    const out = computePredictedPriorities([node('pkg#test')], history)
    expect(out.get('pkg#test')).toBe(2000)
  })

  it('a node with dependents folds the max downstream chain', () => {
    const nodes = [
      node('pkg#build'),
      node('pkg#test', ['pkg#build']),
      node('pkg#publish', ['pkg#test']),
    ]
    const history: HistoryTable = new Map([
      ['pkg#build', hist(100)],
      ['pkg#test', hist(2000)],
      ['pkg#publish', hist(50)],
    ])
    const out = computePredictedPriorities(nodes, history)
    expect(out.get('pkg#publish')).toBe(50)
    expect(out.get('pkg#test')).toBe(2050)
    expect(out.get('pkg#build')).toBe(2150)
  })

  it('falls back to workspace median when a node has no history', () => {
    const nodes = [node('pkg#known'), node('pkg#unknown')]
    const history: HistoryTable = new Map([['pkg#known', hist(500)]])
    const out = computePredictedPriorities(nodes, history)
    expect(out.get('pkg#unknown')).toBe(500)
  })

  it('falls back to default duration when history is entirely empty', () => {
    const out = computePredictedPriorities([node('pkg#anything')], new Map())
    expect(out.get('pkg#anything')).toBe(1000)
  })

  it('prefers the slowest downstream chain when there are siblings', () => {
    const nodes = [
      node('pkg#root'),
      node('pkg#fast', ['pkg#root']),
      node('pkg#slow', ['pkg#root']),
    ]
    const history: HistoryTable = new Map([
      ['pkg#root', hist(100)],
      ['pkg#fast', hist(50)],
      ['pkg#slow', hist(5000)],
    ])
    const out = computePredictedPriorities(nodes, history)
    expect(out.get('pkg#root')).toBe(5100)
  })
})
