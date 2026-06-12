import { describe, expect, it } from 'bun:test'
import { formatHeader, formatTaskBlock } from '../src/orchestrator/framed-output.js'
import type { TaskOutcome } from '../src/graph/scheduler.js'
import type { TaskNode } from '../src/graph/task-graph.js'

function node(id: string, command?: string): TaskNode {
  const sep = id.indexOf('#')
  return {
    id,
    projectName: sep >= 0 ? id.slice(0, sep) : id,
    taskName: sep >= 0 ? id.slice(sep + 1) : id,
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
  it('renders the gradient rule + run/cache rows in the summary style', () => {
    expect(
      formatHeader({
        version: '1.2.3',
        packageCount: 1,
        tasks: ['lint'],
        taskCount: 1,
        remoteCacheEnabled: false,
      }),
    ).toEqual([
      '',
      '  run     lint · 1 project · 1 task',
      '  cache   local only',
      '─ vx 1.2.3 ' + '─'.repeat(49),
      '',
    ])
  })

  it('lists multiple tasks comma-separated, pluralizes counts, shows workers', () => {
    const lines = formatHeader({
      version: '0.0.0',
      packageCount: 3,
      tasks: ['build', 'lint', 'test'],
      taskCount: 3,
      remoteCacheEnabled: true,
      concurrency: 8,
    })
    expect(lines).toContain('  run     build, lint, test · 3 projects · 3 tasks · 8 workers')
    expect(lines).toContain('  cache   local + remote')
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
    expect(lines).toContain('  run     lint · 5 projects · 3 tasks')
  })
})

