import { describe, expect, it } from 'bun:test'
import { formatGraphDot, formatPlanJson, formatPlanText } from '../src/cli/plan-format.js'
import type { CacheStatus, PlannedTask, RunPlan } from '../src/orchestrator/plan.js'
import type { TaskNode } from '../src/graph/task-graph.js'

function task(
  id: string,
  status: CacheStatus,
  hash: string,
  deps: readonly string[] = [],
  description?: string,
  p50Ms?: number,
): PlannedTask {
  return {
    node: {
      id,
      projectName: id.split('#')[0] ?? '',
      taskName: id.split('#')[1] ?? '',
      config: description !== undefined ? { description } : {},
    } as TaskNode,
    hash,
    cacheStatus: status,
    deps,
    ...(p50Ms !== undefined ? { p50Ms } : {}),
  }
}

describe('formatPlanText', () => {
  it('renders empty plan with a clear message', () => {
    expect(formatPlanText({ tasks: [] })).toBe('No tasks planned.\n')
  })

  it('hides group tasks and lines up each real task with status + short hash', () => {
    const plan: RunPlan = {
      tasks: [
        task('a#ci', 'group', 'aaaaaaaa11111111'),
        task('a#lint', 'hit-local', 'bbbbbbbb22222222'),
        task('a#test', 'hit-remote', 'cccccccc33333333'),
        task('a#build', 'miss', 'dddddddd44444444'),
      ],
    }
    const out = formatPlanText(plan)
    expect(out).toContain('would run:')
    expect(out).not.toContain('a#ci') // group hidden
    expect(out).toContain('a#lint')
    expect(out).toContain('cache hit (local)')
    expect(out).toContain('bbbbbbbb')
    expect(out).toContain('cache hit (remote)')
    expect(out).toContain('cache miss — would exec')
    expect(out).toMatch(/3 task\(s\) planned/)
    expect(out).toContain('2 cache hits (1 local, 1 remote)')
    expect(out).toContain('1 would run')
  })

  it('handles all-miss plans without claiming any hits', () => {
    const out = formatPlanText({
      tasks: [task('a#x', 'miss', '11111111'), task('a#y', 'miss', '22222222')],
    })
    expect(out).toMatch(/2 task\(s\) planned, 2 would run\./)
    expect(out).not.toContain('cache hits')
  })

  it('shows task description below the id line when present', () => {
    const out = formatPlanText({
      tasks: [task('a#lint', 'miss', '11111111', [], 'oxlint with type-aware checks')],
    })
    expect(out).toContain('a#lint')
    expect(out).toContain('oxlint with type-aware checks')
  })

  it('omits the description row when undefined (no blank gap)', () => {
    const out = formatPlanText({
      tasks: [task('a#lint', 'miss', '11111111')],
    })
    const lines = out.split('\n')
    // 'would run:', task line, '', summary, '' (trailing newline)
    expect(lines).toHaveLength(5)
  })
})

