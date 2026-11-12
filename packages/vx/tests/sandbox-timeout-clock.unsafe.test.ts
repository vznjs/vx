// `exec.timeout` bounds the task, timed from its spawn by the runner. Core
// also put the timeout on the local executor's request signal, armed before
// the sandbox's wrap: a wrap slower than the timeout aborted the request,
// and the task was reported "timed out — killed" and retried without ever
// having run.
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'bun:test'
import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import { run } from './helpers/orchestrator.js'
import { addProject, makeWorkspace } from './helpers/workspace.js'
import { sandboxAvailable } from './helpers/sandbox-gate.js'

const available = await sandboxAvailable('sandbox timeout clock test')

const silent = { status() {}, taskStdout() {}, taskStderr() {}, taskComplete() {} }

describe.skipIf(!available)("a sandboxed task's timeout starts at its spawn", () => {
  let root = ''
  afterEach(async () => {
    vi.restoreAllMocks()
    await rm(root, { recursive: true, force: true })
  })

  async function runWithWrapDelay(wrapDelayMs: number, command: string) {
    root = await makeWorkspace({ prefix: 'vx-sbx-clock-' })
    const dir = await addProject(
      root,
      'p',
      `export default {
        tasks: {
          build: {
            exec: {
              command: ${JSON.stringify(command)},
              timeout: '1s',
              retries: 1,
              sandbox: { allow: { write: ['marker.txt'] } },
            },
          },
        },
      }
      `,
    )
    const wrap = SandboxManager.wrapWithSandbox.bind(SandboxManager)
    vi.spyOn(SandboxManager, 'wrapWithSandbox').mockImplementation(async (...a) => {
      await Bun.sleep(wrapDelayMs)
      return wrap(...a)
    })
    const r = await run({ cwd: root, tasks: ['build'], projects: ['p'], log: silent })
    const o = r.outcomes[0]!
    return [o.status, o.attempts?.count ?? 1, existsSync(path.join(dir, 'marker.txt'))]
  }

  it('a wrap slower than the timeout does not time the task out', async () => {
    expect(await runWithWrapDelay(1500, 'echo ran > marker.txt')).toEqual(['success', 1, true])
  }, 30_000)

  it('CONTROL: a task that outlives its timeout is still killed', async () => {
    expect(await runWithWrapDelay(0, 'sleep 5; echo ran > marker.txt')).toEqual([
      'failed',
      2,
      false,
    ])
  }, 30_000)
})

// A sandboxed task's duration is elapsed time too: a wall clock step back
// mid-task gave a negative `durationMs`, which the executor check refuses.
describe.skipIf(!available)('a wall clock step under a sandboxed task', () => {
  let root = ''
  afterEach(async () => {
    vi.restoreAllMocks()
    await rm(root, { recursive: true, force: true })
  })

  it('the task succeeds with a sane duration', async () => {
    root = await makeWorkspace({ prefix: 'vx-sbx-step-' })
    await addProject(
      root,
      'p',
      `export default {
        tasks: { build: { exec: { command: 'echo go; sleep 0.1', sandbox: {} } } },
      }
      `,
    )
    const real = Date.now.bind(Date)
    let step = 0
    vi.spyOn(Date, 'now').mockImplementation(() => real() + step)
    const r = await run({
      cwd: root,
      tasks: ['build'],
      projects: ['p'],
      log: {
        ...silent,
        taskStdout(_node: unknown, chunk: string) {
          if (chunk.includes('go')) step = -3_600_000
        },
      },
    })
    const o = r.outcomes[0]!
    expect(o.status).toBe('success')
    expect(o.durationMs).toBeGreaterThanOrEqual(0)
    expect(o.durationMs).toBeLessThan(60_000)
  }, 30_000)
})
