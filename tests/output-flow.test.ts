// Flow-aware output policy: BROAD (--all / --filter / --affected)
// shows news only (executed one-liners + failure frames); FOCUSED
// (everything else) streams the requested task raw and silences
// successful dependencies; truthy CI env restores full grouped
// output; explicit --output-logs always overrides.

import { afterEach, beforeEach, describe, expect, it, vi } from 'bun:test'
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

  it('truthy CI overrides the flow with full', () => {
    expect(resolveOutputView({ flow: 'broad' }, { CI: '1' })).toEqual({ mode: 'full' })
    expect(resolveOutputView({ flow: 'focused' }, { CI: 'true' })).toEqual({ mode: 'full' })
  })

  it('false-y CI values do not count as CI', () => {
    expect(resolveOutputView({ flow: 'broad' }, { CI: '' })).toEqual({ mode: 'broad' })
    expect(resolveOutputView({ flow: 'broad' }, { CI: '0' })).toEqual({ mode: 'broad' })
    expect(resolveOutputView({ flow: 'broad' }, { CI: 'false' })).toEqual({ mode: 'broad' })
  })

  it('explicit --output-logs beats both CI and flow', () => {
    expect(resolveOutputView({ outputLogs: 'errors-only', flow: 'broad' }, { CI: '1' })).toEqual({
      mode: 'errors-only',
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

function mkNode(id: string, opts: { requested?: boolean; group?: boolean } = {}): TaskNode {
  const [project, task] = id.split('#')
  return {
    id,
    projectName: project,
    taskName: task,
    requested: opts.requested ?? false,
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
    expect(out.text()).toBe('● one#build ── executed • 1.20s\n')
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
    const text = out.text()
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
})

describe('defaultLogger visibility matrix — focused', () => {
  it('requested node streams raw output live (before completion)', () => {
    const out = sink()
    const log = defaultLogger(NO_COLORS, { mode: 'focused' }, out)
    const n = mkNode('one#test', { requested: true })
    log.taskStdout(n, 'line 1\n')
    expect(out.text()).toBe('line 1\n')
    log.taskStderr(n, 'warn 1\n')
    expect(out.text()).toBe('line 1\nwarn 1\n')
    log.taskComplete(n, mkOutcome(n, 'success'))
    // No frame, no one-liner after the stream.
    expect(out.text()).toBe('line 1\nwarn 1\n')
  })

  it('requested quiet cache hit → hit one-liner', () => {
    const out = sink()
    const log = defaultLogger(NO_COLORS, { mode: 'focused' }, out)
    const n = mkNode('one#test', { requested: true })
    log.taskComplete(n, mkOutcome(n, 'cache-hit', { restored: true }))
    expect(out.text()).toBe('◌ one#test ── restored-local • abcdef01\n')
  })

  it('requested cache hit with replay → raw stream, no one-liner', () => {
    const out = sink()
    const log = defaultLogger(NO_COLORS, { mode: 'focused' }, out)
    const n = mkNode('one#test', { requested: true })
    log.taskStdout(n, 'replayed\n')
    log.taskComplete(n, mkOutcome(n, 'cache-hit', { restored: true }))
    expect(out.text()).toBe('replayed\n')
  })

  it('requested skipped → frame (the news is it did not run)', () => {
    const out = sink()
    const log = defaultLogger(NO_COLORS, { mode: 'focused' }, out)
    const n = mkNode('one#test', { requested: true })
    log.taskComplete(n, mkOutcome(n, 'skipped'))
    expect(out.text()).toContain('skipped (upstream failed)')
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
    const text = out.text()
    expect(text).toContain('┌─ lib#build')
    expect(text).toContain('tsc exploded')
    expect(text).toContain('failed (exit 2)')
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
    expect(text).toContain('executed')
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
    expect(out.text()).toContain('failed (exit 1)')
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
    expect(text()).toContain('● one#fresh ── executed •')
    expect(text()).not.toContain('FRESH-OUTPUT')
    // Cache hit: completely silent per-task (no replay, no one-liner).
    expect(text()).not.toContain('CACHED-OUTPUT')
    expect(text()).not.toContain('◌')
    // Failure: full frame.
    expect(text()).toContain('┌─ one#boom')
    expect(text()).toContain('failed (exit 7)')
    // Summary still prints.
    expect(text()).toContain('Tasks:')
    expect(text()).toContain('Failed:    one#boom')
  })

  it('focused run streams requested output raw and silences successful deps', async () => {
    const path = await import('node:path')
    process.chdir(path.join(workspaceRoot, 'packages', 'one'))
    const text = captureStdout()
    const code = await cliRun(['run', 'consume'])
    expect(code).toBe(0)
    // Requested task streams raw — no frame around its output.
    expect(text()).toContain('CONSUME-OUTPUT')
    expect(text()).not.toContain('┌─ one#consume')
    // Successful dependency is silent.
    expect(text()).not.toContain('DEP-NOISE')
    expect(text()).not.toContain('one#dep ──')
  })

  it('focused run frames a failing dependency and the skipped requested task', async () => {
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
    expect(text()).toContain('skipped (upstream failed)')
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
})
