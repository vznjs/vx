// A task's duration is elapsed time, not a difference of wall clocks: an
// NTP step back mid-task gave a negative `durationMs`, the executor result
// check refused it, and a task that exited 0 failed the run ("durationMs is
// -3599787"); a step forward recorded an hour into the timings history.
import { rm } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'bun:test'
import { runCommand } from '../src/exec/runner.js'
import { run } from './helpers/orchestrator.js'
import { addProject, makeWorkspace } from './helpers/workspace.js'

const HOUR_MS = 3_600_000

/** Steps `Date.now()` by `stepMs` from the next call on. */
function stepClock(): (stepMs: number) => void {
  const real = Date.now.bind(Date)
  let step = 0
  vi.spyOn(Date, 'now').mockImplementation(() => real() + step)
  return (stepMs) => {
    step = stepMs
  }
}

describe('a wall clock step mid-task', () => {
  let root = ''
  afterEach(async () => {
    vi.restoreAllMocks()
    if (root !== '') await rm(root, { recursive: true, force: true })
    root = ''
  })

  for (const stepMs of [-HOUR_MS, HOUR_MS]) {
    it(`runCommand times the task by elapsed time (step ${stepMs} ms)`, async () => {
      const step = stepClock()
      const running = runCommand({ command: 'sleep 0.05', cwd: process.cwd(), env: process.env })
      step(stepMs)
      const r = await running
      expect(r.exitCode).toBe(0)
      expect(r.durationMs).toBeGreaterThanOrEqual(0)
      expect(r.durationMs).toBeLessThan(60_000)
    })
  }

  it('a task the clock steps back under still succeeds, its dependant runs', async () => {
    root = await makeWorkspace({ prefix: 'vx-clock-step-' })
    await addProject(
      root,
      'p',
      `export default {
        tasks: {
          build: { exec: { command: 'echo go; sleep 0.1' } },
          test: { dependsOn: ['build'], exec: { command: 'true' } },
        },
      }
      `,
    )
    const step = stepClock()
    const r = await run({
      cwd: root,
      tasks: ['test'],
      projects: ['p'],
      log: {
        status() {},
        taskStdout(_node: unknown, chunk: string) {
          if (chunk.includes('go')) step(-HOUR_MS)
        },
        taskStderr() {},
        taskComplete() {},
      },
    })
    const byTask = Object.fromEntries(r.outcomes.map((o) => [o.node.taskName, o]))
    expect([byTask['build']?.status, byTask['test']?.status]).toEqual(['success', 'success'])
    expect(byTask['build']!.durationMs).toBeGreaterThanOrEqual(0)
    expect(byTask['build']!.durationMs).toBeLessThan(60_000)
  }, 30_000)
})
