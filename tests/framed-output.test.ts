import { describe, expect, it } from 'bun:test'
import { formatHeader, formatTaskBlock } from '../src/orchestrator/framed-output.js'
import type { TaskOutcome } from '../src/graph/scheduler.js'
import type { TaskNode } from '../src/graph/task-graph.js'

function node(id: string, command?: string): TaskNode {
  return {
    id,
    config: command ? { exec: { command } } : {},
  } as unknown as TaskNode
}

function outcome(
  id: string,
  status: TaskOutcome['status'],
  extra: Partial<TaskOutcome> = {},
): TaskOutcome {
  return {
    node: { id } as TaskNode,
    status,
    exitCode: status === 'failed' ? 1 : 0,
    durationMs: 0,
    ...extra,
  }
}

describe('formatHeader', () => {
  it('renders the standard three lines + blanks for a single task', () => {
    expect(
      formatHeader({
        version: '1.2.3',
        packageCount: 1,
        tasks: ['lint'],
        taskCount: 1,
        remoteCacheEnabled: false,
      }),
    ).toEqual([
      '• vx 1.2.3',
      '',
      '   • Running lint in 1 package (1 task)',
      '   • Remote caching disabled',
      '',
    ])
  })

  it('lists multiple tasks comma-separated on the Running line', () => {
    const lines = formatHeader({
      version: '0.0.0',
      packageCount: 1,
      tasks: ['build', 'lint', 'test'],
      taskCount: 3,
      remoteCacheEnabled: false,
    })
    expect(lines).toContain('   • Running build, lint, test in 1 package (3 tasks)')
  })

  it('pluralizes "packages" and "tasks" past one', () => {
    const lines = formatHeader({
      version: '0.0.0',
      packageCount: 3,
      tasks: ['build'],
      taskCount: 3,
      remoteCacheEnabled: true,
    })
    expect(lines).toContain('   • Running build in 3 packages (3 tasks)')
    expect(lines).toContain('   • Remote caching enabled')
  })

  it('shows non-square task/package counts (e.g. task not defined everywhere)', () => {
    // 5 packages, but only 3 of them have `lint` declared → 3 tasks.
    const lines = formatHeader({
      version: '0.0.0',
      packageCount: 5,
      tasks: ['lint'],
      taskCount: 3,
      remoteCacheEnabled: false,
    })
    expect(lines).toContain('   • Running lint in 5 packages (3 tasks)')
  })
})

