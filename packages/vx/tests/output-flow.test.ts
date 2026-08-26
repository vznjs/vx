// Flow-aware output policy: BROAD (--all / --filter / --affected)
// shows news only (executed one-liners + failure frames); FOCUSED
// (everything else) streams the requested task raw and silences
// successful dependencies; truthy CI env restores full grouped
// output; explicit --output-logs always overrides.

import { afterEach, beforeEach, describe, expect, it, vi } from 'bun:test'
import { writeLocalWorkspace } from './helpers/local-workspace.js'
import { detectFlow, run as cliRun } from '../src/cli/index.js'
import { defaultLogger, resolveOutputView } from '../src/orchestrator/logger.js'
import type { TaskNode, TaskOutcome } from '../src/graph/index.js'

describe('detectFlow', () => {
  it('defaults to focused when no selection flag is passed', () => {
    expect(detectFlow({ all: false, filters: [], affected: undefined })).toBe('focused')
  })

  it('--all is broad', () => {
    expect(detectFlow({ all: true, filters: [], affected: undefined })).toBe('broad')
  })

  it('--filter is broad', () => {
    expect(detectFlow({ all: false, filters: ['@scope/*'], affected: undefined })).toBe('broad')
  })

  it('--affected is broad (including the default-base empty string)', () => {
    expect(detectFlow({ all: false, filters: [], affected: '' })).toBe('broad')
    expect(detectFlow({ all: false, filters: [], affected: 'origin/main' })).toBe('broad')
  })
})

describe('resolveOutputView', () => {
  it('flow drives the default', () => {
    expect(resolveOutputView({ flow: 'focused' }, {})).toEqual({ mode: 'focused' })
    expect(resolveOutputView({ flow: 'broad' }, {})).toEqual({ mode: 'broad' })
  })

  it('truthy CI overrides the flow with full (and is flagged on the view)', () => {
    expect(resolveOutputView({ flow: 'broad' }, { CI: '1' })).toEqual({ mode: 'full', ci: true })
    expect(resolveOutputView({ flow: 'focused' }, { CI: 'true' })).toEqual({
      mode: 'full',
      ci: true,
    })
  })

  it('false-y CI values do not count as CI', () => {
    expect(resolveOutputView({ flow: 'broad' }, { CI: '' })).toEqual({ mode: 'broad' })
    expect(resolveOutputView({ flow: 'broad' }, { CI: '0' })).toEqual({ mode: 'broad' })
    expect(resolveOutputView({ flow: 'broad' }, { CI: 'false' })).toEqual({ mode: 'broad' })
  })

  it('explicit --output-logs beats both CI and flow', () => {
    expect(resolveOutputView({ outputLogs: 'hash-only', flow: 'broad' }, { CI: '1' })).toEqual({
      mode: 'hash-only',
      ci: true,
    })
    expect(resolveOutputView({ outputLogs: 'errors-only', flow: 'broad' }, { CI: '1' })).toEqual({
      mode: 'errors-only',
      ci: true,
    })
    expect(resolveOutputView({ outputLogs: 'none', flow: 'focused' }, {})).toEqual({ mode: 'none' })
    expect(resolveOutputView({ outputLogs: 'full', flow: 'broad' }, {})).toEqual({ mode: 'full' })
  })

  it('no flow, no CI, no override → full (programmatic default)', () => {
    expect(resolveOutputView({}, {})).toEqual({ mode: 'full' })
  })
})

function sink(): { chunks: string[]; write(c: string): boolean; text(): string } {
  const chunks: string[] = []
  return {
    chunks,
    write(c: string) {
      chunks.push(c)
      return true
    },
    text() {
      return chunks.join('')
    },
  }
}

function mkNode(
  id: string,
  opts: { requested?: boolean; group?: boolean; surfaced?: boolean } = {},
): TaskNode {
  const [project, task] = id.split('#')
  return {
    id,
    projectName: project,
    taskName: task,
    requested: opts.requested ?? false,
    surfaced: opts.surfaced ?? false,
    deps: [],
    config: opts.group ? {} : { exec: { command: 'noop' } },
  } as unknown as TaskNode
}

function mkOutcome(
  node: TaskNode,
  status: TaskOutcome['status'],
  extra: Partial<TaskOutcome> = {},
): TaskOutcome {
  return {
    node,
    status,
    exitCode: status === 'failed' ? 1 : 0,
    durationMs: 100,
    hash: 'abcdef0123456789',
    ...extra,
  }
}

const NO_COLORS = { enabled: false }

describe('defaultLogger visibility matrix — broad', () => {
  it('executed task → exactly one executed line, stdout suppressed', () => {
    const out = sink()
    const log = defaultLogger(NO_COLORS, { mode: 'broad' }, out)
    const n = mkNode('one#build', { requested: true })
    log.taskStdout(n, 'noisy build output\n')
    log.taskComplete(n, mkOutcome(n, 'success', { durationMs: 1200 }))
    expect(out.text()).toBe(' ⏺︎   1.20s success miss   one#build\n')
  })

  it('cache hit with replayed stdout → silent', () => {
    const out = sink()
    const log = defaultLogger(NO_COLORS, { mode: 'broad' }, out)
    const n = mkNode('one#build', { requested: true })
    log.taskStdout(n, 'replayed output\n')
    log.taskComplete(n, mkOutcome(n, 'cache-hit', { restored: true }))
    expect(out.text()).toBe('')
  })

  it('up-to-date hit → silent', () => {
    const out = sink()
    const log = defaultLogger(NO_COLORS, { mode: 'broad' }, out)
    const n = mkNode('one#build')
    log.taskComplete(n, mkOutcome(n, 'cache-hit', { restored: false }))
    expect(out.text()).toBe('')
  })

  it('failure → full frame with the buffered output', () => {
    const out = sink()
    const log = defaultLogger(NO_COLORS, { mode: 'broad' }, out)
    const n = mkNode('one#boom')
    log.taskStdout(n, 'partial work\n')
    log.taskStderr(n, 'kaboom\n')
    log.taskComplete(n, mkOutcome(n, 'failed', { exitCode: 3 }))
    log.runEnd?.()
    const text = out.text()
    expect(text).toContain('◼︎   100ms failed  miss   one#boom')
    expect(text).toContain('┌─ one#boom')
    expect(text).toContain('partial work')
    expect(text).toContain('kaboom')
    expect(text).toContain('failed (exit 3)')
  })

  it('skipped → silent (summary carries the count)', () => {
    const out = sink()
    const log = defaultLogger(NO_COLORS, { mode: 'broad' }, out)
    const n = mkNode('one#later')
    log.taskComplete(n, mkOutcome(n, 'skipped'))
    expect(out.text()).toBe('')
  })

  it('group tasks → silent', () => {
    const out = sink()
    const log = defaultLogger(NO_COLORS, { mode: 'broad' }, out)
    const n = mkNode('one#ci', { group: true })
    log.taskComplete(n, mkOutcome(n, 'success'))
    expect(out.text()).toBe('')
  })

  it('aborted (killed by a shutdown signal) → silent, not counted as failed', () => {
    const out = sink()
    const log = defaultLogger(NO_COLORS, { mode: 'broad' }, out)
    const n = mkNode('one#build')
    log.taskStderr(n, 'partial\n')
    log.taskComplete(n, mkOutcome(n, 'aborted', { exitCode: 143 }))
    log.runEnd?.()
    expect(out.text()).toBe('')
  })
})