describe('formatPlanText — time prediction', () => {
  it('shows ~p50 on would-run tasks and the predicted footer', () => {
    const plan: RunPlan = {
      tasks: [
        // A hit with history shows NO eta (it will restore, not execute).
        task('a#lint', 'hit-local', 'aaaaaaaa11111111', [], undefined, 900),
        task('a#build', 'miss', 'bbbbbbbb22222222', [], undefined, 1200),
        task('a#dev', 'no-cache', 'cccccccc33333333', [], undefined, 300),
      ],
      predicted: { wallMs: 1500, workMs: 1500, unknownCount: 0 },
    }
    const out = formatPlanText(plan)
    expect(out).toContain('~1.20s')
    expect(out).toContain('~300ms')
    // The hit line carries no eta.
    const lintLine = out.split('\n').find((l) => l.includes('a#lint'))!
    expect(lintLine).not.toContain('~')
    expect(out).toContain('predicted: ~1.50s wall · ~1.50s total execution')
  })

  it('counts would-run tasks without history as unknown (+?)', () => {
    const plan: RunPlan = {
      tasks: [
        task('a#build', 'miss', 'bbbbbbbb22222222', [], undefined, 1200),
        task('a#fresh', 'miss', 'dddddddd44444444'),
      ],
      predicted: { wallMs: 1200, workMs: 1200, unknownCount: 1 },
    }
    const out = formatPlanText(plan)
    expect(out).toContain('predicted: ~1.20s wall')
    expect(out).toContain('1 task without history (+?)')
  })

  it('omits the footer when EVERY would-run task is unknown (nothing to say)', () => {
    const plan: RunPlan = {
      tasks: [task('a#build', 'miss', 'bbbbbbbb22222222')],
      predicted: { wallMs: 0, workMs: 0, unknownCount: 1 },
    }
    expect(formatPlanText(plan)).not.toContain('predicted:')
  })

  it('omits the footer on an all-hit plan (nothing would run)', () => {
    const plan: RunPlan = {
      tasks: [task('a#lint', 'hit-local', 'aaaaaaaa11111111', [], undefined, 900)],
      predicted: { wallMs: 0, workMs: 0, unknownCount: 0 },
    }
    expect(formatPlanText(plan)).not.toContain('predicted:')
  })
})

describe('formatPlanJson', () => {
  it('emits a parseable JSON object with all planning fields', () => {
    const plan: RunPlan = {
      tasks: [
        task('a#build', 'hit-local', 'aaaaaaaa', []),
        task('a#test', 'miss', 'bbbbbbbb', ['a#build']),
      ],
    }
    const out = formatPlanJson(plan)
    expect(out.endsWith('\n')).toBe(true)
    const parsed = JSON.parse(out) as { tasks: Array<Record<string, unknown>> }
    expect(parsed.tasks).toHaveLength(2)
    expect(parsed.tasks[0]).toEqual({
      id: 'a#build',
      project: 'a',
      task: 'build',
      hash: 'aaaaaaaa',
      cacheStatus: 'hit-local',
      deps: [],
    })
    expect(parsed.tasks[1]?.deps).toEqual(['a#build'])
  })

  it('carries p50Ms per task + the predicted object when present', () => {
    const plan: RunPlan = {
      tasks: [task('a#test', 'miss', 'bbbbbbbb', [], undefined, 450)],
      predicted: { wallMs: 450, workMs: 450, unknownCount: 0 },
    }
    const parsed = JSON.parse(formatPlanJson(plan)) as {
      tasks: Array<Record<string, unknown>>
      predicted?: Record<string, unknown>
    }
    expect(parsed.tasks[0]?.['p50Ms']).toBe(450)
    expect(parsed.predicted).toEqual({ wallMs: 450, workMs: 450, unknownCount: 0 })
  })
})

describe('formatGraphDot', () => {
  it('emits a valid digraph with edges + per-status fillcolor', () => {
    const plan: RunPlan = {
      tasks: [
        task('a#build', 'miss', 'aaaaaaaa', []),
        task('a#test', 'hit-local', 'bbbbbbbb', ['a#build']),
      ],
    }
    const out = formatGraphDot(plan)
    expect(out.startsWith('digraph TaskGraph {')).toBe(true)
    expect(out.trimEnd().endsWith('}')).toBe(true)
    expect(out).toContain('"a#build" -> "a#test";')
    expect(out).toContain('"a#build"')
    expect(out).toContain('label="a#build\\naaaaaaaa"')
    // miss → orange, hit-local → green.
    expect(out).toContain('fillcolor="#fed7aa"')
    expect(out).toContain('fillcolor="#bbf7d0"')
  })

  it('includes group nodes so the rendered graph still shows them', () => {
    const plan: RunPlan = {
      tasks: [
        task('a#build', 'miss', 'aaaaaaaa', []),
        task('a#ci', 'group', 'cccccccc', ['a#build']),
      ],
    }
    const out = formatGraphDot(plan)
    expect(out).toContain('"a#ci"')
    expect(out).toContain('"a#build" -> "a#ci";')
    // group → fuchsia
    expect(out).toContain('fillcolor="#f5d0fe"')
  })
})
