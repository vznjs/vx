// The real CLI foreground keeps the persistent tasks the user REQUESTED
// alive after the summary. That session ends when ONE of them exits: the
// others are torn down (SIGTERM, grace, SIGKILL) and a non-zero exit makes
// the run exit 1, so `vx run dev` in a script fails when the server it
// started fell over. Until 2026-09-10 the wait was for every server, so a
// crash left the rest running under a run that never returned.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { runLockPath } from '../src/orchestrator/run-lock.js'
import { isAlive, waitForDead } from './helpers/alive.js'
import { addProject, makeWorkspace } from './helpers/workspace.js'
import { localWorkspaceSource } from './helpers/local-workspace.js'
import { pluginSource, writeEdges } from './helpers/plugin.js'

const BIN = path.resolve(import.meta.dir, 'helpers', 'vx-locked.ts')

// Every vx a row spawns, SIGKILLed after the row if it still runs: a row
// that fails before its own kill left a vx holding its servers in the
// foreground for good (item 883).
const spawnedVx: Array<ReturnType<typeof Bun.spawn>> = []
function track<T extends ReturnType<typeof Bun.spawn>>(proc: T): T {
  spawnedVx.push(proc)
  return proc
}
afterEach(() => {
  for (const p of spawnedVx.splice(0))
    if (p.exitCode === null && p.signalCode === null) p.kill('SIGKILL')
})

/** `vx last --format json`: what the run history recorded. */
async function lastRun(root: string): Promise<{
  invocation: { exitOk: boolean }
  tasks: Array<{ project: string; task: string; status: string; exitCode: number | null }>
}> {
  const proc = Bun.spawn([process.execPath, BIN, 'last', '--format', 'json'], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const out = await new Response(proc.stdout).text()
  expect(await proc.exited).toBe(0)
  return JSON.parse(out)
}

async function waitForPid(file: string, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const f = Bun.file(file)
    if (await f.exists()) {
      const pid = Number((await f.text()).trim())
      if (Number.isInteger(pid) && pid > 0) return pid
    }
    await Bun.sleep(20)
  }
  throw new Error(`timed out waiting for a pid in ${file}`)
}

function config(exitCode: number): string {
  return `
    export default {
      tasks: {
        dev: {
          exec: {
            command: 'echo $$ > pid.txt; echo READY; exec sleep 30',
            persistent: { readyWhen: 'READY' },
          },
        },
        other: {
          exec: {
            // Exits once the row has seen dev alive: a fixed 0.3 s let a
            // loaded macOS runner read dev after its teardown (M-9).
            command: 'echo READY; while [ ! -f go ]; do sleep 0.02; done; exit ${exitCode}',
            persistent: { readyWhen: 'READY' },
          },
        },
      },
    }
  `
}

