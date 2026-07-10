// The catalog ∪ analytics join helpers (cloud-data-model-2026-07 §4.1) —
// pinned because every entity list page routes its rows through them: the
// catalog must win identity fields, rollups must win analytics fields, and
// a missing catalog must pass the rollups through byte-untouched.

import { describe, expect, it } from 'bun:test'
import {
  FUNCTIONS,
  computeRecommendations,
  countTone,
  distinctBranches,
  filterInvocations,
  invocationPassed,
  passRateWithin,
  rateTone,
  runTicks,
  suggestedRetriesFor,
} from './functions.ts'

const joinProjects = FUNCTIONS['joinProjects']!
const joinTasks = FUNCTIONS['joinTasks']!
const withTaskRef = FUNCTIONS['withTaskRef']!
const withFlakyFix = FUNCTIONS['withFlakyFix']!

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

describe('suggestedRetriesFor', () => {
  it('confirmed-flaky → max(maxAttempts, 2)', () => {
    expect(suggestedRetriesFor({ flakyConfirmed: true, maxAttempts: 3 })).toBe(3)
    // maxAttempts below the floor still yields at least 2
    expect(suggestedRetriesFor({ flakyConfirmed: true, maxAttempts: 2 })).toBe(2)
    // missing maxAttempts defaults to the floor
    expect(suggestedRetriesFor({ flakyConfirmed: true, maxAttempts: undefined })).toBe(2)
  })

  it('inferred-only or missing → no suggestion', () => {
    expect(suggestedRetriesFor({ flakyConfirmed: false, maxAttempts: 4 })).toBeUndefined()
    expect(suggestedRetriesFor(null)).toBeUndefined()
    expect(suggestedRetriesFor(undefined)).toBeUndefined()
  })
})

describe('withFlakyFix', () => {
  it('confirmed rows get exec.retries: N, inferred rows get an empty cell', () => {
    const rows = withFlakyFix({
      arr: [
        { id: '@a/b#test', flakyConfirmed: true, maxAttempts: 3, withinRunRetries: 2 },
        { id: '@a/c#test', flakyConfirmed: false, failureRate: 0.2 },
      ],
    }) as Array<Record<string, unknown>>
    expect(rows[0]!.suggestedRetries).toBe(3)
    expect(rows[0]!.fixText).toBe('exec.retries: 3')
    // raw fields are preserved
    expect(rows[0]!.id).toBe('@a/b#test')
    expect(rows[1]!.suggestedRetries).toBeUndefined()
    expect(rows[1]!.fixText).toBe('')
  })
})