describe('defaultLogger visibility matrix — focused', () => {
  it('requested node: live frame-open, raw stream, frame-close', () => {
    const out = sink()
    const log = defaultLogger(NO_COLORS, { mode: 'focused' }, out)
    const n = mkNode('one#test', { requested: true })
    log.taskStart?.(n)
    expect(out.text()).toBe('┌─ one#test > $ noop\n')
    log.taskStdout(n, 'line 1\n')
    expect(out.text()).toBe('┌─ one#test > $ noop\nline 1\n')
    log.taskStderr(n, 'warn 1\n')
    log.taskComplete(n, mkOutcome(n, 'success'))
    // Frame close always leaves a blank line so the next emission
    // never glues onto the frame.
    expect(out.text()).toBe(
      '┌─ one#test > $ noop\nline 1\nwarn 1\n└─ one#test ── (100ms) success\n\n',
    )
  })

  it('requested quiet cache hit → full frame, no one-liner (owner: always full frame)', () => {
    const out = sink()
    const log = defaultLogger(NO_COLORS, { mode: 'focused' }, out)
    const n = mkNode('one#test', { requested: true })
    log.taskStart?.(n)
    log.taskComplete(n, mkOutcome(n, 'cache-hit', { restored: true }))
    expect(out.text()).toBe('┌─ one#test > $ noop\n└─ one#test ── (100ms) restored-local\n\n')
  })

  it('requested cache hit with replay → framed live stream', () => {
    const out = sink()
    const log = defaultLogger(NO_COLORS, { mode: 'focused' }, out)
    const n = mkNode('one#test', { requested: true })
    log.taskStart?.(n)
    log.taskStdout(n, 'replayed\n')
    log.taskComplete(n, mkOutcome(n, 'cache-hit', { restored: true }))
    expect(out.text()).toBe(
      '┌─ one#test > $ noop\nreplayed\n└─ one#test ── (100ms) restored-local\n\n',
    )
  })

  it('requested skipped → one-liner (a skip has no output; a frame is empty furniture)', () => {
    const out = sink()
    const log = defaultLogger(NO_COLORS, { mode: 'focused' }, out)
    const n = mkNode('one#test', { requested: true })
    log.taskComplete(n, mkOutcome(n, 'skipped'))
    expect(out.text()).toBe(' ⊘         skipped        one#test\n')
  })

  it('dependency success with output → silent', () => {
    const out = sink()
    const log = defaultLogger(NO_COLORS, { mode: 'focused' }, out)
    const dep = mkNode('lib#build')
    log.taskStdout(dep, 'dep noise\n')
    log.taskComplete(dep, mkOutcome(dep, 'success'))
    expect(out.text()).toBe('')
  })

  it('dependency cache hit → silent (no hit one-liner)', () => {
    const out = sink()
    const log = defaultLogger(NO_COLORS, { mode: 'focused' }, out)
    const dep = mkNode('lib#build')
    log.taskStdout(dep, 'replayed dep output\n')
    log.taskComplete(dep, mkOutcome(dep, 'cache-hit', { restored: true }))
    expect(out.text()).toBe('')
  })

  it('dependency failure → full frame', () => {
    const out = sink()
    const log = defaultLogger(NO_COLORS, { mode: 'focused' }, out)
    const dep = mkNode('lib#build')
    log.taskStderr(dep, 'tsc exploded\n')
    log.taskComplete(dep, mkOutcome(dep, 'failed', { exitCode: 2 }))
    log.runEnd?.()
    const text = out.text()
    expect(text).toContain('◼︎   100ms failed  miss   lib#build')
    expect(text).toContain('┌─ lib#build')
    expect(text).toContain('tsc exploded')
    expect(text).toContain('failed (exit 2)')
  })

  it('single requested task streams live even when it is the only node', () => {
    const out = sink()
    const log = defaultLogger(NO_COLORS, { mode: 'focused' }, out)
    log.runStart?.({ total: 1, requestedCount: 1 })
    const n = mkNode('one#test', { requested: true })
    log.taskStart?.(n)
    expect(out.text()).toBe('┌─ one#test > $ noop\n')
    log.taskStdout(n, 'line 1\n')
    log.taskComplete(n, mkOutcome(n, 'success'))
    expect(out.text()).toBe('┌─ one#test > $ noop\nline 1\n└─ one#test ── (100ms) success\n\n')
  })

  it('surfaced task (real work behind a requested group) streams like a requested one', () => {
    // `vx run build` where build is a group: groups are transparent
    // folders, so the real task they stand for shows in focused flow.
    const out = sink()
    const log = defaultLogger(NO_COLORS, { mode: 'focused' }, out)
    log.runStart?.({ total: 1, requestedCount: 1 })
    const real = mkNode('one#build.bun.x', { surfaced: true })
    log.taskStart?.(real)
    expect(out.text()).toBe('┌─ one#build.bun.x > $ noop\n')
    log.taskStdout(real, 'compiling\n')
    log.taskComplete(real, mkOutcome(real, 'success'))
    expect(out.text()).toBe(
      '┌─ one#build.bun.x > $ noop\ncompiling\n└─ one#build.bun.x ── (100ms) success\n\n',
    )
  })

  it('a non-surfaced dependency stays silent even with a surfaced sibling in play', () => {
    const out = sink()
    const log = defaultLogger(NO_COLORS, { mode: 'focused' }, out)
    log.runStart?.({ total: 2, requestedCount: 2 })
    const dep = mkNode('lib#prep')
    log.taskStdout(dep, 'dep noise\n')
    log.taskComplete(dep, mkOutcome(dep, 'success'))
    expect(out.text()).toBe('')
  })
})