describe('foreground keep-alive ends when one requested server exits', () => {
  let root: string
  beforeEach(async () => {
    root = await makeWorkspace({ prefix: 'vx-keepalive-' })
  })
  afterEach(async () => {
    // A vx this file SIGKILLs leaves its run lock in the temp dir, keyed by the root.
    await rm(runLockPath(root), { recursive: true, force: true })
    await rm(root, { recursive: true, force: true })
  })

  for (const [exitCode, expected] of [
    [1, 1],
    [0, 0],
  ] as const) {
    it(`a server exiting ${exitCode} tears the other down and vx exits ${expected}`, async () => {
      const dir = await addProject(root, 'app', config(exitCode))
      const proc = track(
        Bun.spawn([process.execPath, BIN, 'run', 'dev', 'other', '--all'], {
          cwd: root,
          stdout: 'pipe',
          stderr: 'pipe',
          env: { ...process.env, VX_TEST_KILL_GRACE: '200ms' },
        }),
      )
      const pid = await waitForPid(path.join(dir, 'pid.txt'), 10_000)
      expect(isAlive(pid)).toBe(true)
      writeFileSync(path.join(dir, 'go'), '')
      const [out, err, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      expect(code).toBe(expected)
      expect(await waitForDead(pid, 1_000)).toBe(true)
      // The line that explains the exit code: which server ended the
      // session, with what, and that the other was stopped for it.
      expect(out + err).toContain(
        `vx: app#other exited with code ${exitCode}; stopping 1 other persistent task`,
      )
      // X-23, C-53: the history, written before the wait, said `ok` over
      // it and named no failure, and flaky detection reads the history.
      const last = await lastRun(root)
      const recorded = last.tasks.find((t) => t.task === 'other')!
      expect([last.invocation.exitOk, recorded.status, recorded.exitCode]).toEqual(
        exitCode === 0 ? [true, 'success', 0] : [false, 'failed', exitCode],
      )
    }, 20_000)
  }

  // Another vx version ran on this cache during the session and reset the
  // index to its schema: the late history is this run's to write, and a
  // schema mismatch resets silently. A reading handle refused it and
  // printed "run history not recorded: ... another vx version".
  it('records the history after another vx version reset the index mid-session', async () => {
    const dir = await addProject(root, 'app', config(0))
    const env = { ...process.env, VX_CACHE_DIR: '.vx/cache', VX_TEST_KILL_GRACE: '200ms' }
    const proc = track(
      Bun.spawn([process.execPath, BIN, 'run', 'dev', 'other', '--all'], {
        cwd: root,
        stdout: 'pipe',
        stderr: 'pipe',
        env,
      }),
    )
    await waitForPid(path.join(dir, 'pid.txt'), 10_000)
    const db = new Database(path.join(root, '.vx', 'cache', 'cache.db'))
    // The held run may be writing its index right now; wait for its lock.
    db.query('PRAGMA busy_timeout = 5000').get()
    db.query("UPDATE schema_meta SET value = 'v0-other' WHERE key = 'version'").run()
    db.close()
    writeFileSync(path.join(dir, 'go'), '')
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    expect(code).toBe(0)
    expect((out + err).split('\n').filter((l) => /history|schema|version/.test(l))).toEqual([])
    const last = Bun.spawn([process.execPath, BIN, 'last', '--format', 'json'], {
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
      env,
    })
    const json = await new Response(last.stdout).text()
    expect(await last.exited).toBe(0)
    const tasks = (JSON.parse(json) as { tasks: Array<{ task: string; status: string }> }).tasks
    expect(tasks.map((t) => `${t.task}:${t.status}`).sort()).toEqual([
      'dev:success',
      'other:success',
    ])
  }, 20_000)

  // C-19: the teardown's default signal. No one pressed Ctrl-C here, so
  // the others get SIGTERM; a SIGINT in its place survived the suite.
  it('a server that exits stops the other with SIGTERM', async () => {
    const dir = await addProject(
      root,
      'app',
      `export default { tasks: {
        dev: { exec: {
          command: "trap 'echo SIGINT > got.txt; exit 0' INT; trap 'echo SIGTERM > got.txt; exit 0' TERM; echo $$ > pid.txt; echo READY; while :; do sleep 0.05; done",
          persistent: { readyWhen: 'READY' },
        } },
        other: { exec: { command: 'echo READY; sleep 0.3; exit 0', persistent: { readyWhen: 'READY' } } },
      } }`,
    )
    const proc = track(
      Bun.spawn([process.execPath, BIN, 'run', 'dev', 'other', '--all'], {
        cwd: root,
        stdout: 'ignore',
        stderr: 'ignore',
        env: { ...process.env, VX_TEST_KILL_GRACE: '5000ms' },
      }),
    )
    await waitForPid(path.join(dir, 'pid.txt'), 10_000)
    expect(await proc.exited).toBe(0)
    expect(readFileSync(path.join(dir, 'got.txt'), 'utf8')).toBe('SIGTERM\n')
  }, 20_000)

  // turborepo#12920: Ctrl-C during the foreground wait after the summary
  // did not end the run.
  it('SIGINT after the summary exits 130 and takes the server down', async () => {
    const dir = await addProject(root, 'app', config(0))
    const proc = track(
      Bun.spawn([process.execPath, BIN, 'run', 'app#dev'], {
        cwd: root,
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, CI: '', GITHUB_ACTIONS: '', VX_TEST_KILL_GRACE: '200ms' },
      }),
    )
    let out = ''
    const reading = (async () => {
      for await (const chunk of proc.stdout) out += new TextDecoder().decode(chunk)
    })()
    const pid = await waitForPid(path.join(dir, 'pid.txt'), 10_000)
    const deadline = Date.now() + 10_000
    while (!out.includes('─ vx ') && Date.now() < deadline) await Bun.sleep(20)
    expect(out).toContain('─ vx ')
    expect(isAlive(pid)).toBe(true)

    proc.kill('SIGINT')
    const code = await proc.exited
    await reading
    expect(code).toBe(130)
    expect(await waitForDead(pid, 1_000)).toBe(true)
    // The user stopped it: no failure (C-53's guard), and the usual end of
    // a dev session still leaves its record.
    const last = await lastRun(root)
    expect(last.tasks.map((t) => t.status)).toEqual(['success'])
    // The server's 130 was the stop's, not a crash: the record read FAILED
    // with no failure in it, over the previous real run (item 854).
    expect(last.invocation.exitOk).toBe(true)
  }, 20_000)
  // WD-16: a stop after the summary signalled once by the abort, then again
  // by the wait's own teardown once another kept server went: a server that
  // reads a second signal as "quit now" lost its graceful shutdown.
  // The sleep forks before the traps: a child forked after them holds the
  // trap until it resets or execs, and on macOS CI the row read two lines
  // where vx sends one signal (X-117). Every later fork is exposed only to
  // a second signal, which the leader records anyway.
  for (const [signal, sent, code] of [
    ['SIGTERM', 'T', 143],
    ['SIGINT', 'I', 130],
    ['SIGHUP', 'T', 129],
  ] as const) {
    it(`a ${signal} after the summary signals a kept server once`, async () => {
      const dir = await addProject(
        root,
        'app',
        `export default { tasks: {
          fast: { exec: { command: 'echo READY; exec sleep 30', persistent: { readyWhen: 'READY' } } },
          slow: {
            exec: {
              command: "sleep 30 & trap 'echo T >> sigs' TERM; trap 'echo I >> sigs' INT; echo $$ > pid.txt; echo READY; while true; do wait; sleep 30 & done",
              persistent: { readyWhen: 'READY' },
            },
          },
        } }`,
      )
      const proc = track(
        Bun.spawn([process.execPath, BIN, 'run', 'app#fast', 'app#slow'], {
          cwd: root,
          stdout: 'pipe',
          stderr: 'pipe',
          env: { ...process.env, CI: '', GITHUB_ACTIONS: '', VX_TEST_KILL_GRACE: '500ms' },
        }),
      )
      let out = ''
      const reading = (async () => {
        for await (const chunk of proc.stdout) out += new TextDecoder().decode(chunk)
      })()
      const pid = await waitForPid(path.join(dir, 'pid.txt'), 10_000)
      const deadline = Date.now() + 10_000
      while (!out.includes('─ vx ') && Date.now() < deadline) await Bun.sleep(20)
      expect(out).toContain('─ vx ')
      proc.kill(signal)
      expect(await proc.exited).toBe(code)
      await reading
      expect(await waitForDead(pid, 1_000)).toBe(true)
      expect(readFileSync(path.join(dir, 'sigs'), 'utf8')).toBe(`${sent}\n`)
    }, 20_000)
  }

  // C-66: a plugin's subscriptions were released only after the keep-alive
  // wait, so through a dev session it heard the server after its teardown.
  it('a plugin hears nothing after its teardown while vx holds a server', async () => {
    const heard = path.join(root, 'heard.txt')
    mkdirSync(path.join(root, '.vx'), { recursive: true })
    writeFileSync(
      path.join(root, '.vx/workspace.mjs'),
      localWorkspaceSource(
        [
          pluginSource(
            'org/ear',
            `{
              setup(ctx) {
                ctx.on('onTaskStdout', (_n, c) => appendFileSync(${JSON.stringify(heard)}, (globalThis.__torn ? 'torn:' : 'live:') + c))
              },
              teardown() { globalThis.__torn = true },
            }`,
          ),
        ],
        "import { appendFileSync } from 'node:fs'\n",
      ),
    )
    const dir = await addProject(
      root,
      'app',
      `export default { tasks: { dev: { exec: {
        command: 'echo $$ > pid.txt; echo READY; while [ ! -f go ]; do sleep 0.02; done; echo AF""TER; exec sleep 30',
        persistent: { readyWhen: 'READY' },
      } } } }`,
    )
    const proc = track(
      Bun.spawn([process.execPath, BIN, 'run', 'app#dev'], {
        cwd: root,
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, CI: '', GITHUB_ACTIONS: '', VX_TEST_KILL_GRACE: '200ms' },
      }),
    )
    let out = ''
    const reading = (async () => {
      for await (const chunk of proc.stdout) out += new TextDecoder().decode(chunk)
    })()
    const pid = await waitForPid(path.join(dir, 'pid.txt'), 10_000)
    const deadline = Date.now() + 10_000
    while (!out.includes('─ vx ') && Date.now() < deadline) await Bun.sleep(20)
    writeFileSync(path.join(dir, 'go'), '')
    while (!out.includes('AFTER') && Date.now() < deadline) await Bun.sleep(20)
    expect(out).toContain('AFTER')
    proc.kill('SIGINT')
    expect(await proc.exited).toBe(130)
    await reading
    expect(await waitForDead(pid, 1_000)).toBe(true)
    // It heard the server while the run was its; nothing after its teardown.
    expect(readFileSync(heard, 'utf8')).toBe('live:READY\n')
  }, 20_000)

  // C-46: a kept server keeps the persistent tasks it depends on. Under
  // `--filter app` only app#dev was kept, and the api#dev it was started
  // against was stopped at the end of the graph.
  it('--filter keeps the persistent task a kept one depends on', async () => {
    const server = (deps: string[]) => `export default { tasks: { dev: {
      dependsOn: ${JSON.stringify(deps)},
      exec: { command: 'echo $$ > pid.txt; echo READY; exec sleep 30', persistent: { readyWhen: 'READY' } },
    } } }`
    const api = await addProject(root, 'api', server([]))
    const app = await addProject(root, 'app', server(['^dev']))
    await writeEdges(root, { app: ['api'] })
    const proc = track(
      Bun.spawn([process.execPath, BIN, 'run', 'dev', '--filter', 'app'], {
        cwd: root,
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, CI: '', GITHUB_ACTIONS: '', VX_TEST_KILL_GRACE: '200ms' },
      }),
    )
    let out = ''
    const reading = (async () => {
      for await (const chunk of proc.stdout) out += new TextDecoder().decode(chunk)
    })()
    const pids = [
      await waitForPid(path.join(api, 'pid.txt'), 10_000),
      await waitForPid(path.join(app, 'pid.txt'), 10_000),
    ]
    const deadline = Date.now() + 10_000
    while (!out.includes('─ vx ') && Date.now() < deadline) await Bun.sleep(20)
    const pinned = out.split('\n').filter((l) => l.trim().startsWith('▸'))
    expect(pinned.map((l) => l.trim())).toEqual(['▸ api#dev running', '▸ app#dev running'])
    expect(pids.map(isAlive)).toEqual([true, true])
    proc.kill('SIGINT')
    expect(await proc.exited).toBe(130)
    await reading
    expect(await Promise.all(pids.map((p) => waitForDead(p, 1_000)))).toEqual([true, true])
  }, 20_000)

  // WD-3: a kept dependency that exits 0 is a daemon that forked and
  // returned; it ended the wait and the dev server with it.
  it('a dependency daemon that exits 0 leaves the requested server held', async () => {
    const dir = await addProject(
      root,
      'app',
      `export default { tasks: {
        db: { exec: { command: 'echo up', persistent: {} } },
        dev: {
          dependsOn: ['db'],
          exec: { command: 'echo $$ > pid.txt; echo READY; exec sleep 30', persistent: { readyWhen: 'READY' } },
        },
      } }`,
    )
    const proc = track(
      Bun.spawn([process.execPath, BIN, 'run', 'app#dev'], {
        cwd: root,
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, CI: '', GITHUB_ACTIONS: '', VX_TEST_KILL_GRACE: '200ms' },
      }),
    )
    let out = ''
    const reading = (async () => {
      for await (const chunk of proc.stdout) out += new TextDecoder().decode(chunk)
    })()
    const err = new Response(proc.stderr).text()
    const pid = await waitForPid(path.join(dir, 'pid.txt'), 10_000)
    const deadline = Date.now() + 10_000
    while (!out.includes('─ vx ') && Date.now() < deadline) await Bun.sleep(20)
    // db was gone before the summary; the old wait ended at once.
    const exitedEarly = await Promise.race([proc.exited.then(() => true), Bun.sleep(500)])
    expect([exitedEarly ?? false, isAlive(pid)]).toEqual([false, true])
    proc.kill('SIGINT')
    expect(await proc.exited).toBe(130)
    await reading
    const said = (out + (await err)).split('\n').filter((l) => l.startsWith('vx: '))
    expect(said).toEqual([])
    expect(await waitForDead(pid, 1_000)).toBe(true)
  }, 20_000)

  // C-60: a run that failed held its healthy servers for good: a script's
  // `vx run dev --all` hung, and the Ctrl-C that ended it read 130.
  const failing = (bad: string) => `export default { tasks: {
    dev: { exec: { command: 'echo $$ > pid.txt; echo READY; exec sleep 30', persistent: { readyWhen: 'READY' } } },
    ${bad}
  } }`
  for (const [title, bad, tasks] of [
    [
      'a server that never became ready',
      `bad: { exec: { command: 'exit 3', persistent: { readyWhen: 'READY' } } },`,
      ['dev', 'bad'],
    ],
    [
      // Its crash surfaces at the end of the graph, after e2e passed.
      'a dependency-only server that crashed',
      `mock: { exec: { command: 'echo READY; sleep 0.2; exit 5', persistent: { readyWhen: 'READY' } } },
       e2e: { dependsOn: ['mock'], exec: { command: 'sleep 0.6' } },`,
      ['dev', 'e2e'],
    ],
  ] as const) {
    it(`${title} stops the healthy server and exits 1`, async () => {
      const dir = await addProject(root, 'app', failing(bad))
      const proc = track(
        Bun.spawn([process.execPath, BIN, 'run', ...tasks, '--all'], {
          cwd: root,
          stdout: 'ignore',
          stderr: 'ignore',
          env: { ...process.env, VX_TEST_KILL_GRACE: '200ms' },
        }),
      )
      const pid = await waitForPid(path.join(dir, 'pid.txt'), 10_000)
      expect(await proc.exited).toBe(1)
      expect(await waitForDead(pid, 1_000)).toBe(true)
    }, 20_000)
  }

  it('CONTROL: under --continue=always the healthy server is held', async () => {
    const dir = await addProject(
      root,
      'app',
      failing(`bad: { exec: { command: 'exit 3', persistent: { readyWhen: 'READY' } } },`),
    )
    const proc = track(
      Bun.spawn([process.execPath, BIN, 'run', 'dev', 'bad', '--all', '--continue=always'], {
        cwd: root,
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, CI: '', GITHUB_ACTIONS: '', VX_TEST_KILL_GRACE: '200ms' },
      }),
    )
    let out = ''
    const reading = (async () => {
      for await (const chunk of proc.stdout) out += new TextDecoder().decode(chunk)
    })()
    const pid = await waitForPid(path.join(dir, 'pid.txt'), 10_000)
    const deadline = Date.now() + 10_000
    while (!out.includes('─ vx ') && Date.now() < deadline) await Bun.sleep(20)
    expect(out).toContain('─ vx ')
    expect(isAlive(pid)).toBe(true)
    proc.kill('SIGINT')
    expect(await proc.exited).toBe(130)
    await reading
    expect(await waitForDead(pid, 1_000)).toBe(true)
  }, 20_000)
})

