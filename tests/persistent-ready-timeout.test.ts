// exec.timeout — the single timeout knob. For a NORMAL task it bounds
// the run time (SIGTERM + reported failed). For a PERSISTENT task it
// bounds the readiness wait: without it, a persistent task whose
// readyWhen never matches while the child stays alive hangs the run
// forever (found while refuting the zombie-child report, June 2026).

import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'bun:test'
import type { Logger } from '../src/orchestrator/index.js'
import { run } from '../src/orchestrator/index.js'
import { loadProjectConfig } from '../src/workspace/project-loader.js'

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
  const root = await mkdtemp(path.join(os.tmpdir(), 'vx-timeout-'))
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'fixture-root', private: true }, null, 2),
  )
  await mkdir(path.join(root, 'packages'), { recursive: true })
  const git = (...args: string[]) => {
    const p = Bun.spawnSync({
      cmd: ['git', '-c', 'commit.gpgsign=false', ...args],
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if (p.exitCode !== 0) throw new Error(new TextDecoder().decode(p.stderr))
  }
  git('init', '-q')
  git('config', 'user.email', 'test@vx.local')
  git('config', 'user.name', 'vx test')
  return { root, log: [], err: [] }
}

async function addProject(root: string, name: string, config: string): Promise<string> {
  const dir = path.join(root, 'packages', name)
  await mkdir(dir, { recursive: true })
  await writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({ name, version: '0.0.0' }, null, 2),
  )
  await writeFile(path.join(dir, 'vx.config.mjs'), config)
  return dir
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
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
      expect(stderrText).toContain('not ready within 300ms')
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
