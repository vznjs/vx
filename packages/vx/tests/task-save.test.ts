// The one save verdict of a miss (task-save.ts `saveVerdict`), branch by
// branch, on a fake run: each check after the command withholds the save
// on its own, and says why.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import type { TaskConfig } from '../src/config.js'
import type { CacheLayer } from '../src/cache/index.js'
import type { ExecuteResult } from '../src/exec/index.js'
import type { TaskNode } from '../src/graph/index.js'
import type { ExecuteArgs, RunContext } from '../src/orchestrator/execute-task.js'
import type { Attempts } from '../src/orchestrator/attempts.js'
import type { KeyCheck, StateStamp } from '../src/orchestrator/input-recheck.js'
import type { MissRun } from '../src/orchestrator/miss-run.js'
import { saveVerdict } from '../src/orchestrator/task-save.js'
import { taskPolicy } from '../src/orchestrator/task-policy.js'
import type { FingerprintWatch } from '../src/orchestrator/fingerprint-watch.js'

type ArgsOver = Partial<Omit<ExecuteArgs, 'run'>> & { run?: Partial<RunContext> }

const cached: TaskConfig = {
  exec: { command: 'build' },
  cache: true,
  inputs: { files: ['src/**'] },
  outputs: { files: ['dist/**'] },
}

interface Fake {
  over?: ArgsOver
  exitCode?: number
  result?: Partial<ExecuteResult>
  leftRunning?: boolean
  own?: object | undefined
  /** The key re-derived before the command already disagreed. */
  staleDescribe?: boolean
  projectDir?: string
}

function fake(f: Fake = {}): { m: MissRun; ran: Attempts; warned: string[] } {
  const warned: string[] = []
  const node = {
    id: 'p#build',
    projectName: 'p',
    projectDir: f.projectDir ?? '/ws/p',
    taskName: 'build',
    config: cached,
    deps: [],
    requested: true,
  } as TaskNode
  const args: ExecuteArgs = {
    node,
    upstream: [],
    log: { warn: (l: string) => warned.push(l) } as unknown as ExecuteArgs['log'],
    executor: { name: 'local' } as ExecuteArgs['executor'],
    nestedProjectDirs: [],
    ...f.over,
    run: {
      workspaceRoot: '/ws',
      cache: { hasRemote: false } as unknown as CacheLayer,
      runStartHrTimeNs: 0n,
      keyedProjects: () => new Set(),
      // `'unchecked'` keeps the re-check off the disk: the key holds unless
      // the describe already disagreed.
      inputStability: { run: { strategy: 'unchecked' } },
      ...f.over?.run,
    },
  }
  const m = {
    args,
    policy: taskPolicy(args),
    hash: 'k',
    inputs: {
      captured: [],
      described: {
        hash: f.staleDescribe === true ? 'other' : 'k',
        facts: [],
        added: () => undefined,
      },
      inputs: undefined,
      inputChanges: undefined,
      commandFrom: 0,
      keyed: (x: unknown) => x,
    },
    guard: { own: async () => ('own' in f ? f.own : {}) },
    sandbox: {
      violations: [],
      placeholders: [],
      withheld: [],
      upstreamOutputs: [],
      writes: undefined,
    },
  } as unknown as MissRun
  const ran: Attempts = {
    result: { exitCode: 0, durationMs: 1, stdout: '', stderr: '', violations: [], ...f.result },
    exitCode: f.exitCode ?? 0,
    attempts: 1,
    spentMs: 1,
    failedAttempts: [],
    attemptOutputs: [],
    leftRunning: f.leftRunning === true,
  }
  return { m, ran, warned }
}

const NO_STATE = { state: undefined, from: 0 }

async function verdictOf(f: Fake = {}, stamp: StateStamp = NO_STATE) {
  const { m, ran, warned } = fake(f)
  const check: KeyCheck = { unkeyed: false }
  const v = await saveVerdict(m, ran, check, stamp)
  return { v, check, warned }
}

