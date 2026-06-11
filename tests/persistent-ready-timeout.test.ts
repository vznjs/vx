// persistent.readyTimeoutMs — bounds the readiness wait. Without it,
// a persistent task whose readyWhen never matches while the child
// stays alive hangs the run forever (found while refuting the
// zombie-child report, June 2026).

import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'bun:test'
import type { Logger } from '../src/orchestrator.js'
import { run } from '../src/orchestrator.js'
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
  const root = await mkdtemp(path.join(os.tmpdir(), 'vx-readyto-'))
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

describe('persistent.readyTimeoutMs', () => {
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
                command: 'echo $$ > pid.txt && echo wrong-banner && sleep 30',
                persistent: { readyWhen: 'Listening', readyTimeoutMs: 300 },
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
      // The child must be dead once the run returns.
      const pid = Number(readFileSync(path.join(dir, 'pid.txt'), 'utf8').trim())
      await Bun.sleep(200)
      let alive = true
      try {
        process.kill(pid, 0)
      } catch {
        alive = false
      }
      expect(alive).toBe(false)
    },
    TIMEOUT,
  )

  it(
    'marker before the deadline → success, timer does not kill a healthy server',
    async () => {
      const dir = await addProject(
        fixture.root,
        'srv',
        `export default {
          tasks: {
            dev: {
              exec: {
                command: 'echo Listening on :3000 && echo lived > lived.txt && sleep 30',
                persistent: { readyWhen: 'Listening', readyTimeoutMs: 5000 },
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

  describe('loader validation', () => {
    let dir: string
    beforeEach(async () => {
      dir = await mkdtemp(path.join(os.tmpdir(), 'vx-readyto-loader-'))
    })
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true })
    })

    const load = async (persistent: string) => {
      const file = path.join(dir, 'vx.config.mjs')
      await writeFile(
        file,
        `export default { tasks: { dev: { exec: { command: 'x', persistent: ${persistent} } } } }`,
      )
      return loadProjectConfig(file)
    }

    it('rejects readyTimeoutMs without readyWhen', async () => {
      await expect(load(`{ readyTimeoutMs: 1000 }`)).rejects.toThrow(/requires.*readyWhen/)
    })

    it('rejects non-positive-integer readyTimeoutMs', async () => {
      await expect(load(`{ readyWhen: 'up', readyTimeoutMs: 0 }`)).rejects.toThrow(
        /positive integer/,
      )
      await expect(load(`{ readyWhen: 'up', readyTimeoutMs: 1.5 }`)).rejects.toThrow(
        /positive integer/,
      )
      await expect(load(`{ readyWhen: 'up', readyTimeoutMs: '5s' }`)).rejects.toThrow(
        /positive integer/,
      )
    })

    it('accepts readyWhen + positive integer readyTimeoutMs', async () => {
      const cfg = await load(`{ readyWhen: 'up', readyTimeoutMs: 30000 }`)
      expect(cfg.tasks?.dev?.exec?.persistent?.readyTimeoutMs).toBe(30000)
    })
  })
})
