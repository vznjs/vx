import { describe, expect, it } from 'bun:test'
import {
  assertExecuteResult,
  selectExecutor,
  type ExecuteRequest,
  type TaskExecutor,
  type TaskPlacement,
} from '../src/exec/index.js'
import { localExecutor } from '../src/exec/local-executor.js'

function req(over: Partial<ExecuteRequest> = {}): ExecuteRequest {
  return {
    taskId: 'pkg-a#hello',
    workspaceRoot: process.cwd(),
    command: 'echo hi',
    forwardArgs: [],
    cwd: process.cwd(),
    env: { PATH: process.env['PATH'] ?? '' },
    envDefine: {},
    capture: { stdout: true, stderr: true },
    onStdout: () => undefined,
    onStderr: () => undefined,
    outputs: { files: [], workspaceFiles: [] },
    ...over,
  }
}

function placement(over: Partial<TaskPlacement> = {}): TaskPlacement {
  return {
    taskId: 'pkg-a#hello',
    projectName: 'pkg-a',
    projectDir: process.cwd(),
    command: 'echo hi',
    pinnedLocal: false,
    cacheable: true,
    ...over,
  }
}

describe('localExecutor', () => {
  it('runs the command in cwd and returns exit code, stdout and no violations', async () => {
    const chunks: string[] = []
    const res = await localExecutor().execute(
      req({ command: 'echo hi && exit 3', onStdout: (c) => chunks.push(c) }),
    )
    expect(res.exitCode).toBe(3)
    expect(res.stdout).toBe('hi\n')
    expect(chunks.join('')).toBe('hi\n')
    expect(res.violations).toEqual([])
  })

  it('appends forwardArgs to the command line, shell-quoted', async () => {
    // runCommand builds `command + ' ' + forwardArgs.map(shellQuote).join(' ')`
    // (src/exec/runner.ts, runCommand), so the args reach printf as two
    // operands — the one with a space survives quoting intact.
    const res = await localExecutor().execute(
      req({ command: 'printf "%s|"', forwardArgs: ['a b', 'c'] }),
    )
    expect(res.exitCode).toBe(0)
    expect(res.stdout).toBe('a b|c|')
  })

  it('flags a timeout as timedOut with a non-zero exit', async () => {
    const res = await localExecutor().execute(req({ command: 'sleep 5', timeoutMs: 100 }))
    expect(res.timedOut).toBe(true)
    expect(res.exitCode).not.toBe(0)
  })

  it('forwards the callbacks, the capture config and the kill set', async () => {
    // This executor is core's FLOOR, so a field it drops is a feature that
    // stops working with no plugin in sight and nothing to point at. All
    // three below are silent losses: the type checker cannot see them
    // (every one is optional) and no other row exercised them.
    class Recording extends Set<ReturnType<typeof Bun.spawn>> {
      adds = 0
      override add(child: ReturnType<typeof Bun.spawn>): this {
        this.adds++
        return super.add(child)
      }
    }
    const live = new Recording()
    let out = ''
    let err = ''
    const res = await localExecutor().execute(
      req({
        command: 'echo to-stderr 1>&2; echo to-stdout',
        liveChildren: live,
        onStdout: (c) => {
          out += c
        },
        onStderr: (c) => {
          err += c
        },
      }),
    )
    // `liveChildren` is the set the orchestrator's SIGINT/SIGTERM handler
    // kills. Unforwarded, Ctrl+C leaves this child running past the run.
    expect([live.adds, live.size]).toEqual([1, 0]) // registered, then retired
    expect([out, err]).toEqual(['to-stdout\n', 'to-stderr\n'])
    expect(res.exitCode).toBe(0)
    // `capture` decides what the RESULT keeps; unforwarded, a caller that
    // asked for neither stream gets both.
    const dropped = await localExecutor().execute(
      req({ command: 'echo kept 1>&2; echo kept', capture: { stdout: false, stderr: false } }),
    )
    expect([dropped.stdout, dropped.stderr]).toEqual(['', ''])
  })

  it('is named local', () => {
    expect(localExecutor().name).toBe('local')
  })
})

