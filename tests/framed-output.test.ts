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
  it('renders the standard four lines + blanks for a single task', () => {
    expect(
      formatHeader({
        version: '1.2.3',
        packages: ['@vzn/vx'],
        tasks: ['lint'],
        remoteCacheEnabled: false,
      }),
    ).toEqual([
      '• vx 1.2.3',
      '',
      '   • Packages in scope: @vzn/vx',
      '   • Running lint in 1 package',
      '   • Remote caching disabled',
      '',
    ])
  })

  it('lists multiple tasks comma-separated on the Running line', () => {
    const lines = formatHeader({
      version: '0.0.0',
      packages: ['app'],
      tasks: ['build', 'lint', 'test'],
      remoteCacheEnabled: false,
    })
    expect(lines).toContain('   • Running build, lint, test in 1 package')
  })

  it('pluralizes "packages" past one, and sorts the in-scope list', () => {
    const lines = formatHeader({
      version: '0.0.0',
      packages: ['z', 'a', 'm'],
      tasks: ['build'],
      remoteCacheEnabled: true,
    })
    expect(lines).toContain('   • Packages in scope: a, m, z')
    expect(lines).toContain('   • Running build in 3 packages')
    expect(lines).toContain('   • Remote caching enabled')
  })
})

describe('formatTaskBlock', () => {
  it('renders an executed task with command + body + (op time) + executed status', () => {
    const out = formatTaskBlock(
      node('@vzn/vx#lint', 'oxlint .'),
      outcome('@vzn/vx#lint', 'success', { durationMs: 327, hash: 'abcdef0123456789' }),
      'Found 0 warnings and 0 errors.\nFinished in 327ms.\n',
    )
    expect(out).toBe(
      '┌─ @vzn/vx#lint > executed\n' +
        '$ oxlint .\n' +
        'Found 0 warnings and 0 errors.\n' +
        'Finished in 327ms.\n' +
        '└─ @vzn/vx#lint ── (327ms) executed\n',
    )
  })

  it('local cache hit footer shows restore-op time + "from local cache"', () => {
    // durationMs here is the wallclock for clean+restore+log-replay,
    // measured by execute-task. Tiny but non-zero in the wild.
    const out = formatTaskBlock(
      node('@vzn/vx#lint', 'oxlint .'),
      outcome('@vzn/vx#lint', 'cache-hit', { durationMs: 12, hash: 'abcdef0123456789' }),
      'Found 0 warnings and 0 errors.\n',
    )
    expect(out).toBe(
      '┌─ @vzn/vx#lint > cache hit • abcdef01\n' +
        'Found 0 warnings and 0 errors.\n' +
        '└─ @vzn/vx#lint ── (12ms) from local cache\n',
    )
  })

  it('remote cache hit footer shows op time + "from remote cache"', () => {
    const out = formatTaskBlock(
      node('@vzn/vx#lint', 'oxlint .'),
      outcome('@vzn/vx#lint', 'cache-hit-remote', { durationMs: 156, hash: 'fedcba9876543210' }),
      '',
    )
    expect(out).toBe(
      '┌─ @vzn/vx#lint > remote cache hit • fedcba98\n' +
        '└─ @vzn/vx#lint ── (156ms) from remote cache\n',
    )
  })

  it('failures show op time + bold FAILED tag with exit code', () => {
    const out = formatTaskBlock(
      node('@vzn/vx#build', 'tsc'),
      outcome('@vzn/vx#build', 'failed', { durationMs: 1234, exitCode: 2 }),
      'error TS1234: oops\n',
    )
    expect(out).toBe(
      '┌─ @vzn/vx#build > $ tsc\n' +
        'error TS1234: oops\n' +
        '└─ @vzn/vx#build ── (1.23s) FAILED (exit 2)\n',
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
      outcome('@vzn/vx#lint', 'cache-hit', { durationMs: 8, hash: 'abcdef0123456789' }),
      '',
      { enabled: true },
    )
    expect(out).toContain('\x1b[')
    expect(out).toContain('\x1b[0m')
    expect(out).toContain('@vzn/vx#lint')
    expect(out).toContain('cache hit')
    expect(out).toContain('abcdef01')
    expect(out).toContain('from local cache')
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