describe('defaultLogger focused — multiple requested tasks (atomic blocks)', () => {
  it('two concurrent requested tasks never interleave their frames', () => {
    const out = sink()
    const log = defaultLogger(NO_COLORS, { mode: 'focused' }, out)
    log.runStart?.({ total: 2, requestedCount: 2 })
    const a = mkNode('one#build', { requested: true })
    const b = mkNode('one#test', { requested: true })
    // Both start; interleaved output streams in. NOTHING must reach
    // the terminal yet (no live frame-open for requested nodes).
    log.taskStart?.(a)
    log.taskStart?.(b)
    log.taskStdout(a, 'A-line-1\n')
    log.taskStdout(b, 'B-line-1\n')
    log.taskStdout(a, 'A-line-2\n')
    log.taskStderr(b, 'B-warn\n')
    expect(out.text()).toBe('')
    // a completes → its entire block lands atomically.
    log.taskComplete(a, mkOutcome(a, 'success'))
    const afterA = out.text()
    expect(afterA).toContain('┌─ one#build')
    expect(afterA).toContain('A-line-1')
    expect(afterA).toContain('A-line-2')
    expect(afterA).toContain('└─ one#build')
    // a's block is contiguous: nothing from b's id appears between
    // a's open and close.
    const aOpen = afterA.indexOf('┌─ one#build')
    const aClose = afterA.indexOf('└─ one#build')
    expect(afterA.slice(aOpen, aClose)).not.toContain('one#test')
    expect(afterA).not.toContain('B-line-1')
    // b completes → its block lands, fully after a's.
    log.taskComplete(b, mkOutcome(b, 'success'))
    const text = out.text()
    expect(text.indexOf('┌─ one#test')).toBeGreaterThan(text.indexOf('└─ one#build'))
    expect(text).toContain('B-line-1')
    expect(text).toContain('B-warn')
  })

  it('two concurrent requested up-to-date hits render as clean atomic frames', () => {
    const out = sink()
    const log = defaultLogger(NO_COLORS, { mode: 'focused' }, out)
    log.runStart?.({ total: 2, requestedCount: 2 })
    const a = mkNode('@bench/l3-1#build', { requested: true })
    const b = mkNode('@bench/l3-1#test', { requested: true })
    log.taskStart?.(a)
    log.taskStart?.(b)
    log.taskComplete(a, mkOutcome(a, 'cache-hit', { restored: false }))
    log.taskComplete(b, mkOutcome(b, 'cache-hit', { restored: false }))
    const text = out.text()
    // No interleaved garbage: a's full frame precedes any of b's lines.
    const aClose = text.indexOf('└─ @bench/l3-1#build')
    const bOpen = text.indexOf('┌─ @bench/l3-1#test')
    expect(aClose).toBeGreaterThanOrEqual(0)
    expect(bOpen).toBeGreaterThan(aClose)
    expect(text).toContain('up-to-date')
  })

  it('multi-requested success with no output still gets a full atomic frame', () => {
    const out = sink()
    const log = defaultLogger(NO_COLORS, { mode: 'focused' }, out)
    log.runStart?.({ total: 2, requestedCount: 2 })
    const a = mkNode('one#build', { requested: true })
    log.taskStart?.(a)
    log.taskComplete(a, mkOutcome(a, 'success'))
    expect(out.text()).toBe(
      '┌─ one#build > success\n\n$ noop\n\n└─ one#build ── (100ms) success\n\n',
    )
  })

  it('multi-requested cache hit shows the `$ cmd` line — frame identical to a miss', () => {
    const out = sink()
    const log = defaultLogger(NO_COLORS, { mode: 'focused' }, out)
    log.runStart?.({ total: 2, requestedCount: 2 })
    const a = mkNode('one#build', { requested: true })
    log.taskStart?.(a)
    log.taskComplete(a, mkOutcome(a, 'cache-hit', { restored: false }))
    // The command line is present for the hit (forceCommand), so the
    // asked-for task's frame reads the same whether it ran or cached.
    expect(out.text()).toContain('$ noop')
    expect(out.text()).toContain('┌─ one#build > up-to-date')
  })

  it('multi-requested skipped task gets the skipped one-liner', () => {
    const out = sink()
    const log = defaultLogger(NO_COLORS, { mode: 'focused' }, out)
    log.runStart?.({ total: 2, requestedCount: 2 })
    const a = mkNode('one#build', { requested: true })
    log.taskComplete(a, mkOutcome(a, 'skipped'))
    expect(out.text()).toBe(' ⊘         skipped        one#build\n')
  })

  it('multi-requested failure defers its frame to runEnd with an inline ✗ line', () => {
    const out = sink()
    const log = defaultLogger(NO_COLORS, { mode: 'focused' }, out)
    log.runStart?.({ total: 2, requestedCount: 2 })
    const a = mkNode('one#build', { requested: true })
    log.taskStdout(a, 'partial\n')
    log.taskComplete(a, mkOutcome(a, 'failed', { exitCode: 4 }))
    expect(out.text()).toContain('◼︎   100ms failed  miss   one#build')
    log.runEnd?.()
    const text = out.text()
    expect(text).toContain('┌─ one#build')
    expect(text).toContain('partial')
    expect(text).toContain('failed (exit 4)')
  })

  it('dependency nodes stay silent on success while requested tasks buffer', () => {
    const out = sink()
    const log = defaultLogger(NO_COLORS, { mode: 'focused' }, out)
    log.runStart?.({ total: 3, requestedCount: 2 })
    const dep = mkNode('lib#build')
    log.taskStdout(dep, 'dep noise\n')
    log.taskComplete(dep, mkOutcome(dep, 'success'))
    expect(out.text()).toBe('')
  })
})