describe('selectExecutor', () => {
  const accepting: TaskExecutor = { name: 'a', execute: () => Promise.reject(new Error('unused')) }
  const declining: TaskExecutor = {
    name: 'd',
    accepts: () => false,
    execute: () => Promise.reject(new Error('unused')),
  }

  it('picks the first executor in order whose accepts() is absent or true', () => {
    expect(selectExecutor([declining, accepting], placement())).toBe(accepting)
    expect(selectExecutor([accepting, declining], placement())).toBe(accepting)
  })

  it('never offers a pinned-local task to a remote executor, even one that accepts everything', () => {
    const remote: TaskExecutor = {
      name: 'r',
      remote: true,
      execute: () => Promise.reject(new Error('unused')),
    }
    expect(selectExecutor([remote, accepting], placement({ pinnedLocal: true }))).toBe(accepting)
    expect(selectExecutor([remote, accepting], placement({ pinnedLocal: false }))).toBe(remote)
  })

  it('passes the placement to accepts()', () => {
    const seen: string[] = []
    const spy: TaskExecutor = {
      name: 's',
      accepts: (r) => {
        seen.push(r.taskId)
        return false
      },
      execute: () => Promise.reject(new Error('unused')),
    }
    selectExecutor([spy, accepting], placement({ taskId: 'x#y' }))
    expect(seen).toEqual(['x#y'])
  })

  it('throws when every executor declines', () => {
    expect(() => selectExecutor([declining], placement())).toThrow(
      /no executor accepted pkg-a#hello/,
    )
  })
})

// The seam's boundary check, and the bug it was written for: a plugin that
// resolved `{}` met `res.violations` in core and surfaced as "internal error
// in <task>: TypeError" — vx's crash for the plugin's bug (2026-09-16). One
// row pins it end to end in `execute-task.test.ts`, through a real plugin
// executor, with `exitCode` missing. That leaves every OTHER field of a
// nine-armed guard unspelled — `violations` among them, the very field that
// crashed core. Each row below names its arm and asserts the exact sentence.
describe('assertExecuteResult — what a plugin executor may resolve', () => {
  const ok = { exitCode: 0, durationMs: 1, stdout: '', stderr: '', violations: [] }
  const refusal = (res: unknown): string => {
    try {
      assertExecuteResult('org/x', 'p#t', res)
    } catch (err) {
      return err instanceof Error ? err.message : String(err)
    }
    return 'ACCEPTED'
  }
  /** The refusal's `what` clause, inside the sentence the user reads. */
  const says = (what: string): string =>
    `executor 'org/x' returned an invalid result for p#t: ${what} — a plugin bug, not a task failure`

  it('the field that crashed core: a result with no `violations` is refused by name', () => {
    // The whole sentence, once, so the prefix and the "not a task failure"
    // suffix are pinned too; the rows below assert the clause that varies.
    expect(refusal({ ...ok, violations: undefined })).toBe(
      "executor 'org/x' returned an invalid result for p#t: violations is undefined (expected an array) — a plugin bug, not a task failure",
    )
    // And a non-array `violations` is refused, not merely a missing one: an
    // object passes `!== undefined` and still has no `.length` to walk.
    expect(refusal({ ...ok, violations: {} })).toBe(
      says('violations is object (expected an array)'),
    )
  })

  it('a result that is not an object at all is refused before any field is read', () => {
    // `null` is the arm that would otherwise throw a TypeError on the first
    // property read — the internal error this function exists to replace.
    expect(refusal(null)).toBe(says('null (expected an object)'))
    expect(refusal('ok')).toBe(says('string (expected an object)'))
  })

  it('every scalar field is checked, not just the first of each pair', () => {
    expect(refusal({ ...ok, exitCode: undefined })).toBe(
      says('exitCode is undefined (expected a number)'),
    )
    expect(refusal({ ...ok, durationMs: '5' })).toBe(
      says('durationMs is string (expected a number)'),
    )
    expect(refusal({ ...ok, stdout: undefined })).toBe(
      says('stdout is undefined (expected a string)'),
    )
    expect(refusal({ ...ok, stderr: 7 })).toBe(says('stderr is number (expected a string)'))
  })

  it('a deferred outputs handle without a materialize() is refused', () => {
    // Core calls `materialize()` lazily and at most once; a `deferred` that
    // cannot be materialised loses the task's outputs with the run green.
    expect(refusal({ ...ok, outputs: { kind: 'deferred' } })).toBe(
      says('outputs.kind is deferred without a materialize()'),
    )
    expect(refusal({ ...ok, outputs: { kind: 'remote' } })).toBe(
      says('outputs.kind is remote (expected disk or deferred)'),
    )
    expect(refusal({ ...ok, outputs: 'disk' })).toBe(says('outputs is not an object'))
    expect(refusal({ ...ok, outputs: null })).toBe(says('outputs is not an object'))
  })

  it('CONTROL: the shapes a correct executor resolves all pass', () => {
    // `outputs` ABSENT is the ordinary case — every executor before deferral
    // existed resolved exactly this — so the guard must not require it.
    expect(refusal(ok)).toBe('ACCEPTED')
    expect(refusal({ ...ok, outputs: { kind: 'disk' } })).toBe('ACCEPTED')
    expect(
      refusal({ ...ok, outputs: { kind: 'deferred', materialize: () => Promise.resolve() } }),
    ).toBe('ACCEPTED')
    // Extra fields an executor may add (`where`) are not the guard's business.
    expect(refusal({ ...ok, where: 'worker-3' })).toBe('ACCEPTED')
  })
})
