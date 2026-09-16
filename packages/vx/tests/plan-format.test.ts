import { readFileSync } from 'node:fs'
import path from 'node:path'
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
  // A task name is any object key in a config, so a quote, a backslash or a
  // newline reaches the DOT writer. Turbo pins the HTML variant of this
  // (`test_graph_to_html_escapes_task_names`); vx shipped the unescaped
  // form twice in sibling formatters. Every quoted ID must close where the
  // writer meant it to: one statement per line, balanced quotes.
  it('escapes quotes, backslashes and newlines in task ids and labels', () => {
    const wild = 'a#say "hi"\\now\nthen'
    const plan: RunPlan = {
      tasks: [task('a#build', 'miss', 'aaaaaaaa', []), task(wild, 'miss', 'bbbbbbbb', ['a#build'])],
    }
    const out = formatGraphDot(plan)
    const quoted = /"((?:[^"\\]|\\.)*)"/g
    for (const line of out.split('\n')) {
      // Strip every well-formed quoted ID; a stray `"` left behind is one the
      // writer failed to escape.
      expect(line.replace(quoted, '')).not.toContain('"')
      expect(line.includes('\n')).toBe(false)
    }
    expect(out).toContain('"a#say \\"hi\\"\\\\now\\nthen"')
    expect(out).toContain('"a#build" -> "a#say \\"hi\\"\\\\now\\nthen";')
  })

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

describe('placement in the plan', () => {
  // `exec.remote` is otherwise invisible: nothing in a run's output tells a
  // user which executor a task landed on, so a mis-declared pin reads exactly
  // like a correct one. `--dry` is where that becomes checkable.
  const placed = (id: string, executor?: string): PlannedTask => ({
    ...task(id, 'miss', 'abcdef1234'),
    ...(executor !== undefined ? { executor } : {}),
  })

  it('text shows the executor NAME, not a local/remote word', () => {
    // The summary line spends "local" and "remote" on the CACHE tier
    // ("2 cache hits (1 local, 1 remote)"). Reusing those words for
    // placement would make a line ambiguous between two vocabularies.
    const out = formatPlanText({ tasks: [placed('a#build', 'vx/reapi')] })
    expect(out).toContain('@vx/reapi')
    expect(out).not.toMatch(/\bremote\b(?!.*cache)/)
  })

  it('text omits the label entirely when the task carries no placement', () => {
    // The single-executor case: every line would say the same thing, so
    // `planRun` attaches nothing and the output is byte-identical to before
    // placement existed.
    const out = formatPlanText({ tasks: [placed('a#build')] })
    expect(out).not.toContain('@')
  })

  it('json carries the executor as a field, omitted when absent', () => {
    const withIt = JSON.parse(formatPlanJson({ tasks: [placed('a#build', 'vx/reapi')] })) as {
      tasks: Array<Record<string, unknown>>
    }
    expect(withIt.tasks[0]!['executor']).toBe('vx/reapi')
    const without = JSON.parse(formatPlanJson({ tasks: [placed('a#build')] })) as {
      tasks: Array<Record<string, unknown>>
    }
    expect(without.tasks[0]).not.toHaveProperty('executor')
  })
})

describe('docs/modules/plan-format.md shows what the formatters print', () => {
  // The page showed a "no-cache — opts out" row, a group row the text form
  // hides, a four-task plan summed as three, and a DOT document with a
  // header, colours and labels the formatter never wrote (item 313,
  // 2026-09-16). Each sample is the formatter on the same fixture.
  const page = readFileSync(
    path.resolve(import.meta.dir, '..', 'docs', 'modules', 'plan-format.md'),
    'utf8',
  )
  const fenced = [...page.matchAll(/```(\w*)\n([\s\S]*?)```/g)].map((m) => ({
    lang: m[1]!,
    body: m[2]!,
  }))
  const texts = fenced.filter((b) => b.lang === '' && b.body.startsWith('would run:'))
  const planned = (
    id: string,
    hash: string,
    cacheStatus: CacheStatus,
    deps: string[] = [],
    extra: Partial<PlannedTask> = {},
    description?: string,
  ): PlannedTask => ({
    node: {
      id,
      projectName: id.split('#')[0]!,
      taskName: id.split('#')[1]!,
      config: description === undefined ? {} : { description },
    } as unknown as TaskNode,
    hash,
    cacheStatus,
    deps,
    ...extra,
  })
  const lint = planned(
    '@vzn/vx#lint',
    'd66cfed2a1b2c3d4',
    'hit-remote',
    [],
    {},
    'oxlint with tsgolint-backed type-aware checks',
  )

  it('the first text sample is a five-task plan with a description, a p50 and a group', () => {
    const plan: RunPlan = {
      tasks: [
        planned('@vzn/vx#format-check', '02bfe8a9d1c2b3a4', 'hit-local'),
        lint,
        planned('@vzn/vx#test', '68595e49f0e1d2c3', 'miss', ['@vzn/vx#lint'], { p50Ms: 4200 }),
        planned('@vzn/vx#dev', 'c0ffee0012345678', 'no-cache'),
        planned('@vzn/vx#ci', '9a8b7c6d5e4f3a2b', 'group', [
          '@vzn/vx#format-check',
          '@vzn/vx#lint',
          '@vzn/vx#test',
        ]),
      ],
      predicted: { wallMs: 4200, workMs: 4200, unknownCount: 1 },
    }
    expect(texts[0]!.body).toBe(formatPlanText(plan))
  })

  it('the placement sample is two misses on named executors', () => {
    const plan: RunPlan = {
      tasks: [
        planned('@vzn/vx#test', '68595e49f0e1d2c3', 'miss', [], {
          p50Ms: 4200,
          executor: 'vx/reapi',
        }),
        planned('@vzn/vx#docker', '1a0c33fe00112233', 'miss', [], { executor: 'local' }),
      ],
    }
    expect(texts[1]!.body).toBe(formatPlanText(plan))
  })

  it('the JSON sample is the lint task alone', () => {
    expect(fenced.find((b) => b.lang === 'json')!.body).toBe(formatPlanJson({ tasks: [lint] }))
  })

  it('the DOT sample is lint and a test that depends on it', () => {
    const plan: RunPlan = {
      tasks: [lint, planned('@vzn/vx#test', '68595e49f0e1d2c3', 'miss', ['@vzn/vx#lint'])],
    }
    expect(fenced.find((b) => b.lang === 'dot')!.body).toBe(formatGraphDot(plan))
  })
})