describe('defaultLogger block separation', () => {
  it('broad: failure logs an ✗ line inline; the frame replays at runEnd', () => {
    const out = sink()
    const log = defaultLogger(NO_COLORS, { mode: 'broad' }, out)
    const ok = mkNode('one#a')
    log.taskComplete(ok, mkOutcome(ok, 'success'))
    const bad = mkNode('one#boom')
    log.taskComplete(bad, mkOutcome(bad, 'failed'))
    const ok2 = mkNode('one#b')
    log.taskComplete(ok2, mkOutcome(ok2, 'success'))
    log.runEnd?.()
    expect(out.text()).toBe(
      ' ⏺︎   100ms success miss   one#a\n' +
        ' ◼︎   100ms failed  miss   one#boom\n' +
        ' ⏺︎   100ms success miss   one#b\n' +
        '\n' +
        '┌─ one#boom > failed (exit 1)\n' +
        '\n' +
        '$ noop\n' +
        '\n' +
        '└─ one#boom ── (100ms) failed (exit 1)\n' +
        '\n',
    )
  })

  it('deferred frames at runEnd: exactly one blank line between, one after', () => {
    const out = sink()
    const log = defaultLogger(NO_COLORS, { mode: 'errors-only' }, out)
    for (const id of ['one#x', 'one#y']) {
      const n = mkNode(id)
      log.taskComplete(n, mkOutcome(n, 'failed'))
    }
    log.runEnd?.()
    expect(out.text()).toBe(
      ' ◼︎   100ms failed  miss   one#x\n' +
        ' ◼︎   100ms failed  miss   one#y\n' +
        '\n' +
        '┌─ one#x > failed (exit 1)\n' +
        '\n' +
        '$ noop\n' +
        '\n' +
        '└─ one#x ── (100ms) failed (exit 1)\n' +
        '\n' +
        '┌─ one#y > failed (exit 1)\n' +
        '\n' +
        '$ noop\n' +
        '\n' +
        '└─ one#y ── (100ms) failed (exit 1)\n' +
        '\n',
    )
  })
})

describe('defaultLogger visibility matrix — overrides', () => {
  it('full: executed task keeps its frame, requested or not', () => {
    const out = sink()
    const log = defaultLogger(NO_COLORS, { mode: 'full' }, out)
    const n = mkNode('one#build', { requested: true })
    log.taskStdout(n, 'work\n')
    log.taskComplete(n, mkOutcome(n, 'success'))
    const text = out.text()
    expect(text).toContain('┌─ one#build')
    expect(text).toContain('work')
    expect(text).toContain('success')
  })

  it('errors-only: success and hits silent, failures framed', () => {
    const out = sink()
    const log = defaultLogger(NO_COLORS, { mode: 'errors-only' }, out)
    const ok = mkNode('one#a', { requested: true })
    log.taskStdout(ok, 'fine\n')
    log.taskComplete(ok, mkOutcome(ok, 'success'))
    const hit = mkNode('one#b')
    log.taskComplete(hit, mkOutcome(hit, 'cache-hit', { restored: true }))
    expect(out.text()).toBe('')
    const bad = mkNode('one#c')
    log.taskStderr(bad, 'oops\n')
    log.taskComplete(bad, mkOutcome(bad, 'failed'))
    expect(out.text()).toContain('failed  miss   one#c')
  })

  it('hash-only: one audit line per task, key included, zero log output', () => {
    const out = sink()
    const log = defaultLogger(NO_COLORS, { mode: 'hash-only' }, out)
    const ok = mkNode('one#a', { requested: true })
    log.taskStdout(ok, 'this build output must never print\n')
    log.taskComplete(ok, mkOutcome(ok, 'success'))
    const hit = mkNode('one#b')
    log.taskComplete(hit, mkOutcome(hit, 'cache-hit', { restored: true }))
    const bad = mkNode('one#c')
    log.taskStderr(bad, 'not even failures replay\n')
    log.taskComplete(bad, mkOutcome(bad, 'failed'))
    const skip = mkNode('one#d')
    log.taskComplete(skip, mkOutcome(skip, 'skipped', { hash: undefined } as never))
    log.runEnd?.()
    // Exact expected set, not substring absence: a mangled leak would
    // sail past `not.toContain`.
    expect(out.text()).toBe(
      'success one#a abcdef0123456789\n' +
        'restored-local one#b abcdef0123456789\n' +
        'failed one#c abcdef0123456789\n' +
        'skipped one#d\n',
    )
  })

  it('none: nothing per-task, ever', () => {
    const out = sink()
    const log = defaultLogger(NO_COLORS, { mode: 'none' }, out)
    const bad = mkNode('one#c', { requested: true })
    log.taskStderr(bad, 'oops\n')
    log.taskComplete(bad, mkOutcome(bad, 'failed'))
    expect(out.text()).toBe('')
  })

  it('status lines always print regardless of mode', () => {
    const out = sink()
    const log = defaultLogger(NO_COLORS, { mode: 'none' }, out)
    log.status('header line')
    expect(out.text()).toBe('header line\n')
  })
})

