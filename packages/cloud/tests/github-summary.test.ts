// The GitHub Actions job-summary emitter: markdown shape (failures first,
// verdict line, truncation) and the never-fail append.

import { describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { RunSummaryRecord, TaskTelemetry } from '@vzn/vx'
import { appendGithubSummary, formatGithubSummary } from '../src/github-summary.js'

function summary(
  tasks: Partial<TaskTelemetry>[],
  over: Partial<RunSummaryRecord> = {},
): RunSummaryRecord {
  const full = tasks.map(
    (t): TaskTelemetry => ({
      taskId: t.taskId ?? 'p#build',
      project: (t.taskId ?? 'p#build').split('#')[0]!,
      task: (t.taskId ?? 'p#build').split('#')[1]!,
      status: t.status ?? 'success',
      cacheSource: t.cacheSource ?? 'miss',
      exitCode: t.exitCode ?? 0,
      durationMs: t.durationMs ?? 1000,
      ...(t.attempts !== undefined ? { attempts: t.attempts } : {}),
      ...(t.verify !== undefined ? { verify: t.verify } : {}),
    }),
  )
  return {
    v: 2,
    run: {
      runId: 'r',
      vxVersion: '0',
      workspaceId: 'ws',
      workspaceName: 'w',
      command: 'vx run ci',
      requestedTasks: ['ci'],
      cachePolicy: 'lR,lW,rR,rW',
      concurrency: 4,
      flow: null,
      commitSha: null,
      branch: null,
      dirty: null,
      ci: true,
      ciProvider: 'github',
      host: null,
      os: 'linux',
      arch: 'x64',
      tags: {},
    },
    startedAt: 0,
    endedAt: 1000,
    totalDurationMs: 1000,
    taskCount: full.length,
    failedCount: full.filter((t) => t.status === 'failed').length,
    hitCount: full.filter((t) => t.cacheSource === 'local' || t.cacheSource === 'remote').length,
    hitLocalCount: 0,
    hitRemoteCount: 0,
    exitOk: full.every((t) => t.status !== 'failed'),
    tasks: full,
    ...over,
  }
}

describe('formatGithubSummary', () => {
  it('leads with the verdict + stats and the command', () => {
    const md = formatGithubSummary(summary([{ taskId: 'a#build' }, { taskId: 'b#test' }]))
    expect(md).toContain('vx run — `vx run ci`')
    expect(md).toContain('✅ passed')
    expect(md).toContain('**2** tasks')
    expect(md).toContain('| Task | Status | Duration | Cache |')
    expect(md).toContain('`a#build`')
  })

  it('orders failed tasks first and marks the failure with its exit code', () => {
    const md = formatGithubSummary(
      summary([
        { taskId: 'ok#build', status: 'success' },
        { taskId: 'bad#test', status: 'failed', exitCode: 2 },
      ]),
    )
    expect(md).toContain('❌ failed (exit 2)')
    // The failed row appears before the successful one.
    expect(md.indexOf('bad#test')).toBeLessThan(md.indexOf('ok#build'))
  })

  it('flags a task that only passed after a retry as flaky', () => {
    const md = formatGithubSummary(summary([{ taskId: 'ui#test', status: 'success', attempts: 3 }]))
    expect(md).toContain('⚠️ flaky (3 attempts)')
    // A single-attempt success is NOT flagged.
    const clean = formatGithubSummary(summary([{ taskId: 'ui#test', status: 'success' }]))
    expect(clean).not.toContain('flaky')
  })

  it('surfaces the --verify hermeticity verdict + names diverging outputs', () => {
    const md = formatGithubSummary(
      summary([
        {
          taskId: 'web#bundle',
          status: 'success',
          verify: { kind: 'nondeterministic', changed: ['dist/app.js', 'dist/app.js.map'] },
        },
        { taskId: 'lib#build', status: 'success', verify: { kind: 'proven-deterministic' } },
      ]),
    )
    // Headline hermeticity line (warns because one task is non-deterministic).
    expect(md).toContain('⚠️ Hermeticity: **1** proven · **1** non-deterministic')
    // Per-row marker names the diverging outputs.
    expect(md).toContain('⚠️ non-deterministic (dist/app.js, dist/app.js.map)')
    expect(md).toContain('🔒 verified')
  })

  it('does not print a hermeticity line for a run without --verify', () => {
    const md = formatGithubSummary(summary([{ taskId: 'a#build', status: 'success' }]))
    expect(md).not.toContain('Hermeticity')
    expect(md).not.toContain('verified')
  })

  it('truncates a long diverging-output list in the status cell', () => {
    const md = formatGithubSummary(
      summary([
        {
          taskId: 'web#bundle',
          status: 'success',
          verify: {
            kind: 'nondeterministic',
            changed: ['a.js', 'b.js', 'c.js', 'd.js', 'e.js'],
          },
        },
      ]),
    )
    expect(md).toContain('non-deterministic (a.js, b.js, c.js, +2 more)')
  })

  it('drops aborted tasks and renders cache provenance', () => {
    const md = formatGithubSummary(
      summary([
        { taskId: 'hit#build', status: 'cache-hit', cacheSource: 'local' },
        { taskId: 'gone#x', status: 'aborted' },
      ]),
    )
    expect(md).toContain('🟦 cache hit')
    expect(md).toContain('| local |')
    expect(md).not.toContain('gone#x')
  })

  it('truncates a very large task list with a note', () => {
    const many = Array.from({ length: 150 }, (_, i) => ({ taskId: `p#t${i}` }))
    const md = formatGithubSummary(summary(many))
    expect(md).toContain('more tasks not shown')
    expect((md.match(/\| `p#t/g) ?? []).length).toBe(100)
  })
})

describe('appendGithubSummary', () => {
  it('appends the summary to the file', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'vx-gha-'))
    const file = path.join(dir, 'summary.md')
    try {
      await appendGithubSummary(file, summary([{ taskId: 'a#b' }]), () => {})
      expect(readFileSync(file, 'utf8')).toContain('`a#b`')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('never throws on an unwritable path (warns instead)', async () => {
    const warnings: string[] = []
    await appendGithubSummary('/nonexistent-dir/summary.md', summary([]), (m) => warnings.push(m))
    expect(warnings.length).toBe(1)
    expect(warnings[0]).toContain('github summary')
  })
})
