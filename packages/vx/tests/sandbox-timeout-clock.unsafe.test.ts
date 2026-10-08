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
import { run } from '../src/orchestrator/index.js'
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
              timeout: 1000,
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
    return [o.status, o.attempts ?? 1, existsSync(path.join(dir, 'marker.txt'))]
  }

  it('a wrap slower than the timeout does not time the task out', async () => {
    expect(await runWithWrapDelay(1500, 'echo ran > marker.txt')).toEqual(['success', 1, true])
  }, 20_000)

  it('CONTROL: a task that outlives its timeout is still killed', async () => {
    expect(await runWithWrapDelay(0, 'sleep 5; echo ran > marker.txt')).toEqual([
      'failed',
      2,
      false,
    ])
  }, 20_000)
})