describe('GitHub Actions renderer (full mode + gha)', () => {
  it('resolveOutputView attaches gha only when GITHUB_ACTIONS is truthy', () => {
    expect(resolveOutputView({}, { CI: '1', GITHUB_ACTIONS: 'true' })).toEqual({
      mode: 'full',
      gha: true,
      ci: true,
    })
    expect(resolveOutputView({}, { CI: '1' })).toEqual({ mode: 'full', ci: true })
    expect(resolveOutputView({}, { CI: '1', GITHUB_ACTIONS: 'false' })).toEqual({
      mode: 'full',
      ci: true,
    })
    expect(resolveOutputView({ outputLogs: 'full' }, { GITHUB_ACTIONS: 'true' })).toEqual({
      mode: 'full',
      gha: true,
    })
    // Non-full modes never group.
    expect(resolveOutputView({ outputLogs: 'errors-only' }, { GITHUB_ACTIONS: 'true' })).toEqual({
      mode: 'errors-only',
    })
  })

  it('wraps a successful task block in ::group:: with outcome word + duration', () => {
    const out = sink()
    const log = defaultLogger(NO_COLORS, { mode: 'full', gha: true }, out)
    const n = mkNode('one#build', { requested: true })
    log.taskStdout(n, 'work\n')
    log.taskComplete(n, mkOutcome(n, 'success', { durationMs: 1200 }))
    const text = out.text()
    expect(text).toContain('::group::one#build (success 1.20s)\n')
    expect(text).toContain('┌─ one#build')
    expect(text).toContain('::endgroup::\n')
    // group opens before the frame, closes after it
    expect(text.indexOf('::group::')).toBeLessThan(text.indexOf('┌─ one#build'))
    expect(text.indexOf('::endgroup::')).toBeGreaterThan(text.indexOf('└─ one#build'))
  })

  it('hit-with-replay blocks group with the cache outcome word', () => {
    const out = sink()
    const log = defaultLogger(NO_COLORS, { mode: 'full', gha: true }, out)
    const n = mkNode('one#build')
    log.taskStdout(n, 'replayed\n')
    log.taskComplete(n, mkOutcome(n, 'cache-hit', { restored: true, durationMs: 12 }))
    expect(out.text()).toContain('::group::one#build (restored-local 12ms)\n')
  })

  it('failed tasks stay UNGROUPED and emit an ::error annotation', () => {
    const out = sink()
    const log = defaultLogger(NO_COLORS, { mode: 'full', gha: true }, out)
    const n = mkNode('one#boom')
    log.taskStderr(n, 'kaboom\n')
    log.taskComplete(n, mkOutcome(n, 'failed', { exitCode: 7 }))
    const text = out.text()
    expect(text).toContain('::error title=one#boom::failed (exit 7)\n')
    expect(text).toContain('┌─ one#boom')
    expect(text).not.toContain('::group::')
    expect(text).not.toContain('::endgroup::')
  })

  it('quiet hit one-liners stay plain (not a block, nothing to collapse)', () => {
    const out = sink()
    const log = defaultLogger(NO_COLORS, { mode: 'full', gha: true }, out)
    const n = mkNode('one#build')
    log.taskComplete(n, mkOutcome(n, 'cache-hit', { restored: true }))
    const text = out.text()
    expect(text).toContain('local  one#build')
    expect(text).not.toContain('::group::')
  })

  it('without gha, full mode emits no workflow commands', () => {
    const out = sink()
    const log = defaultLogger(NO_COLORS, { mode: 'full' }, out)
    const n = mkNode('one#build')
    log.taskStdout(n, 'work\n')
    log.taskComplete(n, mkOutcome(n, 'success'))
    expect(out.text()).not.toContain('::group::')
    expect(out.text()).not.toContain('::stop-commands::')
  })

  // The runner parses `::` LINES out of the log, so an interpolated value can
  // change a command's shape. Reachable without malice: a task name is an
  // arbitrary TS object key, and a task can legitimately print
  // command-shaped text.
  it('percent-encodes an annotation title so a newline cannot truncate it', () => {
    const out = sink()
    const log = defaultLogger(NO_COLORS, { mode: 'full', gha: true }, out)
    const n = mkNode('one#bad\nname::x')
    log.taskComplete(n, mkOutcome(n, 'failed', { exitCode: 2 }))
    const text = out.text()
    // One intact annotation line — the raw name would have split it in two
    // and leaked the remainder into the log as text.
    expect(text).toContain('::error title=one#bad%0Aname%3A%3Ax::failed (exit 2)\n')
    const annotation = text.split('\n').filter((l) => l.startsWith('::error'))
    expect(annotation.length).toBe(1)
    expect(annotation[0]).not.toContain('\n')
  })

  it('percent-encodes a group name so a newline cannot truncate it', () => {
    const out = sink()
    const log = defaultLogger(NO_COLORS, { mode: 'full', gha: true }, out)
    const n = mkNode('one#bad\nname')
    log.taskStdout(n, 'work\n')
    log.taskComplete(n, mkOutcome(n, 'success', { durationMs: 5 }))
    expect(out.text()).toContain('::group::one#bad%0Aname (success 5ms)\n')
  })

  it('escapes `%` first so an escape is never double-encoded', () => {
    const out = sink()
    const log = defaultLogger(NO_COLORS, { mode: 'full', gha: true }, out)
    const n = mkNode('one#a%0Ab')
    log.taskComplete(n, mkOutcome(n, 'failed', { exitCode: 1 }))
    // The literal name `a%0Ab` must arrive as `a%250Ab`, not as a newline.
    expect(out.text()).toContain('::error title=one#a%250Ab::')
  })

  it('fences task output so it cannot close vx’s group or forge an annotation', () => {
    const out = sink()
    const log = defaultLogger(NO_COLORS, { mode: 'full', gha: true }, out)
    const n = mkNode('one#evil')
    log.taskStdout(n, '::endgroup::\n::error title=HIJACK::pwned\nreal output\n')
    log.taskComplete(n, mkOutcome(n, 'success', { durationMs: 5 }))
    const text = out.text()
    const token = /::stop-commands::([0-9a-f-]{36})\n/.exec(text)?.[1]
    expect(token).toBeDefined()
    // The fence opens before the body and closes before vx's own ::endgroup::,
    // so the group is matched and the task's commands are inert text.
    const open = text.indexOf(`::stop-commands::${token}`)
    const close = text.indexOf(`::${token}::`, open + 1)
    const hostile = text.indexOf('::endgroup::\n::error title=HIJACK')
    const ownEnd = text.lastIndexOf('::endgroup::')
    expect(open).toBeGreaterThanOrEqual(0)
    expect(close).toBeGreaterThan(open)
    expect(hostile).toBeGreaterThan(open)
    expect(hostile).toBeLessThan(close)
    expect(ownEnd).toBeGreaterThan(close)
    // The output itself is still shown verbatim — fencing is not filtering.
    expect(text).toContain('real output')
  })

  it('fences a failed task’s output too', () => {
    const out = sink()
    const log = defaultLogger(NO_COLORS, { mode: 'full', gha: true }, out)
    const n = mkNode('one#boom')
    log.taskStderr(n, '::error title=FORGED::nope\n')
    log.taskComplete(n, mkOutcome(n, 'failed', { exitCode: 3 }))
    const text = out.text()
    const token = /::stop-commands::([0-9a-f-]{36})\n/.exec(text)?.[1]
    expect(token).toBeDefined()
    // vx's own annotation is OUTSIDE the fence (it must reach the runner);
    // the task's forged one is inside it.
    expect(text.indexOf('::error title=one#boom::')).toBeLessThan(
      text.indexOf(`::stop-commands::${token}`),
    )
    expect(text.indexOf('::error title=FORGED::')).toBeGreaterThan(
      text.indexOf(`::stop-commands::${token}`),
    )
    expect(text).toContain(`::${token}::`)
  })

  it('the fence token is per-run, so fenced output cannot print it', () => {
    const tokenOf = (): string => {
      const out = sink()
      const log = defaultLogger(NO_COLORS, { mode: 'full', gha: true }, out)
      const n = mkNode('one#build')
      log.taskStdout(n, 'x\n')
      log.taskComplete(n, mkOutcome(n, 'success'))
      return /::stop-commands::([0-9a-f-]{36})\n/.exec(out.text())?.[1] ?? ''
    }
    const a = tokenOf()
    const b = tokenOf()
    expect(a).not.toBe('')
    expect(a).not.toBe(b)
  })
})

