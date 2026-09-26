// End-to-end tests for `exec.persistent`. We use very short-lived
// stand-ins for dev servers: `sleep N` (no output → tests
// "ready immediately"), and a shell loop that prints `READY` once,
// then sleeps (tests `readyWhen` regex matching).
//
// A trailing sleeper in a COMPOUND command is always `exec`'d. vx only
// exec-wraps a single external command (`execWrap`), so `echo READY; sleep 30`
// leaves `sh` as the tracked child: the end-of-run SIGTERM kills the shell and
// orphans the sleeper at PPID 1 for its full 30s, where it outlives this suite
// and perturbs whatever runs next. `exec` makes the sleeper the tracked child,
// so it takes the signal and dies with the task.

import { readFileSync } from 'node:fs'
import { readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { waitForDead } from './helpers/alive.js'
import { addProject, makeWorkspace as makeWorkspaceRoot } from './helpers/workspace.js'
import { run, type Logger } from '../src/orchestrator/index.js'
import { parseRunArgs, resolveRunOptions } from '../src/cli/index.js'

// The SIGTERM→SIGKILL grace is 2 s by default; every test here that proves
// the escalation would wait it out. 200 ms proves the same claim
// (`VX_KILL_GRACE_MS`, see util/settle.ts); children inherit it.
process.env['VX_KILL_GRACE_MS'] = '200'

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
  const root = await makeWorkspaceRoot({ prefix: 'vx-persistent-' })
  return { root, log: [], err: [] }
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
    'a server that exited mid-run is not signalled at the end: its group number is free',
    async () => {
      // The registry keeps a ready server after it exits (keep-alive
      // reports it). Its group was empty when it went, so the number is
      // free, and the end-of-run teardown's `kill(-pid)` could reach a
      // group the kernel has since given it (item 874). Signalled: never.
      const dir = await addProject(
        fixture.root,
        'app',
        `
          export default {
            tasks: {
              dev: {
                exec: {
                  command: 'echo $$ > dev.pid; echo READY; sleep 0.2',
                  persistent: { readyWhen: 'READY' },
                },
              },
              hold: { exec: { command: 'sleep 1' } },
            },
          }
        `,
      )
      const kill = spyOn(process, 'kill')
      try {
        await run({ cwd: fixture.root, tasks: ['dev', 'hold'], log: silentLogger(fixture) })
        const pid = Number(readFileSync(path.join(dir, 'dev.pid'), 'utf8').trim())
        expect(pid).toBeGreaterThan(0)
        // Signal 0 delivers nothing: the one probe is the exit's own check.
        expect(kill.mock.calls.filter((c) => c[0] === -pid && c[1] !== 0)).toEqual([])
      } finally {
        kill.mockRestore()
      }
    },
    TIMEOUT,
  )

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
                  command: 'sleep 0.2; echo "Local: http://localhost:5173"; exec sleep 30',
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
                  command: 'echo nope; exit 2',
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
      // The child's OWN exit code, not a made-up 1, and the reason (item 270).
      expect(r.outcomes[0]?.exitCode).toBe(2)
      expect(r.outcomes[0]?.notReady).toBe('exited')
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
      // returns, that pid must be gone.
      //
      // `exec` is load-bearing for the ASSERTION, not just for hygiene:
      // `$$` is the shell's pid, and exec replaces the shell image while
      // KEEPING that pid — so pid.txt/stdout names the sleeper itself.
      // Without it we would record a shell that dies on SIGTERM while the
      // orphaned sleeper lives on, and the check below would pass while
      // proving nothing.
      await addProject(fixture.root, 'app', {
        config: `
          export default {
            tasks: {
              dev: {
                exec: {
                  command: 'echo PID=$$; exec sleep 60',
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
      expect(r.outcomes).toHaveLength(1)

      const pid = Number(/PID=(\d+)/.exec(fixture.log.join('\n'))?.[1])
      expect(Number.isInteger(pid)).toBe(true)
      expect(await waitForDead(pid, 3_000)).toBe(true)
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
                  command: 'echo READY; exec sleep 30',
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
      // The sleeper is `exec`'d so the SLEEPER itself is what ignores SIGTERM
      // (SIG_IGN survives exec) rather than a wrapping shell whose death would
      // orphan it — the escalation is exercised against the real process.
      await addProject(fixture.root, 'app', {
        config: `
          export default {
            tasks: {
              dev: {
                exec: {
                  command: "trap '' TERM; echo READY; exec sleep 30",
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
      // line containing the pattern. The runner retains nothing — it
      // forwards every chunk to the logger, whose per-task tail is
      // registered at taskStart and so covers the pre-ready window;
      // the task body must contain it. Deterministic — no race window
      // because we synchronously wait on `ready`.
      await addProject(fixture.root, 'app', {
        config: `
          export default {
            tasks: {
              dev: {
                exec: {
                  command: 'echo hello-dev; sleep 0.05; echo READY; exec sleep 30',
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
                  command: 'sleep 0.2; echo READY; exec sleep 30',
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

  // A ready persistent task's pid, for a later task to ask after: `$$`
  // before `exec` is the pid the sleeper then carries.
  const SERVER = `echo $$ > pid.txt; echo READY; exec sleep 30`
  const ALIVE = (...pidFiles: string[]) =>
    `${pidFiles.map((f) => `kill -0 $(cat ${f})`).join(' && ')} && echo both-alive`

  // turborepo#8484: a persistent task depending on a persistent task was
  // refused, or started without its upstream.
  it(
    'a persistent task over a persistent upstream starts after it, and both stay up for the run',
    async () => {
      await addProject(fixture.root, 'lib', {
        config: `
          export default {
            tasks: {
              dev: { exec: { command: ${JSON.stringify(SERVER)}, persistent: { readyWhen: 'READY' } } },
            },
          }
        `,
      })
      await addProject(fixture.root, 'app', {
        deps: { lib: 'workspace:*' },
        config: `
          export default {
            tasks: {
              dev: {
                exec: {
                  command: ${JSON.stringify(`test -f ../lib/pid.txt && ${SERVER}`)},
                  persistent: { readyWhen: 'READY' },
                },
                dependsOn: ['^dev'],
              },
              smoke: {
                exec: { command: ${JSON.stringify(ALIVE('../lib/pid.txt', 'pid.txt'))} },
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
      expect(Object.fromEntries(r.outcomes.map((o) => [o.node.id, o.status]))).toEqual({
        'lib#dev': 'success',
        'app#dev': 'success',
        'app#smoke': 'success',
      })
      expect(fixture.log).toContain('both-alive')
    },
    TIMEOUT,
  )

  // nx#27986: a continuous task was killed when its dependent started.
  it(
    'a ready persistent upstream is alive while its dependent runs',
    async () => {
      await addProject(fixture.root, 'app', {
        config: `
          export default {
            tasks: {
              dev: { exec: { command: ${JSON.stringify(SERVER)}, persistent: { readyWhen: 'READY' } } },
              smoke: {
                exec: { command: 'sleep 0.3 && kill -0 $(cat pid.txt) && echo upstream-alive' },
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
      expect(r.outcomes.find((o) => o.node.id === 'app#smoke')?.status).toBe('success')
      expect(fixture.log).toContain('upstream-alive')
    },
    TIMEOUT,
  )

  // nx#31494, nx#34117: `--parallel=1` ran the continuous task's
  // dependents together once it was up.
  it(
    'at concurrency 1 the dependents of a ready persistent task run one at a time',
    async () => {
      const step = (name: string) =>
        `echo start-${name} >> ../../order.log && sleep 0.2 && echo end-${name} >> ../../order.log`
      await addProject(fixture.root, 'app', {
        config: `
          export default {
            tasks: {
              dev: { exec: { command: ${JSON.stringify(SERVER)}, persistent: { readyWhen: 'READY' } } },
              third: { exec: { command: ${JSON.stringify(step('third'))} }, dependsOn: ['dev'] },
              fourth: { exec: { command: ${JSON.stringify(step('fourth'))} }, dependsOn: ['dev'] },
            },
          }
        `,
      })
      const r = await run({
        cwd: fixture.root,
        tasks: ['third', 'fourth'],
        projects: ['app'],
        concurrency: 1,
        log: silentLogger(fixture),
      })
      expect(r.ok).toBe(true)
      const order = (await Bun.file(`${fixture.root}/order.log`).text()).trim().split('\n')
      expect([
        ['start-third', 'end-third', 'start-fourth', 'end-fourth'],
        ['start-fourth', 'end-fourth', 'start-third', 'end-third'],
      ]).toContainEqual(order)
    },
    TIMEOUT,
  )

  // turborepo#4107: some of a filter's persistent tasks never started.
  it(
    'every one of thirteen persistent tasks a filter selects starts at concurrency 2',
    async () => {
      const deps = Array.from({ length: 12 }, (_, i) => `d${String(i + 1).padStart(2, '0')}`)
      const dev = (name: string) => `
        export default {
          tasks: {
            dev: {
              exec: {
                command: 'touch ../../started-${name} && echo READY && exec sleep 30',
                persistent: { readyWhen: 'READY' },
              },
              dependsOn: ['^dev'],
            },
          },
        }
      `
      for (const d of deps) await addProject(fixture.root, d, { config: dev(d) })
      await addProject(fixture.root, 'other', { config: dev('other') })
      await addProject(fixture.root, 'front', {
        deps: Object.fromEntries(deps.map((d) => [d, 'workspace:*'])),
        config: dev('front'),
      })
      const parsed = parseRunArgs(['dev', '--filter', 'front...', '--concurrency', '2'])
      expect(parsed.error).toBeUndefined()
      const resolved = await resolveRunOptions(parsed, fixture.root, parsed.tasks)
      if ('error' in resolved || 'nothingSelected' in resolved) throw new Error('unreachable')
      const r = await run({ ...resolved, log: silentLogger(fixture) })
      expect(r.ok).toBe(true)
      expect(r.outcomes.map((o) => `${o.node.id} ${o.status}`).sort()).toEqual(
        [...deps, 'front'].map((p) => `${p}#dev success`).sort(),
      )
      // Ready means the command reached its READY line, so its marker exists.
      const started = (await readdir(fixture.root))
        .filter((f) => f.startsWith('started-'))
        .map((f) => f.slice('started-'.length))
        .sort()
      expect(started).toEqual([...deps, 'front'].sort())
    },
    TIMEOUT,
  )
})
