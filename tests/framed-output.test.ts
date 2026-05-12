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
  it('renders the standard four lines + blanks', () => {
    expect(
      formatHeader({
        version: '1.2.3',
        packages: ['@vzn/vx'],
        task: 'lint',
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

  it('pluralizes "packages" past one, and sorts the in-scope list', () => {
    const lines = formatHeader({
      version: '0.0.0',
      packages: ['z', 'a', 'm'],
      task: 'build',
      remoteCacheEnabled: true,
    })
    expect(lines).toContain('   • Packages in scope: a, m, z')
    expect(lines).toContain('   • Running build in 3 packages')
    expect(lines).toContain('   • Remote caching enabled')
  })
})

describe('formatTaskBlock', () => {
  it('renders an executed task with command + body + duration', () => {
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
        '└─ @vzn/vx#lint ── (327ms)\n',
    )
  })

  it('renders a local cache hit with short hash + replayed body, no $ command line', () => {
    const out = formatTaskBlock(
      node('@vzn/vx#lint', 'oxlint .'),
      outcome('@vzn/vx#lint', 'cache-hit', { hash: 'abcdef0123456789' }),
      'Found 0 warnings and 0 errors.\n',
    )
    expect(out).toBe(
      '┌─ @vzn/vx#lint > cache hit • abcdef01\n' +
        'Found 0 warnings and 0 errors.\n' +
        '└─ @vzn/vx#lint ──\n',
    )
  })

  it('marks remote cache hits distinctly', () => {
    const out = formatTaskBlock(
      node('@vzn/vx#lint', 'oxlint .'),
      outcome('@vzn/vx#lint', 'cache-hit-remote', { hash: 'fedcba9876543210' }),
      '',
    )
    expect(out).toBe('┌─ @vzn/vx#lint > remote cache hit • fedcba98\n└─ @vzn/vx#lint ──\n')
  })

  it('renders failures with FAILED footer + exit code', () => {
    const out = formatTaskBlock(
      node('@vzn/vx#build', 'tsc'),
      outcome('@vzn/vx#build', 'failed', { durationMs: 1234, exitCode: 2 }),
      'error TS1234: oops\n',
    )
    expect(out).toBe(
      '┌─ @vzn/vx#build > $ tsc\n' +
        'error TS1234: oops\n' +
        '└─ @vzn/vx#build ── FAILED in 1.23s (exit 2)\n',
    )
  })

  it('renders skipped tasks with no body and no footer duration', () => {
    const out = formatTaskBlock(
      node('@vzn/vx#deploy', 'aws s3 sync'),
      outcome('@vzn/vx#deploy', 'skipped'),
      '',
    )
    expect(out).toBe('┌─ @vzn/vx#deploy > skipped (upstream failed)\n└─ @vzn/vx#deploy ──\n')
  })

  it('emits no block for group tasks (no exec) — they are pure organization', () => {
    expect(formatTaskBlock(node('@vzn/vx#ci'), outcome('@vzn/vx#ci', 'success'), '')).toBe('')
  })
})
