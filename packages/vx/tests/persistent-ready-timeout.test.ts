// exec.timeout — the single timeout knob. For a NORMAL task it bounds
// the run time (SIGTERM + reported failed). For a PERSISTENT task it
// bounds the readiness wait: without it, a persistent task whose
// readyWhen never matches while the child stays alive hangs the run
// forever (found while refuting the zombie-child report, June 2026).

import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'bun:test'
import { isAlive, waitForDead } from './helpers/alive.js'
import { addProject, makeWorkspace as makeWorkspaceRoot } from './helpers/workspace.js'
import type { Logger } from '../src/orchestrator/index.js'
import { run } from '../src/orchestrator/index.js'
import { loadProjectConfig } from '../src/workspace/project-loader.js'

process.env['VX_KILL_GRACE_MS'] = '200'

const TIMEOUT = 15_000

interface Fixture {
  root: string
  log: string[]
  err: string[]
}

let fixture: Fixture

const silentLogger = (f: Fixture): Logger => ({
  status(line) {
    f.log.push(line)
  },
  taskStdout() {},
  taskStderr(_node, chunk) {
    f.err.push(chunk.trimEnd())
  },
  taskComplete(node, outcome) {
    f.log.push(`task ${node.id} ${outcome.status}`)
  },
})

async function makeWorkspace(): Promise<Fixture> {
  const root = await makeWorkspaceRoot({ prefix: 'vx-ready-timeout-' })
  return { root, log: [], err: [] }
}

describe('exec.timeout — normal task', () => {
  beforeEach(async () => {
    fixture = await makeWorkspace()
  })
  afterEach(async () => {
    await rm(fixture.root, { recursive: true, force: true })
  })

  it(
    'a task that overruns is SIGTERMed, reported failed, and not cached',
    async () => {
      // The deadlines here are 1 s: `pid.txt` is written before them only
      // if the shell has started, and a slow start lost it at 300 ms (M-24).
      const dir = await addProject(
        fixture.root,
        'slow',
        `export default {
          tasks: {
            build: {
              exec: { command: 'echo $$ > pid.txt && exec sleep 30', timeout: 1000 },
              cache: { inputs: { files: ['package.json'] }, outputs: { files: [] } },
            },
          },
        }
        `,
      )
      const started = Date.now()
      const r = await run({ cwd: fixture.root, tasks: ['build'], log: silentLogger(fixture) })
      // Fast failure, not a 30s hang on the sleep.
      expect(Date.now() - started).toBeLessThan(5000)
      expect(r.ok).toBe(false)
      expect(r.outcomes[0]!.status).toBe('failed')
      expect(r.outcomes[0]!.exitCode).toBe(143)
      // The timeout note streamed into the task's output.
      expect(fixture.err.join('\n')).toContain('timed out after 1000ms')
      // The child must be dead once the run returns. `exec` in the fixture is
      // what gives this assertion teeth: `$$` is the shell's pid and exec keeps
      // that pid while replacing the image, so pid.txt names the SLEEPER. As a
      // plain compound the shell died on SIGTERM and the sleeper was orphaned —
      // this check passed while the real process ran on for another 30s.
      const pid = Number(readFileSync(path.join(dir, 'pid.txt'), 'utf8').trim())
      await Bun.sleep(200)
      expect(isAlive(pid)).toBe(false)
    },
    TIMEOUT,
  )

  it(
    'a task that finishes within the budget is unaffected',
    async () => {
      await addProject(
        fixture.root,
        'quick',
        `export default {
          tasks: {
            build: { exec: { command: 'echo done', timeout: 10000 } },
          },
        }
        `,
      )
      const r = await run({ cwd: fixture.root, tasks: ['build'], log: silentLogger(fixture) })
      expect(r.ok).toBe(true)
      expect(r.outcomes[0]!.status).toBe('success')
    },
    TIMEOUT,
  )
})

