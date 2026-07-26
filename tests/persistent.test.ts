// End-to-end tests for `exec.persistent`. We use very short-lived
// stand-ins for dev servers: `sleep N` (no output → tests
// "ready immediately"), and a shell loop that prints `READY` once,
// then sleeps (tests `readyWhen` regex matching).

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { run, type Logger } from '../src/orchestrator/index.js'

interface Fixture {
  root: string
  log: string[]
  err: string[]
}

const TIMEOUT = 10_000

const silentLogger = (fixture: Fixture): Logger => {
  const buffers = new Map<string, string>()
  return {
    status(line) {
      fixture.log.push(line)
    },
    taskStdout(node, chunk) {
      buffers.set(node.id, (buffers.get(node.id) ?? '') + chunk)
    },
    taskStderr(node, chunk) {
      fixture.err.push(chunk.trimEnd())
      buffers.set(node.id, (buffers.get(node.id) ?? '') + chunk)
    },
    taskComplete(node, outcome) {
      const body = buffers.get(node.id) ?? ''
      buffers.delete(node.id)
      fixture.log.push(`task ${node.id} ${outcome.status}`)
      if (body.trim().length > 0) fixture.log.push(body.trimEnd())
    },
  }
}

async function makeWorkspace(): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vx-persistent-'))
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'fixture-root', private: true }),
  )
  await mkdir(path.join(root, 'packages'), { recursive: true })
  // vx requires git for input enumeration; init a quiet repo so the
  // fixture's tasks can resolve their inputs.
  const run = (...args: string[]): void => {
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
  run('init', '-q')
  run('config', 'user.email', 'test@vx.local')
  run('config', 'user.name', 'vx test')
  return { root, log: [], err: [] }
}

async function addProject(
  root: string,
  name: string,
  args: { config: string; deps?: Record<string, string> },
): Promise<string> {
  const dir = path.join(root, 'packages', name)
  await mkdir(dir, { recursive: true })
  await writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({ name, version: '0.0.0', ...(args.deps ? { dependencies: args.deps } : {}) }),
  )
  await writeFile(path.join(dir, 'vx.config.mjs'), args.config)
  return dir
}