describe('formatTaskBlock', () => {
  it('renders an executed task with command + body + (op time) + cache-miss status', () => {
    const out = formatTaskBlock(
      node('@vzn/vx#lint', 'oxlint .'),
      outcome('@vzn/vx#lint', 'success', { durationMs: 327, hash: 'abcdef0123456789' }),
      'Found 0 warnings and 0 errors.\nFinished in 327ms.\n',
    )
    expect(out).toBe(
      '┌─ @vzn/vx#lint > cache-miss\n' +
        '│ $ oxlint .\n' +
        '│ Found 0 warnings and 0 errors.\n' +
        '│ Finished in 327ms.\n' +
        '└─ @vzn/vx#lint ── (327ms) cache-miss\n',
    )
  })

  it('local cache hit (restored) shows "local-cache" in header + footer', () => {
    // durationMs here is the wallclock for clean+restore+log-replay,
    // measured by execute-task. Tiny but non-zero in the wild.
    const out = formatTaskBlock(
      node('@vzn/vx#lint', 'oxlint .'),
      outcome('@vzn/vx#lint', 'cache-hit', {
        durationMs: 12,
        hash: 'abcdef0123456789',
        restored: true,
      }),
      'Found 0 warnings and 0 errors.\n',
    )
    expect(out).toBe(
      '┌─ @vzn/vx#lint > local-cache • abcdef01\n' +
        '│ Found 0 warnings and 0 errors.\n' +
        '└─ @vzn/vx#lint ── (12ms) local-cache\n',
    )
  })

  it('local cache hit (already up-to-date) shows "up-to-date" instead of "local-cache"', () => {
    // restored: false means the on-disk tree already matched the
    // cached snapshot, so cleanOutputs + restoreOutputs were skipped.
    // The user sees "up-to-date" to confirm nothing was rewritten.
    const out = formatTaskBlock(
      node('@vzn/vx#lint', 'oxlint .'),
      outcome('@vzn/vx#lint', 'cache-hit', {
        durationMs: 3,
        hash: 'abcdef0123456789',
        restored: false,
      }),
      '',
    )
    expect(out).toBe(
      '┌─ @vzn/vx#lint > up-to-date • abcdef01\n' + '└─ @vzn/vx#lint ── (3ms) up-to-date\n',
    )
  })

  it('remote cache hit (restored) shows "remote-cache" in header + footer', () => {
    const out = formatTaskBlock(
      node('@vzn/vx#lint', 'oxlint .'),
      outcome('@vzn/vx#lint', 'cache-hit-remote', {
        durationMs: 156,
        hash: 'fedcba9876543210',
        restored: true,
      }),
      '',
    )
    expect(out).toBe(
      '┌─ @vzn/vx#lint > remote-cache • fedcba98\n' + '└─ @vzn/vx#lint ── (156ms) remote-cache\n',
    )
  })

  it('failures show op time + bold FAILED tag with exit code', () => {
    const out = formatTaskBlock(
      node('@vzn/vx#build', 'tsc'),
      outcome('@vzn/vx#build', 'failed', { durationMs: 1234, exitCode: 2 }),
      { stderr: 'error TS1234: oops\n' },
    )
    expect(out).toBe(
      '┌─ @vzn/vx#build > $ tsc\n' +
        '├─ Error\n' +
        '│ error TS1234: oops\n' +
        '└─ @vzn/vx#build ── (1.23s) FAILED (exit 2)\n',
    )
  })

  it('renders a Sandbox Violations section when outcome carries violation lines', () => {
    const out = formatTaskBlock(
      node('@bench/top#build', 'sleep 3 && mkdir -p dist && touch dist/index.js'),
      outcome('@bench/top#build', 'failed', {
        durationMs: 3060,
        exitCode: 1,
        sandboxViolations: 2,
        sandboxViolationLines: [
          'touch(32784) deny(1) sysctl-read kern.iossupportversion',
          'touch(32784) deny(1) file-read-metadata /Users/me/proj/packages/top/dist/index.js',
        ],
      }),
      { stderr: 'touch: dist/index.js: Operation not permitted\n' },
    )
    expect(out).toBe(
      '┌─ @bench/top#build > $ sleep 3 && mkdir -p dist && touch dist/index.js\n' +
        '├─ Error\n' +
        '│ touch: dist/index.js: Operation not permitted\n' +
        '├─ Sandbox Violations (2)\n' +
        '│ touch(32784) deny(1) sysctl-read kern.iossupportversion\n' +
        '│ touch(32784) deny(1) file-read-metadata /Users/me/proj/packages/top/dist/index.js\n' +
        '└─ @bench/top#build ── (3.06s) FAILED (exit 1)\n',
    )
  })

  it('skipped tasks show 0ms + skipped status', () => {
    const out = formatTaskBlock(
      node('@vzn/vx#deploy', 'aws s3 sync'),
      outcome('@vzn/vx#deploy', 'skipped'),
      '',
    )
    expect(out).toBe(
      '┌─ @vzn/vx#deploy > skipped (upstream failed)\n└─ @vzn/vx#deploy ── (0ms) skipped\n',
    )
  })

  it('emits no block for group tasks (no exec) — they are pure organization', () => {
    expect(formatTaskBlock(node('@vzn/vx#ci'), outcome('@vzn/vx#ci', 'success'), '')).toBe('')
  })

  it('injects ANSI escapes when colors are enabled', () => {
    const out = formatTaskBlock(
      node('@vzn/vx#lint', 'oxlint .'),
      outcome('@vzn/vx#lint', 'cache-hit', {
        durationMs: 8,
        hash: 'abcdef0123456789',
        restored: true,
      }),
      '',
      { enabled: true },
    )
    expect(out).toContain('\x1b[')
    expect(out).toContain('\x1b[0m')
    expect(out).toContain('@vzn/vx#lint')
    expect(out).toContain('local-cache')
    expect(out).toContain('abcdef01')
  })

  it('failed tasks colorize the FAILED tag', () => {
    const out = formatTaskBlock(
      node('@vzn/vx#build', 'tsc'),
      outcome('@vzn/vx#build', 'failed', { durationMs: 100, exitCode: 2 }),
      '',
      { enabled: true },
    )
    expect(out).toContain('FAILED (exit 2)')
    expect(out).toContain('\x1b[1m')
    expect(out).toMatch(/\[38;2;\d+;\d+;\d+m/)
  })
})
