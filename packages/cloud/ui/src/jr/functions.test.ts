// The catalog ∪ analytics join helpers (cloud-data-model-2026-07 §4.1) —
// pinned because every entity list page routes its rows through them: the
// catalog must win identity fields, rollups must win analytics fields, and
// a missing catalog must pass the rollups through byte-untouched.

import { describe, expect, it } from 'bun:test'
import { FUNCTIONS } from './functions.ts'

const joinProjects = FUNCTIONS['joinProjects']!
const joinTasks = FUNCTIONS['joinTasks']!
const withTaskRef = FUNCTIONS['withTaskRef']!

describe('joinProjects', () => {
  const rollups = [
    { project: '@acme/app', taskCount: 1, runs: 12, failures: 2, totalDurationMs: 500 },
    { project: '@acme/gone', taskCount: 2, runs: 3, failures: 0, totalDurationMs: 90 },
  ]
  const catalog = {
    source: 'lock',
    staleProjects: ['@acme/app'],
    projects: [
      { name: '@acme/app', dir: 'packages/app', taskCount: 4, tasks: ['build', 'test', 'lint', 'dev'] },
      { name: '@acme/lib', dir: 'packages/lib', taskCount: 2, tasks: ['build', 'test'] },
    ],
  }

  it('no catalog → rollups pass through untouched (remote-serve behavior)', () => {
    expect(joinProjects({ rollups, catalog: null })).toBe(rollups)
    expect(joinProjects({ rollups, catalog: undefined })).toBe(rollups)
  })

  it('catalog wins identity fields, rollup wins analytics fields', () => {
    const rows = joinProjects({ rollups, catalog }) as Array<Record<string, unknown>>
    const app = rows.find((r) => r.project === '@acme/app')!
    expect(app.taskCount).toBe(4) // catalog's TRUE count, not history's 1
    expect(app.dir).toBe('packages/app')
    expect(app.runs).toBe(12)
    expect(app.failures).toBe(2)
    expect(app._stale).toBe(true)
  })

  it('never-run catalog projects appear with zeroed analytics', () => {
    const rows = joinProjects({ rollups, catalog }) as Array<Record<string, unknown>>
    const lib = rows.find((r) => r.project === '@acme/lib')!
    expect(lib.runs).toBe(0)
    expect(lib.totalDurationMs).toBe(0)
    expect(lib._stale).toBe(false)
  })

  it('history-only projects (renamed/removed) are kept', () => {
    const rows = joinProjects({ rollups, catalog }) as Array<Record<string, unknown>>
    expect(rows.some((r) => r.project === '@acme/gone')).toBe(true)
    expect(rows).toHaveLength(3)
  })
})

describe('joinTasks', () => {
  const history = [
    { id: '@acme/app#build', project: '@acme/app', task: 'build', runs: 9, failureMode: 'flaky-recoverable', totalDurationMs: 400 },
    { id: '@acme/gone#x', project: '@acme/gone', task: 'x', runs: 1, totalDurationMs: 10 },
  ]
  const catalog = {
    source: 'live',
    tasks: [
      { id: '@acme/app#build', project: '@acme/app', task: 'build', group: false, cacheable: true, persistent: false },
      { id: '@acme/app#ci', project: '@acme/app', task: 'ci', group: true, cacheable: false, persistent: false },
      { id: '@acme/app#dev', project: '@acme/app', task: 'dev', group: false, cacheable: false, persistent: true },
    ],
  }

  it('no catalog → history passes through untouched', () => {
    expect(joinTasks({ history, catalog: null })).toBe(history)
  })

  it('history aggregates survive the join; derived kind is attached', () => {
    const rows = joinTasks({ history, catalog }) as Array<Record<string, unknown>>
    const build = rows.find((r) => r.id === '@acme/app#build')!
    expect(build.runs).toBe(9)
    expect(build.failureMode).toBe('flaky-recoverable')
    expect(build._kind).toBe('cacheable')
  })

  it('never-run tasks get zero-run defaults and a neutral failureMode', () => {
    const rows = joinTasks({ history, catalog }) as Array<Record<string, unknown>>
    const ci = rows.find((r) => r.id === '@acme/app#ci')!
    expect(ci.runs).toBe(0)
    expect(ci.failureMode).toBe('stable')
    expect(ci._kind).toBe('group')
    const dev = rows.find((r) => r.id === '@acme/app#dev')!
    expect(dev._kind).toBe('persistent')
  })

  it('history-only tasks are kept', () => {
    const rows = joinTasks({ history, catalog }) as Array<Record<string, unknown>>
    expect(rows.some((r) => r.id === '@acme/gone#x')).toBe(true)
    expect(rows).toHaveLength(4)
  })
})

describe('withTaskRef', () => {
  it('annotates rows with the raw project#task ref for ?task= deep links', () => {
    const rows = withTaskRef({ arr: [{ project: '@a/b', task: 'test', runId: 'r1' }] }) as Array<
      Record<string, unknown>
    >
    expect(rows[0]!._taskRef).toBe('@a/b#test')
  })
})