// vx requires git for input enumeration; every fixture workspace
// gets a quiet repo via this helper before chdir.
function initGitRepo(cwd: string): void {
  const git = (...args: string[]): void => {
    Bun.spawnSync({
      cmd: ['git', '-c', 'commit.gpgsign=false', ...args],
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
    })
  }
  git('init', '-q')
  git('config', 'user.email', 'test@vx.local')
  git('config', 'user.name', 'vx test')
}

describe('flow e2e against a real fixture workspace', () => {
  let workspaceRoot: string
  const origCwd = process.cwd()
  const savedEnv: Record<string, string | undefined> = {}

  beforeEach(async () => {
    // The flow default is env-sensitive (CI restores full output).
    // Pin a non-CI env so the suite behaves identically locally and
    // on GitHub Actions.
    savedEnv['CI'] = process.env['CI']
    savedEnv['GITHUB_ACTIONS'] = process.env['GITHUB_ACTIONS']
    delete process.env['CI']
    delete process.env['GITHUB_ACTIONS']

    const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises')
    const os = await import('node:os')
    const path = await import('node:path')
    workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'vx-flow-e2e-'))
    await writeFile(
      path.join(workspaceRoot, 'pnpm-workspace.yaml'),
      'packages:\n  - "packages/*"\n',
    )
    await writeFile(
      path.join(workspaceRoot, 'package.json'),
      JSON.stringify({ name: 'root', private: true }),
    )
    await writeLocalWorkspace(workspaceRoot)
    const pkgDir = path.join(workspaceRoot, 'packages', 'one')
    await mkdir(pkgDir, { recursive: true })
    await writeFile(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({ name: 'one', version: '0.0.0' }),
    )
    await writeFile(
      path.join(pkgDir, 'vx.config.mjs'),
      `export default {
        tasks: {
          cached: {
            exec: { command: "echo CACHED-OUTPUT" },
            cache: { inputs: { files: ['**/*'] }, outputs: { files: [] } },
          },
          fresh: {
            exec: { command: "echo FRESH-OUTPUT" },
          },
          boom: {
            exec: { command: "echo BOOM-NOISE && exit 7" },
          },
          consume: {
            exec: { command: "echo CONSUME-OUTPUT" },
            dependsOn: ['dep'],
          },
          dep: {
            exec: { command: "echo DEP-NOISE" },
          },
          consumebad: {
            exec: { command: "echo NEVER-RUNS" },
            dependsOn: ['depbad'],
          },
          depbad: {
            exec: { command: "echo DEPBAD-NOISE && exit 3" },
          },
        },
      }`,
    )
    initGitRepo(workspaceRoot)
    process.chdir(workspaceRoot)
  })

  afterEach(async () => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    process.chdir(origCwd)
    const { rm } = await import('node:fs/promises')
    await rm(workspaceRoot, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  function captureStdout(): () => string {
    let stdout = ''
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout += String(chunk)
      return true
    })
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    return () => stdout
  }

  it('broad run with mixed hit/executed/failure shows only news + summary', async () => {
    // Prime the cache for `cached` so the second run hits.
    {
      const silence = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
      const silenceErr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
      expect(await cliRun(['run', '--all', 'cached'])).toBe(0)
      silence.mockRestore()
      silenceErr.mockRestore()
    }

    const text = captureStdout()
    const code = await cliRun(['run', '--all', 'cached', 'fresh', 'boom'])
    expect(code).toBe(1)

    // Executed task: one-liner, no raw output.
    expect(text()).toContain('success miss   one#fresh')
    expect(text()).not.toContain('FRESH-OUTPUT')
    // Cache hit: completely silent per-task (no replay, no one-liner).
    expect(text()).not.toContain('CACHED-OUTPUT')
    expect(text()).not.toContain('◌')
    // Failure: full frame.
    expect(text()).toContain('┌─ one#boom')
    expect(text()).toContain('failed (exit 7)')
    // Summary still prints.
    expect(text()).toContain('─ vx ')
    // No failed-id row in the summary (count in legend; frame above).
    expect(text()).not.toContain('  failed  one#boom')
    expect(text()).toContain('1 failed')
  })

  it('focused run streams requested output raw and silences successful deps', async () => {
    const path = await import('node:path')
    process.chdir(path.join(workspaceRoot, 'packages', 'one'))
    const text = captureStdout()
    const code = await cliRun(['run', 'consume'])
    expect(code).toBe(0)
    // Requested task: live frame around the raw stream (owner:
    // always full frame for a single task).
    expect(text()).toContain('CONSUME-OUTPUT')
    expect(text()).toContain('┌─ one#consume')
    expect(text()).toContain('└─ one#consume ──')
    // Successful dependency is silent.
    expect(text()).not.toContain('DEP-NOISE')
    expect(text()).not.toContain('one#dep ──')
  })

  it('focused run defers the failing dep frame; skipped requested gets a one-liner', async () => {
    const path = await import('node:path')
    process.chdir(path.join(workspaceRoot, 'packages', 'one'))
    const text = captureStdout()
    const code = await cliRun(['run', 'consumebad'])
    expect(code).toBe(1)
    // Failing dep: full frame with its output.
    expect(text()).toContain('┌─ one#depbad')
    expect(text()).toContain('DEPBAD-NOISE')
    expect(text()).toContain('failed (exit 3)')
    // Requested task never ran; its skip is framed.
    expect(text()).toContain('skipped        one#consumebad')
    expect(text()).not.toContain('NEVER-RUNS')
  })

  it('--output-logs full restores full grouped output in a broad run', async () => {
    const text = captureStdout()
    const code = await cliRun(['run', '--all', 'fresh', '--output-logs', 'full'])
    expect(code).toBe(0)
    expect(text()).toContain('┌─ one#fresh')
    expect(text()).toContain('FRESH-OUTPUT')
  })

  it('truthy CI env restores full grouped output in a broad run', async () => {
    process.env['CI'] = '1'
    const text = captureStdout()
    const code = await cliRun(['run', '--all', 'fresh'])
    expect(code).toBe(0)
    expect(text()).toContain('┌─ one#fresh')
    expect(text()).toContain('FRESH-OUTPUT')
  })

  it(
    'GITHUB_ACTIONS subprocess: tasks collapse in ::group::, failures stay open + annotate',
    async () => {
      const path = await import('node:path')
      const BIN = path.join(import.meta.dir, '..', 'src', 'bin.ts')
      const ghaEnv = { ...process.env, CI: '1', GITHUB_ACTIONS: 'true' }
      const vx = async (args: string[]): Promise<{ code: number; out: string }> => {
        const proc = Bun.spawn([process.execPath, BIN, ...args], {
          cwd: workspaceRoot,
          env: ghaEnv,
          stdout: 'pipe',
          stderr: 'pipe',
        })
        const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
        return { code, out }
      }

      // Prime `cached` so the second run replays it (hit-with-replay
      // block → grouped with the cache outcome word).
      expect((await vx(['run', '--all', 'cached'])).code).toBe(0)

      const { code, out } = await vx(['run', '--all', 'cached', 'fresh', 'boom'])
      expect(code).toBe(1)

      // Executed + replayed-hit blocks are grouped...
      expect(out).toMatch(/::group::one#fresh \(success [^)]+\)\n/)
      // No declared outputs → the replayed hit reads as up-to-date.
      expect(out).toMatch(/::group::one#cached \(up-to-date [^)]+\)\n/)
      // ...and every group is closed.
      const groups = (out.match(/::group::/g) ?? []).length
      const endgroups = (out.match(/::endgroup::/g) ?? []).length
      expect(groups).toBe(endgroups)
      expect(groups).toBe(2)
      // The failed task is pre-expanded: no group, an ::error
      // annotation, and the frame still present.
      expect(out).not.toContain('::group::one#boom')
      expect(out).toContain('::error title=one#boom::failed (exit 7)')
      expect(out).toContain('┌─ one#boom')
    },
    { timeout: 20_000 },
  )
})