// Item 892: a persistent server that became ready and then died on its own
// while its dependants ran. Dependency-only, the run was green and said
// nothing of it; requested, the pin after the summary still listed it as
// running. The dependant waits for the server's own exit marker, so the
// crash has landed before the graph ends.
describe('a persistent server that dies before the run stops it', () => {
  let root: string
  beforeEach(async () => {
    root = await makeWorkspace({ prefix: 'vx-srvcrash-' })
  })
  afterEach(async () => {
    await rm(runLockPath(root), { recursive: true, force: true })
    await rm(root, { recursive: true, force: true })
  })

  const crashing = (srv: string) => `
    export default {
      tasks: {
        srv: {
          exec: { command: ${JSON.stringify(srv)}, persistent: { readyWhen: 'READY' } },
        },
        e2e: {
          dependsOn: ['srv'],
          exec: { command: 'while [ ! -f gone ]; do sleep 0.02; done; sleep 0.2' },
        },
      },
    }
  `
  const run = async (dir: string, tasks: string[]) => {
    const proc = track(
      Bun.spawn([process.execPath, BIN, 'run', ...tasks, '--all', '--output-logs=none'], {
        cwd: dir,
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, VX_TEST_KILL_GRACE: '200ms' },
      }),
    )
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    const lines = (out + err).split('\n')
    return {
      code,
      said: lines.filter((l) => l.startsWith('vx: ')),
      pinned: lines.filter((l) => l.trim().startsWith('▸')),
      // The footer's task tally: it counted a crashed server a success
      // over a red exit (item 1071).
      tally: lines.find((l) => l.endsWith(' total') && /success|failed/.test(l))?.trim(),
    }
  }

  it('a dependency-only server that exits non-zero fails the run and says so', async () => {
    await addProject(root, 'app', crashing('echo READY; sleep 0.1; touch gone; exit 3'))
    expect(await run(root, ['e2e'])).toEqual({
      code: 1,
      // C-69: said when it happens, while the dependant still runs.
      said: [
        'vx: app#srv exited with code 3 while the run went on',
        'vx: app#srv exited with code 3 before the run stopped it',
      ],
      pinned: [],
      tally: '1 failed · 1 success · 2 total',
    })
  }, 20_000)

  // WD-10: its output block closed `running` under the line naming its exit.
  it("a crashed dependency-only server's output block closes failed", async () => {
    await addProject(root, 'app', crashing('echo READY; sleep 0.1; echo dying; touch gone; exit 3'))
    const proc = track(
      Bun.spawn([process.execPath, BIN, 'run', 'e2e', '--all'], {
        cwd: root,
        stdout: 'pipe',
        stderr: 'pipe',
        env: {
          ...process.env,
          CI: '',
          GITHUB_ACTIONS: '',
          VX_TEST_KILL_GRACE: '200ms',
          NO_COLOR: '1',
        },
      }),
    )
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    const closes = (out + err)
      .split('\n')
      .filter((l) => l.startsWith('└─') && l.includes('app#srv'))
      .map((l) => l.replace(/\(\d+(\.\d+)?m?s\)/, '(T)'))
    expect([code, closes]).toEqual([1, ['└─ ▸ app#srv ── (T) failed (exit 3)']])
  }, 20_000)

  // WD-11: the count of servers it stopped took in one already dead.
  it('the server that ends the wait counts only the others still up', async () => {
    await addProject(
      root,
      'app',
      `export default { tasks: {
        srv: { exec: { command: 'echo READY; sleep 0.1; touch gone; exit 3', persistent: { readyWhen: 'READY' } } },
        srv2: {
          dependsOn: ['srv'],
          exec: { command: 'echo READY; while [ ! -f gone ]; do sleep 0.02; done; sleep 0.05; touch gone2; exit 4', persistent: { readyWhen: 'READY' } },
        },
        e2e: { dependsOn: ['srv2'], exec: { command: 'while [ ! -f gone2 ]; do sleep 0.02; done; sleep 0.2' } },
      } }`,
    )
    expect((await run(root, ['srv', 'srv2', 'e2e'])).said).toEqual([
      'vx: app#srv exited with code 3 while the run went on',
      'vx: app#srv2 exited with code 4 while the run went on',
      'vx: app#srv exited with code 3',
    ])
  }, 20_000)

  // Item 1102: a signal death printed the signal's name as its code.
  it('a dependency-only server killed by a signal is named by its exit code', async () => {
    await addProject(root, 'app', crashing('echo READY; sleep 0.1; touch gone; kill -TERM $$'))
    expect((await run(root, ['e2e'])).said).toEqual([
      'vx: app#srv exited with code 143 while the run went on',
      'vx: app#srv exited with code 143 before the run stopped it',
    ])
  }, 20_000)

  it('CONTROL: one that exits 0 on its own, and one the run stops, leave the run green', async () => {
    // The stopped server's own exit is the SIGTERM's (143): read after the
    // stop, it would fail every run that used a server.
    await addProject(root, 'app', crashing('echo READY; sleep 0.1; touch gone; exit 0'))
    const green = { code: 0, said: [], pinned: [], tally: '2 success · 2 total' }
    expect(await run(root, ['e2e'])).toEqual(green)
    await rm(path.join(root, 'packages', 'app', 'gone'), { force: true })
    await addProject(root, 'app', crashing('touch gone; echo READY; exec sleep 30'))
    expect(await run(root, ['e2e'])).toEqual(green)
  }, 20_000)

  // Item 1061: a Ctrl-C tears the servers down before the graph ends, so
  // each one the stop killed had ended by the time the end of the run asked,
  // and was named as a crash. The dependant holds on in its INT trap, so the
  // server is reaped before that question: the report was 4 in 6 without
  // the hold. The control: a server that died BEFORE the stop is named.
  // A server that writes srv.pid holds the dependant until vx has reaped it
  // (`kill -0` answers for a zombie): `gone` alone raced the Ctrl-C
  // against the reap, and CI signalled first (`said: []`).
  const interrupted = async (
    srv: string,
    tasks = ['e2e'],
  ): Promise<{ code: number; said: string[]; tally: string | undefined }> => {
    const dir = await addProject(root, 'app', {
      config: `export default { tasks: {
        srv: { exec: { command: ${JSON.stringify(srv)}, persistent: { readyWhen: 'READY' } } },
        e2e: {
          dependsOn: ['srv'],
          exec: { command: "while [ ! -f gone ]; do sleep 0.02; done; if [ -f srv.pid ]; then while kill -0 $(cat srv.pid) 2>/dev/null; do sleep 0.02; done; fi; trap 'sleep 0.3; exit 1' INT; echo up > e2e.up; while :; do sleep 0.02; done" },
        },
      } }`,
    })
    const proc = track(
      Bun.spawn([process.execPath, BIN, 'run', ...tasks, '--all', '--output-logs=none'], {
        cwd: root,
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, VX_TEST_KILL_GRACE: '400ms' },
      }),
    )
    const text = Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    const up = path.join(dir, 'e2e.up')
    const deadline = Date.now() + 10_000
    while (!(existsSync(up) && readFileSync(up, 'utf8') === 'up\n')) {
      if (Date.now() > deadline) throw new Error('the dependant never started')
      await Bun.sleep(20)
    }
    proc.kill('SIGINT')
    const code = await proc.exited
    const lines = (await text).join('').split('\n')
    return {
      code,
      said: lines.filter((l) => l.startsWith('vx: ')),
      tally: lines.find((l) => / \d+ total( ·|$)/.test(l) && /success|failed/.test(l))?.trim(),
    }
  }

  it('a Ctrl-C does not name the servers it stopped as crashed', async () => {
    expect(await interrupted('touch gone; echo READY; exec sleep 30')).toEqual({
      code: 130,
      said: [],
      tally: '1 success · 1 aborted · 2 total',
    })
  }, 20_000)

  it('CONTROL: a server that died before the Ctrl-C is still named', async () => {
    expect(
      await interrupted('echo $$ > srv.pid; echo READY; sleep 0.1; touch gone; sleep 0.3; exit 3'),
    ).toEqual({
      code: 130,
      said: [
        'vx: app#srv exited with code 3 while the run went on',
        'vx: app#srv exited with code 3 before the run stopped it',
      ],
      tally: '1 failed · 1 aborted · 2 total',
    })
  }, 20_000)

  it('a requested server that died while its dependant ran is not pinned as running', async () => {
    await addProject(root, 'app', crashing('echo READY; sleep 0.1; touch gone; exit 3'))
    expect(await run(root, ['srv', 'e2e'])).toEqual({
      code: 1,
      said: [
        'vx: app#srv exited with code 3 while the run went on',
        'vx: app#srv exited with code 3',
      ],
      pinned: [],
      tally: '1 failed · 1 success · 2 total',
    })
  }, 20_000)

  // C-46: a kept server that ended cleanly before the end is no crash.
  it('a requested server that exited 0 while its dependant ran leaves the run green', async () => {
    await addProject(root, 'app', crashing('echo READY; sleep 0.1; touch gone; exit 0'))
    expect(await run(root, ['srv', 'e2e'])).toEqual({
      code: 0,
      said: ['vx: app#srv exited with code 0'],
      pinned: [],
      tally: '2 success · 2 total',
    })
  }, 20_000)

  // C-46: a KEPT server the Ctrl-C stopped is not failed by its own exit
  // either; the rows above ask only of a dependency-only one.
  it('a Ctrl-C does not fail the requested server it stopped', async () => {
    expect(await interrupted('touch gone; echo READY; exec sleep 30', ['srv', 'e2e'])).toEqual({
      code: 130,
      said: [],
      tally: '1 success · 1 aborted · 2 total',
    })
  }, 20_000)
})