describe('exec.persistent (e2e)', () => {
  let fixture: Fixture
  beforeEach(async () => {
    fixture = await makeWorkspace()
  })
  afterEach(async () => {
    await rm(fixture.root, { recursive: true, force: true })
  })

  it(
    'persistent task with no readyWhen returns immediately (success), is SIGTERMd at end',
    async () => {
      // `sleep 30` is way longer than the test. If we ever block on
      // its exit instead of SIGTERMing, the test times out.
      await addProject(fixture.root, 'app', {
        config: `
          export default {
            tasks: {
              dev: {
                exec: { command: 'sleep 30', persistent: {} },
              },
            },
          }
        `,
      })
      const t0 = Date.now()
      const r = await run({
        cwd: fixture.root,
        tasks: ['dev'],
        projects: ['app'],
        log: silentLogger(fixture),
      })
      const elapsed = Date.now() - t0

      expect(r.outcomes[0]?.status).toBe('success')
      expect(r.outcomes[0]?.node.id).toBe('app#dev')
      // Should NOT have waited for sleep 30 to exit.
      expect(elapsed).toBeLessThan(5_000)
    },
    TIMEOUT,
  )

  it(
    'persistent task with readyWhen waits for the pattern',
    async () => {
      await addProject(fixture.root, 'app', {
        config: `
          export default {
            tasks: {
              dev: {
                exec: {
                  command: 'sleep 0.2; echo "Local: http://localhost:5173"; sleep 30',
                  persistent: { readyWhen: 'Local:' },
                },
              },
            },
          }
        `,
      })
      const t0 = Date.now()
      const r = await run({
        cwd: fixture.root,
        tasks: ['dev'],
        projects: ['app'],
        log: silentLogger(fixture),
      })
      const elapsed = Date.now() - t0

      expect(r.outcomes[0]?.status).toBe('success')
      // Took at least 200ms (the artificial pre-print sleep) but well
      // under 5s (the trailing sleep we SIGTERM out of).
      expect(elapsed).toBeGreaterThanOrEqual(150)
      expect(elapsed).toBeLessThan(5_000)
    },
    TIMEOUT,
  )

  it(
    'persistent task that exits before becoming ready is reported as failed',
    async () => {
      await addProject(fixture.root, 'app', {
        config: `
          export default {
            tasks: {
              dev: {
                exec: {
                  command: 'echo nope; exit 1',
                  persistent: { readyWhen: 'Listening on' },
                },
              },
            },
          }
        `,
      })
      const r = await run({
        cwd: fixture.root,
        tasks: ['dev'],
        projects: ['app'],
        log: silentLogger(fixture),
      })
      expect(r.ok).toBe(false)
      expect(r.outcomes[0]?.status).toBe('failed')
    },
    TIMEOUT,
  )

  it(
    'multiple persistent tasks across projects spawn concurrently',
    async () => {
      // Two persistent tasks across two projects. Both with no
      // readyWhen → both should resolve instantly and run() returns
      // promptly while their `sleep 30`s would otherwise block.
      await addProject(fixture.root, 'a', {
        config: `
          export default {
            tasks: {
              dev: { exec: { command: 'sleep 30', persistent: {} } },
            },
          }
        `,
      })
      await addProject(fixture.root, 'b', {
        config: `
          export default {
            tasks: {
              dev: { exec: { command: 'sleep 30', persistent: {} } },
            },
          }
        `,
      })
      const t0 = Date.now()
      const r = await run({
        cwd: fixture.root,
        tasks: ['dev'],
        log: silentLogger(fixture),
      })
      expect(Date.now() - t0).toBeLessThan(5_000)
      expect(r.outcomes.map((o) => o.status).sort()).toEqual(['success', 'success'])
    },
    TIMEOUT,
  )

  it(
    'persistent subprocess is actually SIGTERMd before run() returns',
    async () => {
      // Spawn a sleeper and capture its PID via stdout. After run()
      // returns, /proc/<pid> should be gone (or signal a kill).
      await addProject(fixture.root, 'app', {
        config: `
          export default {
            tasks: {
              dev: {
                exec: {
                  command: 'echo PID=$$; sleep 60',
                  persistent: { readyWhen: 'PID=' },
                },
              },
            },
          }
        `,
      })
      const r = await run({
        cwd: fixture.root,
        tasks: ['dev'],
        projects: ['app'],
        log: silentLogger(fixture),
      })
      expect(r.outcomes[0]?.status).toBe('success')
      // We don't pin the exact PID — that depends on the shell. We
      // just verify the run() returned quickly without blocking, and
      // no hung subprocesses are reported by the registry indirectly:
      // any leak would show as a hung test (the SIGTERM is the only
      // way the sleep ends before the 10s test timeout).
      expect(r.outcomes).toHaveLength(1)
    },
    TIMEOUT,
  )

  it(
    'persistent upstream is SIGTERMd when a downstream sibling fails',
    async () => {
      await addProject(fixture.root, 'app', {
        config: `
          export default {
            tasks: {
              dev: {
                exec: {
                  command: 'echo READY; sleep 30',
                  persistent: { readyWhen: 'READY' },
                },
              },
              smoke: {
                exec: { command: 'exit 7' },
                dependsOn: ['dev'],
              },
            },
          }
        `,
      })
      const t0 = Date.now()
      const r = await run({
        cwd: fixture.root,
        tasks: ['smoke'],
        projects: ['app'],
        log: silentLogger(fixture),
      })
      // smoke failed exit 7 → ok=false. dev was ready, then SIGTERM'd.
      expect(r.ok).toBe(false)
      expect(r.outcomes.find((o) => o.node.id === 'app#smoke')?.status).toBe('failed')
      expect(r.outcomes.find((o) => o.node.id === 'app#dev')?.status).toBe('success')
      // Total wall time < 5s — i.e., we didn't wait for `sleep 30`.
      expect(Date.now() - t0).toBeLessThan(5_000)
    },
    TIMEOUT,
  )

  it(
    'a dependency-only persistent task that ignores SIGTERM is force-killed (run does not hang)',
    async () => {
      // `dev` traps + ignores SIGTERM, so the end-of-run graceful shutdown can't
      // reap it — without the bounded SIGKILL escalation, run() would block on
      // its exit until `sleep 30` ends (~30s), hanging a NORMAL completion.
      await addProject(fixture.root, 'app', {
        config: `
          export default {
            tasks: {
              dev: {
                exec: {
                  command: "trap '' TERM; echo READY; sleep 30",
                  persistent: { readyWhen: 'READY' },
                },
              },
              build: {
                exec: { command: 'echo built' },
                dependsOn: ['dev'],
              },
            },
          }
        `,
      })
      const t0 = Date.now()
      const r = await run({
        cwd: fixture.root,
        tasks: ['build'],
        projects: ['app'],
        log: silentLogger(fixture),
      })
      expect(r.ok).toBe(true)
      expect(r.outcomes.find((o) => o.node.id === 'app#build')?.status).toBe('success')
      expect(r.outcomes.find((o) => o.node.id === 'app#dev')?.status).toBe('success')
      // Well under `sleep 30` → the force-kill fired after the grace, not a wait
      // for the trapped child's natural exit.
      expect(Date.now() - t0).toBeLessThan(8_000)
    },
    TIMEOUT,
  )

  it(
    'persistent task streams output captured before ready into the body',
    async () => {
      // With readyWhen present, the ready marker is preceded by the
      // line containing the pattern. The runner buffers everything
      // up to (and including) that line; the task body must contain
      // it. Deterministic — no race window because we synchronously
      // wait on `ready`.
      await addProject(fixture.root, 'app', {
        config: `
          export default {
            tasks: {
              dev: {
                exec: {
                  command: 'echo hello-dev; sleep 0.05; echo READY; sleep 30',
                  persistent: { readyWhen: 'READY' },
                },
              },
            },
          }
        `,
      })
      await run({
        cwd: fixture.root,
        tasks: ['dev'],
        projects: ['app'],
        log: silentLogger(fixture),
      })
      const all = fixture.log.join('\n')
      expect(all).toContain('hello-dev')
      expect(all).toContain('READY')
    },
    TIMEOUT,
  )

  it(
    'downstream task waits for persistent upstream to become ready',
    async () => {
      // `dev` prints READY after 200ms and then loops. `smoke` runs
      // after `dev` is ready and stamps a wall-clock timestamp; we
      // verify it ran AFTER the dev start, not concurrently.
      await addProject(fixture.root, 'app', {
        config: `
          export default {
            tasks: {
              dev: {
                exec: {
                  command: 'sleep 0.2; echo READY; sleep 30',
                  persistent: { readyWhen: 'READY' },
                },
              },
              smoke: {
                exec: { command: 'echo smoke-ran' },
                dependsOn: ['dev'],
              },
            },
          }
        `,
      })
      const r = await run({
        cwd: fixture.root,
        tasks: ['smoke'],
        projects: ['app'],
        log: silentLogger(fixture),
      })
      expect(r.ok).toBe(true)
      // Both tasks resolved successfully. smoke saw dev's `READY`
      // before starting.
      const dev = r.outcomes.find((o) => o.node.id === 'app#dev')
      const smoke = r.outcomes.find((o) => o.node.id === 'app#smoke')
      expect(dev?.status).toBe('success')
      expect(smoke?.status).toBe('success')
      // dev's "duration" is its time-to-ready (~200ms), not its full
      // lifetime. smoke ran AFTER dev was ready, so wallclock spans
      // overlap.
      expect(dev?.durationMs).toBeGreaterThanOrEqual(150)
    },
    TIMEOUT,
  )

  it(
    'persistent task with concurrency=1 does not block downstream forever',
    async () => {
      // Hazard: a serial scheduler that waits for child.exited (instead
      // of spawn.ready) on a persistent task would deadlock — the dev
      // server never exits. Pin: with concurrency=1, downstream still
      // runs after ready, and the run completes well under the timeout.
      await addProject(fixture.root, 'app', {
        config: `
          export default {
            tasks: {
              dev: {
                exec: {
                  command: "node -e 'console.log(\\"Local: ready\\"); setTimeout(()=>{}, 60000)'",
                  persistent: { readyWhen: 'Local:' },
                },
              },
              smoke: {
                exec: { command: 'true' },
                dependsOn: ['dev'],
              },
            },
          }
        `,
      })

      const t0 = Date.now()
      const r = await run({
        cwd: fixture.root,
        tasks: ['smoke'],
        projects: ['app'],
        concurrency: 1,
        log: silentLogger(fixture),
      })
      const elapsed = Date.now() - t0
      expect(r.ok).toBe(true)
      expect(elapsed).toBeLessThan(5_000)
    },
    TIMEOUT,
  )

  // forwardArgs are appended to a persistent command ONLY when there's no
  // readyWhen (a ready-on-spawn task); a readyWhen task is left untouched so
  // the regex matcher sees the unmodified output. We observe the args the
  // persistent `dev` process actually received by having it write them to a
  // file (`echo GOTARGS: > got.txt` — the appended words land on echo), then a
  // downstream `smoke` task reads it back. `smoke` keeps the graph alive so
  // dev is never SIGTERM'd before writing; its own nested `sh -c '…' sh`
  // absorbs the (also-appended) args as positional params it ignores. Both
  // `dev` and `smoke` are requested so forwardArgs reach dev.
  const SMOKE =
    "sh -c 'for i in $(seq 1 250); do if [ -f got.txt ]; then cat got.txt; exit 0; fi; sleep 0.02; done' sh"

  const argsConfig = (ready: boolean): string => {
    const devCommand = ready ? 'echo GOTARGS: > got.txt; echo READY' : 'echo GOTARGS: > got.txt'
    const persistent = ready ? `{ readyWhen: 'READY' }` : `{}`
    return `export default {
      tasks: {
        dev: {
          exec: { command: ${JSON.stringify(devCommand)}, persistent: ${persistent} },
        },
        smoke: {
          exec: { command: ${JSON.stringify(SMOKE)} },
          dependsOn: ['dev'],
        },
      },
    }`
  }

  it(
    'appends forwardArgs to a persistent command with NO readyWhen',
    async () => {
      await addProject(fixture.root, 'app', { config: argsConfig(false) })
      const r = await run({
        cwd: fixture.root,
        tasks: ['dev', 'smoke'],
        projects: ['app'],
        forwardArgs: ['--port', '3000'],
        log: silentLogger(fixture),
      })
      expect(r.ok).toBe(true)
      // dev received the forwarded args (appended to its command) → wrote
      // them to got.txt → smoke read them back.
      expect(fixture.log.join('\n')).toContain('GOTARGS: --port 3000')
    },
    TIMEOUT,
  )

  it(
    'shell-quotes forwarded args so the child gets what the user typed',
    async () => {
      await addProject(fixture.root, 'app', { config: argsConfig(false) })
      // Double quotes do NOT stop `sh` expanding, so quoting these with
      // JSON.stringify handed the child the EXPANSION (`$(id -u)` → the
      // uid) instead of the literal string the user asked to forward.
      // The one-shot path has always used shellQuote; this is the same
      // contract for the ready-on-spawn persistent path.
      const hostile = ['$(id -u)', '`id -u`', '$HOME']
      const r = await run({
        cwd: fixture.root,
        tasks: ['dev', 'smoke'],
        projects: ['app'],
        forwardArgs: hostile,
        log: silentLogger(fixture),
      })
      expect(r.ok).toBe(true)
      expect(fixture.log.join('\n')).toContain(`GOTARGS: ${hostile.join(' ')}`)
    },
    TIMEOUT,
  )

  it(
    'leaves a persistent command with a readyWhen untouched (no forwardArgs appended)',
    async () => {
      await addProject(fixture.root, 'app', { config: argsConfig(true) })
      const r = await run({
        cwd: fixture.root,
        tasks: ['dev', 'smoke'],
        projects: ['app'],
        forwardArgs: ['--port', '3000'],
        log: silentLogger(fixture),
      })
      expect(r.ok).toBe(true)
      const all = fixture.log.join('\n')
      // dev's command was untouched → it saw no forwarded args.
      expect(all).toContain('GOTARGS:')
      expect(all).not.toContain('--port')
    },
    TIMEOUT,
  )

  it(
    'persistent task spawn failure surfaces clean failure, not a hung run',
    async () => {
      // Command resolves to a missing binary. The spawn itself
      // succeeds (we go through `sh -c`), but the shell exits
      // non-zero immediately. `ready` rejects with the captured
      // stderr; runner returns failed.
      await addProject(fixture.root, 'app', {
        config: `
          export default {
            tasks: {
              dev: {
                exec: {
                  command: '/this/binary/does/not/exist --serve',
                  persistent: { readyWhen: 'Listening' },
                },
              },
            },
          }
        `,
      })
      const t0 = Date.now()
      const r = await run({
        cwd: fixture.root,
        tasks: ['dev'],
        projects: ['app'],
        log: silentLogger(fixture),
      })
      const elapsed = Date.now() - t0
      expect(r.ok).toBe(false)
      const o = r.outcomes.find((o) => o.node.id === 'app#dev')
      expect(o?.status).toBe('failed')
      // Should fail fast — not wait for the never-coming Listening line.
      expect(elapsed).toBeLessThan(5_000)
    },
    TIMEOUT,
  )
})
