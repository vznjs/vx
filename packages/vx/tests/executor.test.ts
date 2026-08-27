import { describe, expect, it } from 'bun:test'
import {
  selectExecutor,
  type ExecuteRequest,
  type TaskExecutor,
  type TaskPlacement,
} from '../src/exec/index.js'
import { localExecutor } from '../src/plugins/local-executor/index.js'

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