describe('a persistent task keeps an open stdin', () => {
  let root: string
  beforeEach(async () => {
    root = await makeWorkspace({ prefix: 'vx-keepalive-stdin-' })
  })
  afterEach(async () => {
    // A vx this file SIGKILLs leaves its run lock in the temp dir, keyed by the root.
    await rm(runLockPath(root), { recursive: true, force: true })
    await rm(root, { recursive: true, force: true })
  })

  it('a server that exits on stdin EOF stays up while vx runs', async () => {
    // esbuild --watch (Vite's case in turborepo#8915) exits 0 when its
    // stdin ends. Spawned with `stdin: 'ignore'`, it became ready and
    // exited at once, and `vx run dev` ended green. `cat` is that server.
    // The marker is spelled apart in the command: a CI frame echoes it.
    const dir = await addProject(
      root,
      'app',
      `
        export default {
          tasks: {
            dev: {
              exec: {
                command: "echo $$ > pid.txt; echo READY; cat; printf 'STDIN-%s\\n' ENDED",
                persistent: { readyWhen: 'READY' },
              },
            },
          },
        }
      `,
    )
    const proc = track(
      Bun.spawn([process.execPath, BIN, 'run', 'dev', '--all'], {
        cwd: root,
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, VX_TEST_KILL_GRACE: '200ms' },
      }),
    )
    const out = Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    const pid = await waitForPid(path.join(dir, 'pid.txt'), 10_000)
    // Under 'ignore' the shell saw EOF and vx exited within 50 ms of this.
    const early = await Promise.race([proc.exited, Bun.sleep(500).then(() => 'running' as const)])
    expect(early).toBe('running')
    expect(isAlive(pid)).toBe(true)
    process.kill(proc.pid, 'SIGTERM')
    expect(await proc.exited).toBe(143)
    expect((await out).join('')).not.toContain('STDIN-ENDED')
  }, 20_000)

  it('the stdin ends when vx is SIGKILLed, so a server that watches it goes too', async () => {
    // A `kill -9` of vx runs no teardown, and a persistent task survives
    // it (kill-tree.md, the known limit). The one exception is this pipe:
    // vx holds its write end, the kernel closes it with vx, and a server
    // that exits on stdin EOF — esbuild --watch — goes too. `exec cat` is
    // that server, and its pid is the task's.
    const dir = await addProject(
      root,
      'app',
      `
        export default {
          tasks: {
            dev: {
              exec: {
                command: 'echo $$ > pid.txt; echo READY; exec cat',
                persistent: { readyWhen: 'READY' },
              },
            },
          },
        }
      `,
    )
    const proc = track(
      Bun.spawn([process.execPath, BIN, 'run', 'dev', '--all'], {
        cwd: root,
        stdout: 'ignore',
        stderr: 'ignore',
      }),
    )
    const pid = await waitForPid(path.join(dir, 'pid.txt'), 10_000)
    expect(isAlive(pid)).toBe(true)
    process.kill(proc.pid, 'SIGKILL')
    expect(await proc.exited).toBe(137)
    expect(await waitForDead(pid, 2_000)).toBe(true)
  }, 20_000)
})
