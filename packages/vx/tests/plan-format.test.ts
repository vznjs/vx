import { cpuClock } from './helpers/cpu-clock.js'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { formatPlanJson, formatPlanText } from '../src/cli/plan-format.js'
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
    expect(formatPlanText({ tasks: [] }).split('\n').slice(1)).toEqual(['  No tasks planned.', ''])
  })

  it('hides group tasks and puts each real task on the run grid', () => {
    const plan: RunPlan = {
      tasks: [
        task('a#ci', 'group', 'aaaaaaaa11111111'),
        task('a#lint', 'hit-local', 'bbbbbbbb22222222'),
        task('a#test', 'hit-remote', 'cccccccc33333333'),
        task('a#build', 'miss', 'dddddddd44444444'),
      ],
    }
    const out = formatPlanText(plan)
    expect(out).toStartWith('─ Plan 3 ')
    expect(out).not.toContain('a#ci') // group hidden
    expect(out).toMatch(/ ⇢ +cached +local +0 local +a#lint\n/)
    expect(out).toMatch(/ ⇣ +cached +remote +0 local +a#test\n/)
    expect(out).toMatch(/ ⏺\uFE0E +— run +miss +0 local +a#build\n/)
    expect(out).toContain('3 planned')
    expect(out).toContain('2 cache hits (1 local, 1 remote)')
    expect(out).toContain('1 would run')
  })

  it('counts blocks in near-linear time: a 20,000 task chain renders at once', () => {
    // The count was a closure walked per task: quadratic, 30 s on this chain.
    const n = 20_000
    const tasks = Array.from({ length: n }, (_, i) =>
      task(`a#t${i}`, 'miss', 'dddddddd44444444', i === 0 ? [] : [`a#t${i - 1}`]),
    )
    const cpu = cpuClock()
    const out = formatPlanText({ tasks })
    expect(cpu()).toBeLessThan(5_000)
    expect(out).toMatch(/ 19999 local +a#t0\n/)
    expect(out).toMatch(/ 0 local +a#t19999\n/)
  })

  it('remote hits the remote sized say what restoring them downloads', () => {
    const out = formatPlanText({
      tasks: [
        { ...task('a#test', 'hit-remote', 'cccccccc33333333'), remoteBytes: 3 * 1024 * 1024 },
        { ...task('b#test', 'hit-remote', 'dddddddd44444444'), remoteBytes: 1024 * 1024 },
        task('c#test', 'hit-remote', 'eeeeeeee55555555'),
      ],
    })
    expect(out).toContain('3 cache hits (3 remote, 4.0 MB)')
    // Each remote hit's own size sits in its outputs cell.
    expect(out).toMatch(/cached +remote +3\.0MB +0 local +a#test\n/)
  })

  it('an @noop task is counted as noop, not as a would-run with a cost', () => {
    const out = formatPlanText({
      tasks: [
        { ...task('a#install', 'miss', '11111111', [], undefined, 5000), executor: 'noop' },
        task('a#build', 'miss', '22222222', ['a#install'], undefined, 1000),
      ],
    })
    expect(out).toMatch(/ · +noop +1 {14}a#install\n/)
    expect(out).toContain('2 planned · 1 would run · 1 noop\n')
  })

  it('handles all-miss plans without claiming any hits', () => {
    const out = formatPlanText({
      tasks: [task('a#x', 'miss', '11111111'), task('a#y', 'miss', '22222222')],
    })
    expect(out).toContain('2 planned · 2 would run\n')
    expect(out).not.toContain('cache hits')
  })

  it('one hit is a singular "cache hit"', () => {
    const out = formatPlanText({ tasks: [task('a#lint', 'hit-local', 'bbbbbbbb22222222')] })
    expect(out.split('\n')).toContain('  tasks     1 planned · 1 cache hit (1 local)')
  })

  it('names the first three eager refusals and counts the rest', () => {
    const refusals = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ taskId: `a#t${i}`, reason: `reason ${i}` }))
    const tail = (n: number) =>
      formatPlanText({
        tasks: [task('a#build', 'miss', 'dddddddd44444444')],
        downloadDowngrades: refusals(n),
      })
        .split('\n')
        .slice(-(n > 3 ? 6 : n + 2))
    expect(tail(5)).toEqual([
      '  download  0 task(s) would keep outputs remote, 5 kept eager:',
      '            a#t0 — reason 0',
      '            a#t1 — reason 1',
      '            a#t2 — reason 2',
      '            …and 2 more',
      '',
    ])
    // CONTROL: exactly three is the whole list, with no "more" line.
    expect(tail(3)).toEqual([
      '  download  0 task(s) would keep outputs remote, 3 kept eager:',
      '            a#t0 — reason 0',
      '            a#t1 — reason 1',
      '            a#t2 — reason 2',
      '',
    ])
  })

  it('shows task description after the id when present', () => {
    const out = formatPlanText({
      tasks: [task('a#lint', 'miss', '11111111', [], 'oxlint with type-aware checks')],
    })
    expect(out).toMatch(/ a#lint {2}oxlint with type-aware checks\n/)
  })

  it('a task with no description ends at its id', () => {
    const out = formatPlanText({
      tasks: [task('a#lint', 'miss', '11111111')],
    })
    // The rule, the header, the row, '', the counts, '' (trailing newline).
    expect(out.split('\n')).toHaveLength(6)
    expect(out).toMatch(/ a#lint\n/)
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
      predicted: { wallMs: 1500, workMs: 1500, unknownCount: 0, criticalPath: [] },
    }
    const out = formatPlanText(plan)
    expect(out).toContain('~1.2s')
    expect(out).toContain('~300ms')
    // The hit line carries no eta.
    const lintLine = out.split('\n').find((l) => l.includes('a#lint'))!
    expect(lintLine).not.toContain('~')
    // Every would-run task has history: the footer names no unknown count.
    expect(out.split('\n').find((l) => l.startsWith('  predicted'))).toBe(
      '  predicted  ~1.50s wall · ~1.50s total execution',
    )
  })

  it('counts would-run tasks never timed as unknown (+?): a failed run times nothing', () => {
    const plan: RunPlan = {
      tasks: [
        task('a#build', 'miss', 'bbbbbbbb22222222', [], undefined, 1200),
        task('a#fresh', 'miss', 'dddddddd44444444'),
      ],
      predicted: { wallMs: 1200, workMs: 1200, unknownCount: 1, criticalPath: [] },
    }
    const out = formatPlanText(plan)
    expect(out).toContain('predicted  ~1.20s wall')
    expect(out).toContain('1 task never timed (+?)')
    // Its usual cell is unknown, as a run's row says it, not blank.
    expect(out.split('\n').find((l) => l.endsWith(' a#fresh'))).toMatch(/^ \S+ +\u2014 run /)
  })

  it('omits the footer when EVERY would-run task is unknown (nothing to say)', () => {
    const plan: RunPlan = {
      tasks: [task('a#build', 'miss', 'bbbbbbbb22222222')],
      predicted: { wallMs: 0, workMs: 0, unknownCount: 1, criticalPath: [] },
    }
    expect(formatPlanText(plan)).not.toContain('predicted')
  })

  it('omits the footer on an all-hit plan (nothing would run)', () => {
    const plan: RunPlan = {
      tasks: [task('a#lint', 'hit-local', 'aaaaaaaa11111111', [], undefined, 900)],
      predicted: { wallMs: 0, workMs: 0, unknownCount: 0, criticalPath: [] },
    }
    expect(formatPlanText(plan)).not.toContain('predicted')
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
      predicted: { wallMs: 450, workMs: 450, unknownCount: 0, criticalPath: ['a#build'] },
    }
    const parsed = JSON.parse(formatPlanJson(plan)) as {
      tasks: Array<Record<string, unknown>>
      predicted?: Record<string, unknown>
    }
    expect(parsed.tasks[0]?.['p50Ms']).toBe(450)
    expect(parsed.predicted).toEqual({
      wallMs: 450,
      workMs: 450,
      unknownCount: 0,
      criticalPath: ['a#build'],
    })
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
    expect(out).toMatch(/ vx\/reapi +a#build\n/)
    expect(out).not.toMatch(/\bremote\b(?!.*cache)/)
  })

  it('a task with no placement runs here: its worker is `local`, as the run says', () => {
    const out = formatPlanText({ tasks: [placed('a#build')] })
    expect(out).toMatch(/ local +a#build\n/)
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
  // hides, a four-task plan summed as three, and a DOT document the
  // formatter never wrote (item 313,
  // 2026-09-16). Each sample is the formatter on the same fixture.
  const page = readFileSync(
    path.resolve(import.meta.dir, '..', 'docs', 'modules', 'plan-format.md'),
    'utf8',
  )
  const fenced = [...page.matchAll(/```(\w*)\n([\s\S]*?)```/g)].map((m) => ({
    lang: m[1]!,
    body: m[2]!,
  }))
  const texts = fenced.filter((b) => b.lang === '' && b.body.startsWith('─ Plan'))
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
    { remoteBytes: 12 * 1024 * 1024 },
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
      predicted: { wallMs: 4200, workMs: 4200, unknownCount: 1, criticalPath: [] },
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

  // The formatter lays a markdown JSON fence out over lines, so the sample
  // is compared as JSON; the printed form is one line (formatPlanJson's tests).
  it('the JSON sample is the lint task alone', () => {
    expect(JSON.parse(fenced.find((b) => b.lang === 'json')!.body)).toEqual(
      JSON.parse(formatPlanJson({ tasks: [lint] })),
    )
  })
})