// A persistent task's outcome lands at READY, but the child keeps running
// and keeps writing for the rest of the run. Those post-ready chunks used
// to arrive after `taskComplete` had already drained the task's buffer, so
// nothing emitted them and nothing freed them — invisible everywhere except
// the one focused view that streams live, and retained until the process
// exited. This block is the gap: before it, `output-flow.test.ts` had zero
// persistent coverage.
describe('persistent post-ready output', () => {
  const mkPersistent = (id: string, opts: { requested?: boolean } = {}): TaskNode => {
    const n = mkNode(id, opts)
    ;(n as { config: unknown }).config = {
      exec: { command: 'sh ./server.sh', persistent: { readyWhen: 'READY' } },
    }
    return n
  }

  it('full: chunks written after ready surface as a trailing running block', () => {
    const out = sink()
    const log = defaultLogger(NO_COLORS, { mode: 'full' }, out)
    const n = mkPersistent('app#server')
    log.taskStdout(n, 'READY\n')
    log.taskComplete(n, mkOutcome(n, 'success', { durationMs: 7 }))
    for (let i = 1; i <= 20; i++) log.taskStdout(n, `POST-LINE-${i}\n`)
    log.runEnd?.()

    const text = out.text()
    // Every post-ready line reaches the terminal (was: none of them).
    for (let i = 1; i <= 20; i++) expect(text).toContain(`POST-LINE-${i}`)
    // …in a block that reads as still-running, not as a completed task.
    expect(text).toContain('┌─ ▸ app#server > $ sh ./server.sh')
    expect(text).toContain('STDOUT (since ready)')
    expect(text).toContain('└─ ▸ app#server ── (7ms) running')
  })

  it('full: stderr since ready lands in its own section', () => {
    const out = sink()
    const log = defaultLogger(NO_COLORS, { mode: 'full' }, out)
    const n = mkPersistent('app#server')
    log.taskComplete(n, mkOutcome(n, 'success'))
    log.taskStderr(n, 'EADDRINUSE\n')
    log.runEnd?.()
    expect(out.text()).toContain('STDERR (since ready)')
    expect(out.text()).toContain('EADDRINUSE')
  })

  it('broad + focused-dependency also surface the tail', () => {
    for (const mode of ['broad', 'focused'] as const) {
      const out = sink()
      const log = defaultLogger(NO_COLORS, { mode }, out)
      // Not requested: in focused this is the dependency case — the
      // motivating one, where an `e2e` task failed against this server.
      const n = mkPersistent('app#server')
      log.taskComplete(n, mkOutcome(n, 'success'))
      log.taskStdout(n, 'POST-READY\n')
      log.runEnd?.()
      expect(out.text()).toContain('POST-READY')
    }
  })

  it('none + errors-only stay silent (their contracts are absolute)', () => {
    for (const mode of ['none', 'errors-only'] as const) {
      const out = sink()
      const log = defaultLogger(NO_COLORS, { mode }, out)
      const n = mkPersistent('app#server')
      log.taskComplete(n, mkOutcome(n, 'success'))
      log.taskStdout(n, 'POST-READY\n')
      log.runEnd?.()
      expect(out.text()).toBe('')
    }
  })

  it('the tail is bounded and says how much of the head it dropped', () => {
    const out = sink()
    const log = defaultLogger(NO_COLORS, { mode: 'full' }, out)
    const n = mkPersistent('app#server')
    log.taskComplete(n, mkOutcome(n, 'success'))
    // 1 MiB of post-ready output — a dev server logs without bound.
    const chunk = 'x'.repeat(1024)
    for (let i = 0; i < 1024; i++) log.taskStdout(n, chunk)
    log.taskStdout(n, '\nNEWEST-LINE\n')
    log.runEnd?.()

    const text = out.text()
    // The newest output is what explains a failure, so it survives…
    expect(text).toContain('NEWEST-LINE')
    // …and the block stays far under what was written.
    expect(text.length).toBeLessThan(256 * 1024)
    expect(text).toMatch(/… \d+ earlier characters dropped/)
  })

  it('a live-streaming requested task is not captured twice', () => {
    const out = sink()
    const log = defaultLogger(NO_COLORS, { mode: 'focused' }, out)
    const n = mkPersistent('app#server', { requested: true })
    log.taskStart?.(n)
    log.taskStdout(n, 'READY\n')
    log.taskComplete(n, mkOutcome(n, 'success'))
    log.taskStdout(n, 'POST-READY\n')
    log.runEnd?.()

    const text = out.text()
    // Streamed live exactly once, with no trailing replay block.
    expect(text.match(/POST-READY/g)?.length).toBe(1)
    expect(text).not.toContain('since ready')
  })

  it('runEnd is idempotent — run() calls it twice on the success path', () => {
    const out = sink()
    const log = defaultLogger(NO_COLORS, { mode: 'full' }, out)
    const n = mkPersistent('app#server')
    log.taskComplete(n, mkOutcome(n, 'success'))
    log.taskStdout(n, 'POST-READY\n')
    log.runEnd?.()
    log.runEnd?.()
    expect(out.text().match(/POST-READY/g)?.length).toBe(1)
  })

  it('a silent server adds no tail block to its completion frame', () => {
    const out = sink()
    const log = defaultLogger(NO_COLORS, { mode: 'full' }, out)
    const n = mkPersistent('app#server')
    log.taskComplete(n, mkOutcome(n, 'success'))
    log.runEnd?.()
    // The ready frame prints as always; nothing trails it.
    expect(out.text()).toContain('└─ app#server ── (100ms) success')
    expect(out.text()).not.toContain('since ready')
  })
})

