// SIGINT/SIGTERM during `run()`: every live child (one-shot AND
// persistent) gets SIGTERM, the cache handle closes, and vx exits
// with 128+signo (130/143). The e2e tests spawn the real CLI as a
// subprocess because signal delivery + process exit can't be
// asserted in-process; the listener-leak test runs in-process
// because that's exactly where stacking handlers would hurt
// (watch loop, bun test).

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { run, type Logger } from '../src/orchestrator/index.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const TIMEOUT = 20_000

interface Fixture {
  root: string
}

async function makeWorkspace(): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vx-signal-'))
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'fixture-root', private: true }),
  )
  await mkdir(path.join(root, 'packages'), { recursive: true })
  // vx requires git for input enumeration.
  const git = (...args: string[]): void => {
    const p = Bun.spawnSync({
      cmd: ['git', '-c', 'commit.gpgsign=false', ...args],
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if (p.exitCode !== 0) {
      throw new Error(`git ${args.join(' ')} failed: ${new TextDecoder().decode(p.stderr)}`)
    }
  }
  git('init', '-q')
  git('config', 'user.email', 'test@vx.local')
  git('config', 'user.name', 'vx test')
  return { root }
}

async function addProject(root: string, name: string, config: string): Promise<string> {
  const dir = path.join(root, 'packages', name)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name, version: '0.0.0' }))
  await writeFile(path.join(dir, 'vx.config.mjs'), config)
  return dir
}

async function waitForFile(file: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await Bun.file(file).exists()) return
    await Bun.sleep(50)
  }
  throw new Error(`timed out waiting for ${file}`)
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitForDead(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true
    await Bun.sleep(50)
  }
  return !isAlive(pid)
}

const silentLogger: Logger = {
  status() {},
  taskStdout() {},
  taskStderr() {},
  taskComplete() {},
}

describe('signal handling during vx run (e2e)', () => {
  let fixture: Fixture
  beforeEach(async () => {
    fixture = await makeWorkspace()
  })
  afterEach(async () => {
    await rm(fixture.root, { recursive: true, force: true })
  })

  it(
    'SIGTERM kills the in-flight one-shot child and exits 143',
    async () => {
      // `exec` keeps the pid in pid.txt identical to vx's direct child,
      // so kill(pid, 0) probes exactly the process vx must reap.
      const dir = await addProject(
        fixture.root,
        'app',
        `
          export default {
            tasks: {
              slow: {
                exec: { command: 'echo $$ > pid.txt; echo started; exec sleep 30' },
              },
            },
          }
        `,
      )
      const proc = Bun.spawn([process.execPath, BIN, 'run', 'slow', '--all'], {
        cwd: fixture.root,
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const pidFile = path.join(dir, 'pid.txt')
      await waitForFile(pidFile, 10_000)
      const pid = Number((await readFile(pidFile, 'utf8')).trim())
      expect(isAlive(pid)).toBe(true)

      proc.kill('SIGTERM')
      const code = await proc.exited
      expect(code).toBe(143)
      expect(await waitForDead(pid, 3_000)).toBe(true)
    },
    TIMEOUT,
  )

  it(
    'SIGTERM kills a ready persistent child and exits 143',
    async () => {
      // `hold` keeps the graph in flight after `dev` becomes ready, so
      // the signal arrives while the persistent child is alive and
      // owned by the orchestrator's registry.
      const dir = await addProject(
        fixture.root,
        'app',
        `
          export default {
            tasks: {
              dev: {
                exec: {
                  command: 'echo $$ > pid.txt; echo READY; exec sleep 30',
                  persistent: { readyWhen: 'READY' },
                },
              },
              hold: {
                exec: { command: 'sleep 30' },
              },
            },
          }
        `,
      )
      const proc = Bun.spawn([process.execPath, BIN, 'run', 'dev', 'hold', '--all'], {
        cwd: fixture.root,
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const pidFile = path.join(dir, 'pid.txt')
      await waitForFile(pidFile, 10_000)
      const pid = Number((await readFile(pidFile, 'utf8')).trim())
      expect(isAlive(pid)).toBe(true)

      proc.kill('SIGTERM')
      const code = await proc.exited
      expect(code).toBe(143)
      expect(await waitForDead(pid, 3_000)).toBe(true)
    },
    TIMEOUT,
  )

  it(
    'SIGINT exits 130',
    async () => {
      const dir = await addProject(
        fixture.root,
        'app',
        `
          export default {
            tasks: {
              slow: {
                exec: { command: 'echo $$ > pid.txt; exec sleep 30' },
              },
            },
          }
        `,
      )
      const proc = Bun.spawn([process.execPath, BIN, 'run', 'slow', '--all'], {
        cwd: fixture.root,
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const pidFile = path.join(dir, 'pid.txt')
      await waitForFile(pidFile, 10_000)
      const pid = Number((await readFile(pidFile, 'utf8')).trim())

      proc.kill('SIGINT')
      const code = await proc.exited
      expect(code).toBe(130)
      expect(await waitForDead(pid, 3_000)).toBe(true)
    },
    TIMEOUT,
  )
})

describe('signal handler lifecycle (in-process)', () => {
  let fixture: Fixture
  beforeEach(async () => {
    fixture = await makeWorkspace()
    await addProject(
      fixture.root,
      'app',
      `
        export default {
          tasks: {
            hello: {
              exec: { command: 'echo hello' },
            },
          },
        }
      `,
    )
  })
  afterEach(async () => {
    await rm(fixture.root, { recursive: true, force: true })
  })

  it(
    'run() removes its SIGINT/SIGTERM listeners — repeated runs never stack',
    async () => {
      const before = {
        int: process.listenerCount('SIGINT'),
        term: process.listenerCount('SIGTERM'),
      }
      for (let i = 0; i < 2; i++) {
        const r = await run({
          cwd: fixture.root,
          tasks: ['hello'],
          projects: ['app'],
          log: silentLogger,
        })
        expect(r.ok).toBe(true)
        expect(process.listenerCount('SIGINT')).toBe(before.int)
        expect(process.listenerCount('SIGTERM')).toBe(before.term)
      }
    },
    TIMEOUT,
  )

  it(
    'handlers are live during the run by default; handleSignals: false installs none',
    async () => {
      // log.status fires while the run is in flight, so sampling the
      // listener count there observes the installed-handler window.
      const counts: number[] = []
      const probe: Logger = {
        status() {
          counts.push(process.listenerCount('SIGTERM'))
        },
        taskStdout() {},
        taskStderr() {},
        taskComplete() {},
      }
      const base = process.listenerCount('SIGTERM')

      await run({ cwd: fixture.root, tasks: ['hello'], projects: ['app'], log: probe })
      expect(Math.max(...counts)).toBe(base + 1)

      counts.length = 0
      await run({
        cwd: fixture.root,
        tasks: ['hello'],
        projects: ['app'],
        handleSignals: false,
        log: probe,
      })
      expect(Math.max(...counts)).toBe(base)
    },
    TIMEOUT,
  )
})