describe('computeRecommendations', () => {
  const confirmedFlaky = { flakyConfirmed: true, maxAttempts: 2, withinRunRetries: 3, p50DurationMs: 200 }
  const divergent = {
    taskId: '@a/b#build',
    crossPlatform: true,
    changed: ['dist/app.js', 'dist/app.js.map'],
    reports: [
      { os: 'linux', arch: 'x64' },
      { os: 'darwin', arch: 'arm64' },
    ],
  }

  it('confirmed flaky (no catalog) → an add-retries rec with an exec.retries snippet', () => {
    const recs = computeRecommendations({ flaky: confirmedFlaky, divergent: null, taskConfig: null, avgDurationMs: 200 })
    expect(recs).toHaveLength(1)
    expect(recs[0]!.kind).toBe('flaky-retries')
    expect(recs[0]!.snippet).toBe('exec: { retries: 2 }')
    expect(recs[0]!.detail).toContain('3 run(s)')
  })

  it('already declares retries >= N → the "still flaky" rec, no snippet', () => {
    const recs = computeRecommendations({
      flaky: confirmedFlaky,
      divergent: null,
      taskConfig: { exec: { command: 'x', retries: 3 } },
      avgDurationMs: 200,
    })
    expect(recs).toHaveLength(1)
    expect(recs[0]!.kind).toBe('flaky-persistent')
    expect(recs[0]!.snippet).toBeUndefined()
    expect(recs[0]!.detail).toContain('retries: 3')
  })

  it('declares FEWER retries than suggested → still recommends adding more', () => {
    const recs = computeRecommendations({
      flaky: { flakyConfirmed: true, maxAttempts: 4, withinRunRetries: 1 },
      divergent: null,
      taskConfig: { exec: { command: 'x', retries: 2 } },
      avgDurationMs: 50,
    })
    expect(recs[0]!.kind).toBe('flaky-retries')
    expect(recs[0]!.snippet).toBe('exec: { retries: 4 }')
  })

  it('non-hermetic task → a split-key rec naming platforms + rels', () => {
    const recs = computeRecommendations({ flaky: null, divergent, taskConfig: null, avgDurationMs: null })
    expect(recs).toHaveLength(1)
    expect(recs[0]!.kind).toBe('non-hermetic')
    expect(recs[0]!.snippet).toBe("cache.inputs.runtime: ['uname -sm']")
    expect(recs[0]!.detail).toContain('linux-x64 ⇄ darwin-arm64')
    expect(recs[0]!.detail).toContain('dist/app.js')
  })

  it('slow + uncached (catalog present, no cache block) → an add-caching rec', () => {
    const recs = computeRecommendations({
      flaky: null,
      divergent: null,
      taskConfig: { exec: { command: 'tsc' } },
      avgDurationMs: 4000,
    })
    expect(recs).toHaveLength(1)
    expect(recs[0]!.kind).toBe('uncached')
    expect(recs[0]!.snippet).toContain('cache:')
    expect(recs[0]!.detail).toContain('4.00s')
  })

  it('already cached, or fast, or no catalog → no uncached rec', () => {
    // has a cache block
    expect(
      computeRecommendations({ flaky: null, divergent: null, taskConfig: { cache: { inputs: {} } }, avgDurationMs: 9000 }),
    ).toHaveLength(0)
    // under the slow threshold
    expect(
      computeRecommendations({ flaky: null, divergent: null, taskConfig: { exec: {} }, avgDurationMs: 200 }),
    ).toHaveLength(0)
    // catalog unavailable → can't reason about caching
    expect(
      computeRecommendations({ flaky: null, divergent: null, taskConfig: null, avgDurationMs: 9000 }),
    ).toHaveLength(0)
  })

  it('healthy task → no recommendations', () => {
    expect(
      computeRecommendations({ flaky: null, divergent: null, taskConfig: { exec: {}, cache: {} }, avgDurationMs: 50 }),
    ).toHaveLength(0)
  })

  it('multiple signals stack (flaky + non-hermetic + uncached)', () => {
    const recs = computeRecommendations({
      flaky: confirmedFlaky,
      divergent,
      taskConfig: { exec: { command: 'build' } },
      avgDurationMs: 5000,
    })
    expect(recs.map((r) => r.kind)).toEqual(['flaky-retries', 'non-hermetic', 'uncached'])
  })
})

// --- Runs view: faceted filters + CI health ---------------------------------

describe('invocationPassed', () => {
  it('passes with no failures and a clean exit', () => {
    expect(invocationPassed({ failedCount: 0, exitOk: true })).toBe(true)
    // exitOk absent (not === false) still counts as passed
    expect(invocationPassed({ failedCount: 0 })).toBe(true)
  })
  it('fails on any failed task or a non-ok exit', () => {
    expect(invocationPassed({ failedCount: 1, exitOk: true })).toBe(false)
    expect(invocationPassed({ failedCount: 0, exitOk: false })).toBe(false)
  })
})