describe('formatTaskBlock', () => {
  it('renders an executed task with command + stdout sections, content raw (no border)', () => {
    const out = formatTaskBlock(
      node('@vzn/vx#lint', 'oxlint .'),
      outcome('@vzn/vx#lint', 'success', { durationMs: 327, hash: 'abcdef0123456789' }),
      { stdout: 'Found 0 warnings and 0 errors.\nFinished in 327ms.\n' },
    )
    expect(out).toBe(
      '┌─ @vzn/vx#lint > success\n' +
        '\n' +
        '$ oxlint .\n' +
        '\n' +
        '├─ STDOUT ──────────────────────────────────────────────────\n' +
        '\n' +
        'Found 0 warnings and 0 errors.\n' +
        'Finished in 327ms.\n' +
        '\n' +
        '└─ @vzn/vx#lint ── (327ms) success\n',
    )
  })

  it('whitespace-only stdout renders no stdout section', () => {
    const out = formatTaskBlock(
      node('@vzn/vx#lint', 'oxlint .'),
      outcome('@vzn/vx#lint', 'success', { durationMs: 5 }),
      { stdout: '   \n\n' },
    )
    expect(out).toBe(
      '┌─ @vzn/vx#lint > success\n' +
        '\n' +
        '$ oxlint .\n' +
        '\n' +
        '└─ @vzn/vx#lint ── (5ms) success\n',
    )
  })

  it('local cache hit (restored) shows "restored-local" + stdout section, no command', () => {
    // durationMs here is the wallclock for clean+restore+log-replay,
    // measured by execute-task. Tiny but non-zero in the wild.
    const out = formatTaskBlock(
      node('@vzn/vx#lint', 'oxlint .'),
      outcome('@vzn/vx#lint', 'cache-hit', {
        durationMs: 12,
        hash: 'abcdef0123456789',
        restored: true,
      }),
      { stdout: 'Found 0 warnings and 0 errors.\n' },
    )
    expect(out).toBe(
      '┌─ @vzn/vx#lint > restored-local • abcdef01\n' +
        '├─ STDOUT ──────────────────────────────────────────────────\n' +
        '\n' +
        'Found 0 warnings and 0 errors.\n' +
        '\n' +
        '└─ @vzn/vx#lint ── (12ms) restored-local\n',
    )
  })

  it('local cache hit (already up-to-date) shows "up-to-date" instead of "restored-local"', () => {
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
      {},
    )
    expect(out).toBe(
      '┌─ @vzn/vx#lint > up-to-date • abcdef01\n' + '└─ @vzn/vx#lint ── (3ms) up-to-date\n',
    )
  })

  it('remote cache hit (restored) shows "restored-remote" in header + footer', () => {
    const out = formatTaskBlock(
      node('@vzn/vx#lint', 'oxlint .'),
      outcome('@vzn/vx#lint', 'cache-hit-remote', {
        durationMs: 156,
        hash: 'fedcba9876543210',
        restored: true,
      }),
      {},
    )
    expect(out).toBe(
      '┌─ @vzn/vx#lint > restored-remote • fedcba98\n' +
        '└─ @vzn/vx#lint ── (156ms) restored-remote\n',
    )
  })

  it('failures put the outcome in the header, command as a dim $ line', () => {
    const out = formatTaskBlock(
      node('@vzn/vx#build', 'tsc'),
      outcome('@vzn/vx#build', 'failed', { durationMs: 1234, exitCode: 2 }),
      { stderr: 'error TS1234: oops\n' },
    )
    expect(out).toBe(
      '┌─ @vzn/vx#build > failed (exit 2)\n' +
        '\n' +
        '$ tsc\n' +
        '\n' +
        '├─ STDERR ──────────────────────────────────────────────────\n' +
        '\n' +
        'error TS1234: oops\n' +
        '\n' +
        '└─ @vzn/vx#build ── (1.23s) failed (exit 2)\n',
    )
  })

  it('renders a sandbox violations section when outcome carries violation lines', () => {
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
      '┌─ @bench/top#build > failed (exit 1)\n' +
        '\n' +
        '$ sleep 3 && mkdir -p dist && touch dist/index.js\n' +
        '\n' +
        '├─ STDERR ──────────────────────────────────────────────────\n' +
        '\n' +
        'touch: dist/index.js: Operation not permitted\n' +
        '\n' +
        '├─ SANDBOX VIOLATIONS (2) ──────────────────────────────────\n' +
        '\n' +
        'touch(32784) deny(1) sysctl-read kern.iossupportversion\n' +
        'touch(32784) deny(1) file-read-metadata /Users/me/proj/packages/top/dist/index.js\n' +
        '\n' +
        '└─ @bench/top#build ── (3.06s) failed (exit 1)\n',
    )
  })

  it('skipped tasks show 0ms + skipped status', () => {
    const out = formatTaskBlock(
      node('@vzn/vx#deploy', 'aws s3 sync'),
      outcome('@vzn/vx#deploy', 'skipped'),
      {},
    )
    expect(out).toBe(
      '┌─ @vzn/vx#deploy > skipped (upstream failed)\n└─ @vzn/vx#deploy ── (0ms) skipped\n',
    )
  })

  it('emits no block for group tasks (no exec) — they are pure organization', () => {
    expect(formatTaskBlock(node('@vzn/vx#ci'), outcome('@vzn/vx#ci', 'success'), {})).toBe('')
  })

  it('injects ANSI escapes when colors are enabled', () => {
    const out = formatTaskBlock(
      node('@vzn/vx#lint', 'oxlint .'),
      outcome('@vzn/vx#lint', 'cache-hit', {
        durationMs: 8,
        hash: 'abcdef0123456789',
        restored: true,
      }),
      {},
      { enabled: true },
    )
    expect(out).toContain('\x1b[')
    expect(out).toContain('\x1b[0m')
    // The id renders as two identity-colored halves with a dim
    // separator, so the contiguous string only exists uncolored.
    expect(out).toContain('@vzn/vx')
    expect(out).toContain('lint')
    expect(out).toContain('restored-local')
    expect(out).toContain('abcdef01')
  })

  it('section headers render dim; content lines stay raw (no border, no indent)', () => {
    const out = formatTaskBlock(
      node('@vzn/vx#build', 'tsc'),
      outcome('@vzn/vx#build', 'failed', { durationMs: 1, exitCode: 1 }),
      { stdout: 'out line\n', stderr: 'err line\n' },
      { enabled: true },
    )
    // command renders as a dim `$ cmd` line; section labels are
    // bold + state-colored with a dim trailing rule.
    expect(out).toContain('\x1b[2m$ tsc\x1b[0m')
    expect(out).toContain('\x1b[1m\x1b[38;2;34;197;94mSTDOUT\x1b[0m')
    expect(out).toContain('\x1b[1m\x1b[38;2;239;68;68mSTDERR\x1b[0m')
    expect(out).toContain('\nout line\n')
    expect(out).toContain('\nerr line\n')
    expect(out).not.toContain('│')
  })

  it('failed tasks colorize the failed tag', () => {
    const out = formatTaskBlock(
      node('@vzn/vx#build', 'tsc'),
      outcome('@vzn/vx#build', 'failed', { durationMs: 100, exitCode: 2 }),
      {},
      { enabled: true },
    )
    expect(out).toContain('failed (exit 2)')
    expect(out).toContain('\x1b[1m')
    expect(out).toMatch(/\[38;2;\d+;\d+;\d+m/)
  })
})