// The bound above engaged only at READY, which is the one moment a task with
// a never-matching `readyWhen` never reaches — so its PRE-ready output landed
// in the ordinary unbounded per-task buffer and grew for the whole run
// (~100 MiB/s measured through the real CLI). A persistent task is the one
// kind nothing bounds, so it buffers into the capped tail for its whole life,
// from `taskStart`.
describe('persistent pre-ready output is bounded too', () => {
  const mkPersistent = (id: string): TaskNode => {
    const n = mkNode(id)
    ;(n as { config: unknown }).config = {
      exec: { command: 'sh ./server.sh', persistent: { readyWhen: 'NEVER-MATCHES' } },
    }
    return n
  }

  it('a never-ready flood is capped, and the frame says what it dropped', () => {
    const out = sink()
    const log = defaultLogger(NO_COLORS, { mode: 'full' }, out)
    const n = mkPersistent('app#server')
    log.taskStart?.(n)
    // 1 MiB written before the readiness deadline gives up.
    for (let i = 0; i < 1024; i++) log.taskStdout(n, 'x'.repeat(1024))
    log.taskStdout(n, '\nNEWEST-PRE-READY-LINE\n')
    log.taskComplete(n, mkOutcome(n, 'failed', { exitCode: 1 }))
    log.runEnd?.()

    const text = out.text()
    // The newest output explains why it never became ready, so it survives…
    expect(text).toContain('NEWEST-PRE-READY-LINE')
    // …in the failure frame, not a "since ready" block — it never was.
    expect(text).toContain('┌─ app#server')
    expect(text).not.toContain('since ready')
    // …and the frame stays far under the megabyte that was written, while
    // saying so, so a capped log can never read as a complete one.
    expect(text.length).toBeLessThan(256 * 1024)
    expect(text).toMatch(/… \d+ earlier characters dropped/)
  })

  it('ordinary-sized pre-ready output is untouched and unannotated', () => {
    const out = sink()
    const log = defaultLogger(NO_COLORS, { mode: 'full' }, out)
    const n = mkPersistent('app#server')
    log.taskStart?.(n)
    log.taskStdout(n, 'listening on :3000\n')
    log.taskStderr(n, 'warn: no TLS\n')
    log.taskComplete(n, mkOutcome(n, 'failed', { exitCode: 1 }))
    const text = out.text()
    expect(text).toContain('listening on :3000')
    expect(text).toContain('warn: no TLS')
    expect(text).not.toContain('characters dropped')
  })

  it('a ready server still starts a fresh post-ready tail after its frame', () => {
    const out = sink()
    const log = defaultLogger(NO_COLORS, { mode: 'full' }, out)
    const n = mkPersistent('app#server')
    log.taskStart?.(n)
    log.taskStdout(n, 'PRE-READY-LINE\n')
    log.taskComplete(n, mkOutcome(n, 'success'))
    log.taskStdout(n, 'POST-READY-LINE\n')
    log.runEnd?.()
    const text = out.text()
    // Each phase renders once, in its own block — the pre-ready window is
    // drained into the completion frame, not replayed by the tail.
    expect(text.match(/PRE-READY-LINE/g)?.length).toBe(1)
    expect(text.match(/POST-READY-LINE/g)?.length).toBe(1)
    expect(text.indexOf('PRE-READY-LINE')).toBeLessThan(text.indexOf('POST-READY-LINE'))
    expect(text).toContain('STDOUT (since ready)')
  })

  it('a NON-persistent task is deliberately not capped', () => {
    const out = sink()
    const log = defaultLogger(NO_COLORS, { mode: 'full' }, out)
    const n = mkNode('app#build')
    log.taskStart?.(n)
    for (let i = 0; i < 1024; i++) log.taskStdout(n, 'y'.repeat(1024))
    log.taskComplete(n, mkOutcome(n, 'failed', { exitCode: 1 }))
    const text = out.text()
    // A one-shot command's output ends when it exits, so it is bounded by
    // the task itself — truncating a build log would lose real diagnostics.
    expect(text.length).toBeGreaterThan(1024 * 1024)
    expect(text).not.toContain('characters dropped')
  })
})