describe('exec.timeout — persistent task (readiness bound)', () => {
  beforeEach(async () => {
    fixture = await makeWorkspace()
  })

  afterEach(async () => {
    await rm(fixture.root, { recursive: true, force: true })
  })

  it(
    'a never-ready server that ignores SIGTERM is SIGKILLed after the grace',
    async () => {
      // `trap '' TERM` survives exec, so the readiness timeout's SIGTERM
      // lands on a sleeper that shrugs it off; not in the persistent
      // registry (never ready), nothing else would ever kill it. Fails
      // without the escalation: the child outlives the run by 30 s. A 1 s
      // deadline: at 300 ms a TERM before the trap left no pid.txt (M-23).
      const dir = await addProject(
        fixture.root,
        'srv',
        `export default {
          tasks: {
            dev: {
              exec: {
                command: "trap '' TERM; echo $$ > pid.txt && echo wrong-banner && exec sleep 30",
                timeout: 1000,
                persistent: { readyWhen: 'Listening' },
              },
            },
          },
        }
        `,
      )
      const r = await run({ cwd: fixture.root, tasks: ['dev'], log: silentLogger(fixture) })
      expect(r.ok).toBe(false)
      // X-24: the SIGKILL's exit, as an ordinary timeout reports it, not a made-up 1.
      expect(r.outcomes[0]!.exitCode).toBe(137)
      const pid = Number(readFileSync(path.join(dir, 'pid.txt'), 'utf8').trim())
      expect(await waitForDead(pid, 1_000)).toBe(true)
    },
    TIMEOUT,
  )

  it(
    'a never-ready server that traps SIGTERM and exits 0 reports the SIGTERM, not 0',
    async () => {
      // The one-shot timeout's rule (a trap that exits 0 is still 143): the
      // frame read `failed (never ready: timed out, exit 0)` (X-116).
      await addProject(
        fixture.root,
        'srv',
        `export default {
          tasks: {
            dev: {
              exec: {
                command: "trap 'exit 0' TERM; echo wrong-banner; while :; do sleep 0.05; done",
                timeout: 500,
                persistent: { readyWhen: 'Listening' },
              },
            },
          },
        }
        `,
      )
      const r = await run({ cwd: fixture.root, tasks: ['dev'], log: silentLogger(fixture) })
      const { status, notReady, exitCode } = r.outcomes[0]!
      expect({ status, notReady, exitCode }).toEqual({
        status: 'failed',
        notReady: 'timeout',
        exitCode: 143,
      })
    },
    TIMEOUT,
  )

  // The frame reads `(<duration>) failed (never ready: timed out)`: the
  // duration was taken once the child had exited, so a server that traps
  // TERM reported the readiness timeout plus the whole kill grace.
  it(
    'a never-ready server reports the time it was waited on, not the kill grace after',
    async () => {
      await addProject(
        fixture.root,
        'srv',
        `export default {
          tasks: {
            dev: {
              exec: {
                command: "trap '' TERM; echo wrong-banner && exec sleep 30",
                timeout: 500,
                persistent: { readyWhen: 'Listening' },
              },
            },
          },
        }
        `,
      )
      process.env['VX_KILL_GRACE_MS'] = '2000'
      try {
        const r = await run({ cwd: fixture.root, tasks: ['dev'], log: silentLogger(fixture) })
        const { exitCode, durationMs } = r.outcomes[0]!
        expect({ exitCode, waited: durationMs >= 500 && durationMs < 1500 }).toEqual({
          exitCode: 137,
          waited: true,
        })
      } finally {
        process.env['VX_KILL_GRACE_MS'] = '200'
      }
    },
    TIMEOUT,
  )

  it(
    'a never-ready server whose shell dies on SIGTERM is dead before the task returns',
    async () => {
      // The shell exits on the TERM at once; its background server ignores
      // it and holds its port until the SIGKILL a grace later. The task
      // returned on the shell's exit, so the server outlived run() into the
      // next `vx watch` cycle.
      const dir = await addProject(
        fixture.root,
        'srv',
        `export default {
          tasks: {
            dev: {
              exec: {
                command: "sh -c \\"trap '' TERM; exec sleep 30\\" & echo $! > pid.txt; wait",
                timeout: 1000,
                persistent: { readyWhen: 'Listening' },
              },
            },
          },
        }
        `,
      )
      const r = await run({ cwd: fixture.root, tasks: ['dev'], log: silentLogger(fixture) })
      expect(r.outcomes[0]!.notReady).toBe('timeout')
      const pid = Number(readFileSync(path.join(dir, 'pid.txt'), 'utf8').trim())
      expect(isAlive(pid)).toBe(false)
    },
    TIMEOUT,
  )

  it(
    'never-matching readyWhen + timeout → run fails fast, child is killed',
    async () => {
      const dir = await addProject(
        fixture.root,
        'srv',
        `export default {
          tasks: {
            dev: {
              exec: {
                command: 'echo $$ > pid.txt && echo wrong-banner && exec sleep 30',
                timeout: 1000,
                persistent: { readyWhen: 'Listening' },
              },
            },
          },
        }
        `,
      )
      const started = Date.now()
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
      const r = await run({ cwd: fixture.root, tasks: ['dev'], log: silentLogger(fixture) })
      const stderrText = stderrSpy.mock.calls.map((c) => String(c[0])).join('')
      stderrSpy.mockRestore()
      expect(r.ok).toBe(false)
      expect(r.outcomes[0]!.status).toBe('failed')
      // The reason rides the outcome, so every label reads it (item 270).
      expect(r.outcomes[0]!.notReady).toBe('timeout')
      // X-24: the SIGTERM's exit, as the ordinary timeout above reports it.
      expect(r.outcomes[0]!.exitCode).toBe(143)
      // Fast failure, not a 30s hang on the sleep.
      expect(Date.now() - started).toBeLessThan(5000)
      // The reason reaches the TASK's stderr stream — the frame, and an
      // embedder's logger — not the process's stderr, which a custom
      // logger never sees (this pin used to assert the bare write).
      expect(fixture.err.join('\n')).toContain('not ready within 1000ms')
      expect(stderrText).not.toContain('not ready within 1000ms')
      // The child must be dead once the run returns. `exec` in the fixture is
      // what gives this assertion teeth: `$$` is the shell's pid and exec keeps
      // that pid while replacing the image, so pid.txt names the SLEEPER. As a
      // plain compound the shell died on SIGTERM and the sleeper was orphaned —
      // this check passed while the real process ran on for another 30s.
      const pid = Number(readFileSync(path.join(dir, 'pid.txt'), 'utf8').trim())
      await Bun.sleep(200)
      expect(isAlive(pid)).toBe(false)
    },
    TIMEOUT,
  )

  it(
    'marker before the deadline → success, timer does not kill a healthy server',
    async () => {
      const dir = await addProject(
        fixture.root,
        'srv',
        // lived.txt is written BEFORE the readiness marker on purpose: the
        // moment 'Listening' matches, the run completes and SIGTERMs the
        // persistent child — writing after the marker raced that teardown
        // (under runner load the kill landed first and the file never
        // appeared; flaked CI at ~150ms). The success assertions below carry
        // the "timer didn't kill a healthy server" meaning either way.
        `export default {
          tasks: {
            dev: {
              exec: {
                command: 'echo lived > lived.txt && echo Listening on :3000 && exec sleep 30',
                timeout: 5000,
                persistent: { readyWhen: 'Listening' },
              },
            },
          },
        }
        `,
      )
      const r = await run({ cwd: fixture.root, tasks: ['dev'], log: silentLogger(fixture) })
      expect(r.ok).toBe(true)
      expect(r.outcomes[0]!.status).toBe('success')
      expect(existsSync(path.join(dir, 'lived.txt'))).toBe(true)
    },
    TIMEOUT,
  )

  // The readiness timer SIGTERMed the group and the failed task's teardown
  // SIGTERMed it again a turn later: a server whose handler is a one-shot
  // (`process.once('SIGTERM', …)`, a trap that resets itself) died on the
  // second mid-cleanup, as abort.test.ts's stop did before it signalled
  // each group once. The marker it prints and the exit it makes on the way
  // down are the timeout's, not a ready server or an early exit.
  it(
    'a readiness timeout signals the group once, and its cleanup finishes',
    async () => {
      const dir = await addProject(
        fixture.root,
        'srv',
        `export default {
          tasks: {
            dev: {
              exec: {
                command: 'echo $$ > pid.txt; trap "trap - TERM; sleep 0.2; echo done > clean.txt; echo Listening; exit 0" TERM; echo booting; while :; do sleep 0.05; done',
                timeout: 500,
                persistent: { readyWhen: 'Listening' },
              },
            },
          },
        }
        `,
      )
      const grace = process.env['VX_KILL_GRACE_MS']
      process.env['VX_KILL_GRACE_MS'] = '3000'
      const kill = vi.spyOn(process, 'kill')
      try {
        const r = await run({ cwd: fixture.root, tasks: ['dev'], log: silentLogger(fixture) })
        expect([r.outcomes[0]!.status, r.outcomes[0]!.notReady]).toEqual(['failed', 'timeout'])
        const pid = Number(readFileSync(path.join(dir, 'pid.txt'), 'utf8').trim())
        const terms = kill.mock.calls.filter((c) => c[0] === -pid && c[1] === 'SIGTERM')
        expect(terms.length).toBe(1)
        expect(readFileSync(path.join(dir, 'clean.txt'), 'utf8')).toBe('done\n')
      } finally {
        kill.mockRestore()
        process.env['VX_KILL_GRACE_MS'] = grace
      }
    },
    TIMEOUT,
  )
})

describe('exec.timeout — loader validation', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'vx-timeout-loader-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const load = async (exec: string) => {
    const file = path.join(dir, 'vx.config.mjs')
    await writeFile(file, `export default { tasks: { dev: { exec: ${exec} } } }`)
    return loadProjectConfig(file)
  }

  it('rejects non-positive-integer timeout', async () => {
    await expect(load(`{ command: 'x', timeout: 0 }`)).rejects.toThrow(/positive integer/)
    await expect(load(`{ command: 'x', timeout: 1.5 }`)).rejects.toThrow(/positive integer/)
    await expect(load(`{ command: 'x', timeout: '5s' }`)).rejects.toThrow(/positive integer/)
  })

  it('accepts a positive integer timeout', async () => {
    const cfg = await load(`{ command: 'x', timeout: 30000 }`)
    expect(cfg.tasks?.dev?.exec?.timeout).toBe(30000)
  })

  it('accepts timeout on a ready-on-spawn persistent task (no-op, not an error)', async () => {
    const cfg = await load(`{ command: 'x', timeout: 1000, persistent: {} }`)
    expect(cfg.tasks?.dev?.exec?.timeout).toBe(1000)
  })
})
