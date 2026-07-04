// The bounded per-run log capture primitive: per-task tail cap, per-run
// budget with failed-tails prioritized over success, cache-hit drop, and
// the drain ordering (failures first).

import { describe, expect, it } from 'bun:test'
import {
  LOG_WIRE_VERSION,
  RUN_LOG_BUDGET_CHARS,
  TASK_LOG_TAIL_CHARS,
  TaskLogBuffer,
} from '../src/task-log-capture.js'

function entry(bundle: ReturnType<TaskLogBuffer['drain']>, taskId: string) {
  return bundle.tasks.find((t) => t.taskId === taskId)
}

describe('TaskLogBuffer — per-task tail cap', () => {
  it('retains the last TASK_LOG_TAIL_CHARS across many chunks, dropping the head', () => {
    const buf = new TaskLogBuffer()
    // 200 chunks of 1 KiB = ~200 KiB, over the 128 KiB tail cap.
    for (let i = 0; i < 200; i++) buf.append('p#a', String.fromCharCode(65 + (i % 26)).repeat(1024))
    buf.finish('p#a', 'success', 'miss')
    const e = entry(buf.drain('r', 'ws'), 'p#a')!
    expect(e.charsFull).toBe(200 * 1024)
    expect(e.content.length).toBeLessThanOrEqual(TASK_LOG_TAIL_CHARS)
    expect(e.content.length).toBeGreaterThan(TASK_LOG_TAIL_CHARS - 1024) // whole-chunk eviction
    expect(e.truncatedHeadChars).toBe(200 * 1024 - e.content.length)
    // The tail is preserved: the last chunk's char is the final content char.
    expect(e.content.at(-1)).toBe(String.fromCharCode(65 + (199 % 26)))
  })

  it('slices a single over-cap chunk to its tail', () => {
    const buf = new TaskLogBuffer()
    const big = 'x'.repeat(TASK_LOG_TAIL_CHARS) + 'TAIL'
    buf.append('p#a', big)
    buf.finish('p#a', 'failed', 'miss')
    const e = entry(buf.drain('r', 'ws'), 'p#a')!
    expect(e.content.length).toBe(TASK_LOG_TAIL_CHARS)
    expect(e.content.endsWith('TAIL')).toBe(true)
    expect(e.truncatedHeadChars).toBe(4)
  })

  it('merges stdout+stderr in arrival order', () => {
    const buf = new TaskLogBuffer()
    buf.append('p#a', 'out1\n')
    buf.append('p#a', 'err1\n')
    buf.append('p#a', 'out2\n')
    buf.finish('p#a', 'success', 'miss')
    expect(entry(buf.drain('r', 'ws'), 'p#a')!.content).toBe('out1\nerr1\nout2\n')
  })
})

describe('TaskLogBuffer — retention decisions', () => {
  it('DROPS a cache-hit (any non-miss source) — hits resolve by hash', () => {
    const buf = new TaskLogBuffer()
    buf.append('p#a', 'replayed stdout')
    buf.finish('p#a', 'cache-hit', 'local', 'hash-a')
    buf.append('p#b', 'remote replay')
    buf.finish('p#b', 'cache-hit-remote', 'remote', 'hash-b')
    expect(buf.size()).toBe(0)
    expect(buf.drain('r', 'ws').tasks).toEqual([])
  })

  it('DROPS skipped / aborted tasks', () => {
    const buf = new TaskLogBuffer()
    buf.append('p#a', 'partial')
    buf.finish('p#a', 'skipped', 'none')
    buf.append('p#b', 'torn down')
    buf.finish('p#b', 'aborted', 'none')
    expect(buf.size()).toBe(0)
  })

  it('RETAINS success + failed misses, carries the hash', () => {
    const buf = new TaskLogBuffer()
    buf.append('p#ok', 'built')
    buf.finish('p#ok', 'success', 'miss', 'hash-ok')
    buf.append('p#bad', 'boom')
    buf.finish('p#bad', 'failed', 'miss')
    const bundle = buf.drain('r', 'ws')
    expect(entry(bundle, 'p#ok')!.hash).toBe('hash-ok')
    expect(entry(bundle, 'p#bad')!.hash).toBeUndefined()
  })
})

describe('TaskLogBuffer — run budget with failure priority', () => {
  it('evicts oldest SUCCESS tails first when over budget; failures survive', () => {
    const buf = new TaskLogBuffer()
    const chunk = 'x'.repeat(TASK_LOG_TAIL_CHARS) // 128 KiB each (already tail-sized)
    // ~40 successes ≈ 5 MiB > 4 MiB budget, plus one failure.
    for (let i = 0; i < 40; i++) {
      buf.append(`p#s${i}`, chunk)
      buf.finish(`p#s${i}`, 'success', 'miss')
    }
    buf.append('p#fail', chunk)
    buf.finish('p#fail', 'failed', 'miss')

    const bundle = buf.drain('r', 'ws')
    // The failure is never evicted by successes.
    expect(entry(bundle, 'p#fail')).toBeDefined()
    // The oldest success (s0) is gone; a recent one survives.
    expect(entry(bundle, 'p#s0')).toBeUndefined()
    expect(entry(bundle, 'p#s39')).toBeDefined()
    // Total retained stays within budget.
    const total = bundle.tasks.reduce((n, t) => n + t.content.length, 0)
    expect(total).toBeLessThanOrEqual(RUN_LOG_BUDGET_CHARS)
  })

  it('evicts oldest failures only when failures ALONE exceed the budget', () => {
    const buf = new TaskLogBuffer()
    const chunk = 'x'.repeat(TASK_LOG_TAIL_CHARS)
    for (let i = 0; i < 40; i++) {
      buf.append(`p#f${i}`, chunk)
      buf.finish(`p#f${i}`, 'failed', 'miss')
    }
    const bundle = buf.drain('r', 'ws')
    const total = bundle.tasks.reduce((n, t) => n + t.content.length, 0)
    expect(total).toBeLessThanOrEqual(RUN_LOG_BUDGET_CHARS)
    // Oldest failure evicted, newest kept — failures fall to newer failures only.
    expect(entry(bundle, 'p#f0')).toBeUndefined()
    expect(entry(bundle, 'p#f39')).toBeDefined()
  })
})

describe('TaskLogBuffer — drain', () => {
  it('orders failures before successes and stamps the wire version', () => {
    const buf = new TaskLogBuffer()
    buf.append('p#ok', 'ok')
    buf.finish('p#ok', 'success', 'miss')
    buf.append('p#bad', 'bad')
    buf.finish('p#bad', 'failed', 'miss')
    const bundle = buf.drain('run-1', 'ws-1')
    expect(bundle.v).toBe(LOG_WIRE_VERSION)
    expect(bundle.runId).toBe('run-1')
    expect(bundle.workspaceId).toBe('ws-1')
    expect(bundle.tasks[0]!.taskId).toBe('p#bad') // failure first
    expect(bundle.tasks[1]!.taskId).toBe('p#ok')
  })

  it('an all-hit warm run drains to nothing', () => {
    const buf = new TaskLogBuffer()
    for (let i = 0; i < 5; i++) {
      buf.append(`p#${i}`, 'hit replay')
      buf.finish(`p#${i}`, 'cache-hit', 'local', `h${i}`)
    }
    expect(buf.drain('r', 'ws').tasks).toEqual([])
  })
})