describe('filterInvocations', () => {
  const rows = [
    { runId: 'r1', branch: 'main', failedCount: 0, exitOk: true },
    { runId: 'r2', branch: 'main', failedCount: 2, exitOk: false },
    { runId: 'r3', branch: 'feature', failedCount: 0, exitOk: true },
  ]
  it('all + empty branch → passthrough', () => {
    expect(filterInvocations(rows, { result: 'all', branch: '' })).toHaveLength(3)
  })
  it('result=failed keeps only failing runs', () => {
    expect(filterInvocations(rows, { result: 'failed', branch: '' }).map((r) => r.runId)).toEqual(['r2'])
  })
  it('result=passed keeps only clean runs', () => {
    expect(filterInvocations(rows, { result: 'passed', branch: '' }).map((r) => r.runId)).toEqual(['r1', 'r3'])
  })
  it('branch narrows, and facets compose', () => {
    expect(filterInvocations(rows, { result: 'all', branch: 'feature' }).map((r) => r.runId)).toEqual(['r3'])
    expect(filterInvocations(rows, { result: 'passed', branch: 'main' }).map((r) => r.runId)).toEqual(['r1'])
  })
})

describe('distinctBranches', () => {
  it('dedupes + sorts, dropping empty/absent', () => {
    expect(
      distinctBranches([
        { branch: 'main' },
        { branch: 'feature' },
        { branch: 'main' },
        { branch: '' },
        { branch: null },
        {},
      ]),
    ).toEqual(['feature', 'main'])
  })
})

describe('runTicks', () => {
  const rows = [
    { runId: 'r3', failedCount: 1, exitOk: false, startedAt: 300, totalDurationMs: 30, requestedTasks: ['test'] },
    { runId: 'r2', failedCount: 0, exitOk: true, startedAt: 200, totalDurationMs: 20, requestedTasks: ['build', 'lint'] },
    { runId: 'r1', failedCount: 0, exitOk: true, startedAt: 100, totalDurationMs: 10, requestedTasks: ['ci'] },
  ]
  it('takes the last N and orders most-recent-LAST', () => {
    const t = runTicks(rows, 2)
    // newest two, reversed → r2 then r3 (r3 is newest, ends up on the right)
    expect(t.map((x) => x.runId)).toEqual(['r2', 'r3'])
    expect(t[1]!.ok).toBe(false)
    expect(t[1]!.label).toBe('test')
    expect(t[0]!.ok).toBe(true)
    expect(t[0]!.label).toBe('build lint')
  })
  it('handles fewer rows than requested', () => {
    expect(runTicks(rows, 10)).toHaveLength(3)
  })
})

describe('passRateWithin', () => {
  const now = 1_000_000
  const hour = 60 * 60 * 1000
  const rows = [
    { exitOk: true, failedCount: 0, startedAt: now - hour }, // in window, pass
    { exitOk: false, failedCount: 1, startedAt: now - 2 * hour }, // in window, fail
    { exitOk: true, failedCount: 0, startedAt: now - 48 * hour }, // out of window
  ]
  it('computes pass rate over the window only', () => {
    expect(passRateWithin(rows, 24 * hour, now)).toBe(0.5)
  })
  it('undefined when nothing falls in the window', () => {
    expect(passRateWithin(rows, hour / 2, now)).toBeUndefined()
    expect(passRateWithin([], 24 * hour, now)).toBeUndefined()
  })
})

describe('rateTone / countTone', () => {
  it('rateTone buckets a higher-is-better rate', () => {
    expect(rateTone(0.95, 0.9, 0.7)).toBe('good')
    expect(rateTone(0.8, 0.9, 0.7)).toBe('warn')
    expect(rateTone(0.5, 0.9, 0.7)).toBe('bad')
  })
  it('countTone: 0 is good, then warn, then bad at the threshold', () => {
    expect(countTone(0)).toBe('good')
    expect(countTone(1)).toBe('warn')
    expect(countTone(3)).toBe('bad')
    // any divergence is bad when badAt=1
    expect(countTone(1, 1)).toBe('bad')
    expect(countTone(0, 1)).toBe('good')
  })
})
