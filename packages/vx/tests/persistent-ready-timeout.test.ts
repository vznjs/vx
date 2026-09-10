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
      const dir = await addProject(
        fixture.root,
        'slow',
        `export default {
          tasks: {
            build: {
              exec: { command: 'echo $$ > pid.txt && exec sleep 30', timeout: 300 },
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
      // The timeout note streamed into the task's output.
      expect(fixture.err.join('\n')).toContain('timed out after 300ms')
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
      // without the escalation: the child outlives the run by 30 s.
      const dir = await addProject(
        fixture.root,
        'srv',
        `export default {
          tasks: {
            dev: {
              exec: {
                command: "trap '' TERM; echo $$ > pid.txt && echo wrong-banner && exec sleep 30",
                timeout: 300,
                persistent: { readyWhen: 'Listening' },
              },
            },
          },
        }
        `,
      )
      const r = await run({ cwd: fixture.root, tasks: ['dev'], log: silentLogger(fixture) })
      expect(r.ok).toBe(false)
      const pid = Number(readFileSync(path.join(dir, 'pid.txt'), 'utf8').trim())
      expect(await waitForDead(pid, 1_000)).toBe(true)
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
                timeout: 300,
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
      // Fast failure, not a 30s hang on the sleep.
      expect(Date.now() - started).toBeLessThan(5000)
      // The reason reaches the TASK's stderr stream — the frame, and an
      // embedder's logger — not the process's stderr, which a custom
      // logger never sees (this pin used to assert the bare write).
      expect(fixture.err.join('\n')).toContain('not ready within 300ms')
      expect(stderrText).not.toContain('not ready within 300ms')
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