describe('saveVerdict: may this task save', () => {
  it('a planned pass whose checks all hold is saved with its own outputs', async () => {
    const { v, warned } = await verdictOf({ own: { ownOutputFiles: ['a'] } })
    expect(v).toEqual({ kind: 'save', own: { ownOutputFiles: ['a'] } })
    expect(warned).toEqual([])
  })

  it('a failure is never saved: its outputs are marked', async () => {
    expect((await verdictOf({ exitCode: 1 })).v).toEqual({ kind: 'mark' })
  })

  it('a pass no save was planned for (a tainted upstream) is marked, not saved', async () => {
    expect((await verdictOf({ over: { taintedUpstream: true } })).v).toEqual({ kind: 'mark' })
  })

  it('with no dependant, an unsaved run only counts its outputs', async () => {
    expect((await verdictOf({ exitCode: 1, over: { noDependants: true } })).v).toEqual({
      kind: 'count',
    })
  })

  it('a task not cached here (no cache block, remote-only, deferred) gets nothing', async () => {
    const plain: TaskConfig = { exec: { command: 'build' }, inputs: { files: ['src/**'] } }
    const overs: ArgsOver[] = [
      { node: { ...fake().m.args.node, config: plain } },
      { remoteOnly: true },
      { download: 'deferred' },
    ]
    for (const over of overs) {
      expect((await verdictOf({ exitCode: 1, over })).v).toEqual({ kind: 'none' })
    }
  })

  it('a process the shell left running withholds the save, and says so', async () => {
    const { v, warned } = await verdictOf({ leftRunning: true })
    expect(v).toEqual({ kind: 'mark' })
    expect(warned.join('\n')).toContain('a process it left running may still write its outputs')
  })

  it('a key the describe already disagreed with withholds the save and unkeys the task', async () => {
    const { v, check, warned } = await verdictOf({ staleDescribe: true })
    expect(v).toEqual({ kind: 'mark' })
    expect(check).toMatchObject({ unkeyed: true, drifted: null })
    expect(warned.join('\n')).toContain('its inputs changed after its key was taken')
  })

  it('a moved lockfile withholds the save and unkeys the task', async () => {
    const said: string[] = []
    const watch = {
      names: ['bun.lock'],
      moved: () => ['bun.lock'],
      say: () => said.push('moved'),
    } as unknown as FingerprintWatch
    const { v, check } = await verdictOf({ over: { run: { fingerprintWatch: watch } } })
    expect(v).toEqual({ kind: 'mark' })
    expect(check.unkeyed).toBe(true)
    expect(said).toEqual(['moved'])
  })

  it('undeclared ignored state the command wrote withholds the save, and says so', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'vx-save-state-'))
    try {
      // Stamped absent before the command; there after it.
      const stamp: StateStamp = {
        state: new Map([[path.join(dir, '.cache/state'), undefined]]),
        from: Date.now(),
      }
      mkdirSync(path.join(dir, '.cache'))
      writeFileSync(path.join(dir, '.cache/state'), 'x')
      const { v, warned } = await verdictOf({ projectDir: dir }, stamp)
      expect(v).toEqual({ kind: 'mark' })
      expect(warned.join('\n')).toContain('.cache/state changed while the task ran')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a server that died under the task withholds the save', async () => {
    const { v } = await verdictOf({ over: { run: { serverDiedUnder: async () => true } } })
    expect(v).toEqual({ kind: 'mark' })
  })

  it('outputs that are not its own (a removed found file) withhold the save', async () => {
    expect((await verdictOf({ own: undefined })).v).toEqual({ kind: 'mark' })
  })

  it('the checks run in order and stop at the first that fails', async () => {
    let asked = false
    const { v } = await verdictOf({
      leftRunning: true,
      over: {
        run: {
          serverDiedUnder: async () => {
            asked = true
            return false
          },
        },
      },
    })
    expect(v).toEqual({ kind: 'mark' })
    expect(asked).toBe(false)
  })

  it('deferred outputs: registered under the key only while it holds', async () => {
    const materialize = async (): Promise<void> => {}
    const deferred = { outputs: { kind: 'deferred' as const, materialize } }
    expect((await verdictOf({ result: deferred })).v).toEqual({
      kind: 'defer',
      materialize,
      keyed: true,
    })
    expect((await verdictOf({ result: deferred, staleDescribe: true })).v).toEqual({
      kind: 'defer',
      materialize,
      keyed: false,
    })
    expect(
      (await verdictOf({ result: deferred, over: { run: { serverDiedUnder: async () => true } } }))
        .v,
    ).toEqual({ kind: 'defer', materialize, keyed: false })
  })

  it('a deferral the executor ignored saves nothing here', async () => {
    expect((await verdictOf({ over: { download: 'deferred' } })).v).toEqual({
      kind: 'defer',
      keyed: false,
    })
  })

  it('a failed deferred task gets nothing', async () => {
    const { v } = await verdictOf({ exitCode: 1, over: { download: 'deferred' } })
    expect(v).toEqual({ kind: 'none' })
  })
})
