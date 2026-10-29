// A SIGKILLed vx takes the process groups it holds with it: split from
// keep-alive.test.ts so no file holds a shard alone (2026-10-22).

import { existsSync, readFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { runLockPath } from '../src/orchestrator/run-lock.js'
import { isAlive, waitForDead } from './helpers/alive.js'
import { addProject, makeWorkspace } from './helpers/workspace.js'

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

describe('a SIGKILLed vx takes the groups it holds with it', () => {
  let root: string
  beforeEach(async () => {
    root = await makeWorkspace({ prefix: 'vx-keepalive-' })
  })
  afterEach(async () => {
    // A vx this file SIGKILLs leaves its run lock in the temp dir, keyed by the root.
    await rm(runLockPath(root), { recursive: true, force: true })
    await rm(root, { recursive: true, force: true })
  })

  // The rest of a `kill -9`: vx's group guard (kill-tree.ts) holds the
  // groups vx has not finished with and SIGKILLs them when vx's end of
  // its pipe closes. Each row's grandchild watches nothing, so only the
  // group kill takes it (turborepo#9666). It writes `late.txt` once the row
  // writes `go`, after the kill: a file, not a pid, because under a
  // sandbox's pid namespace a killed orphan stays a zombie that signal 0
  // still finds. A second's timer from its start went red with a correct
  // vx whenever the pid poll and the guard's kill took longer (M-14's class).
  // `stall` preloads a Bun.spawn that blocks vx for three seconds after
  // each task spawn returns: the child runs first, as on a loaded box, and
  // the kill lands before vx's own next step (B-9).
  async function outlivesVx(exec: string, stall = false): Promise<boolean> {
    const dir = await addProject(
      root,
      'app',
      `export default { tasks: { dev: { exec: ${exec} } } }`,
    )
    const preload = path.join(root, 'stall-spawns.ts')
    if (stall)
      await Bun.write(
        preload,
        `const spawn = Bun.spawn
Bun.spawn = (cmd, opts) => {
  const child = spawn(cmd, opts)
  if (opts?.argv0 === 'sh') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000)
  return child
}
`,
      )
    const proc = track(
      Bun.spawn(
        [process.execPath, ...(stall ? ['--preload', preload] : []), BIN, 'run', 'dev', '--all'],
        { cwd: root, stdout: 'ignore', stderr: 'ignore' },
      ),
    )
    const child = await waitForPid(path.join(dir, 'pid.txt'), 10_000)
    process.kill(proc.pid, 'SIGKILL')
    expect(await proc.exited).toBe(137)
    // `go` written before the guard's kill lands reached a live child
    // (B-38); under a sandbox's procfs a killed child stays a zombie, and
    // this waits out the 5 s.
    await waitForDead(child, 5_000)
    await Bun.write(path.join(dir, 'go'), '')
    // A child the guard missed sees `go` within 0.02 s and writes.
    await Bun.sleep(2_000)
    return existsSync(path.join(dir, 'late.txt'))
  }

  it('a SIGKILLed vx takes an unsandboxed persistent task’s backgrounded server with it', async () => {
    expect(
      await outlivesVx(
        `{ command: '(while [ ! -f go ]; do sleep 0.02; done; echo late > late.txt) & echo $! > pid.txt; echo READY; wait', persistent: { readyWhen: 'READY' } }`,
      ),
    ).toBe(false)
  }, 20_000)

  it('a SIGKILLed vx takes an unsandboxed one-shot task’s backgrounded child with it', async () => {
    expect(
      // It ignores SIGTERM, as a server's cleanup might: only a SIGKILL takes it.
      await outlivesVx(
        `{ command: '(trap "" INT TERM; while [ ! -f go ]; do sleep 0.02; done; echo late > late.txt) & echo $! > pid.txt; wait' }`,
      ),
    ).toBe(false)
  }, 20_000)

  it('a task’s group is listed before it runs: a kill -9 while vx is descheduled takes it', async () => {
    expect(
      await outlivesVx(
        `{ command: '(trap "" INT TERM; while [ ! -f go ]; do sleep 0.02; done; echo late > late.txt) & echo $! > pid.txt; wait' }`,
        true,
      ),
    ).toBe(false)
  }, 20_000)

  it('a run that spawns no task starts no guard', async () => {
    // The guard is the price of a spawn, not of a run: a warm run pays
    // nothing. A preload logs every Bun.spawn's argv0; the guard's is
    // `vx-group-guard`.
    const log = path.join(root, 'spawns.log')
    const preload = path.join(root, 'log-spawns.ts')
    await Bun.write(
      preload,
      `import { appendFileSync } from 'node:fs'
const spawn = Bun.spawn
Bun.spawn = (cmd, opts) => {
  appendFileSync(${JSON.stringify(log)}, String(opts?.argv0 ?? cmd[0]) + '\\n')
  return spawn(cmd, opts)
}
`,
    )
    // Two tasks, one guard: it is the process's, not the spawn's.
    for (const name of ['app', 'lib'])
      await addProject(
        root,
        name,
        `export default { tasks: { build: { exec: { command: 'true' }, inputs: { files: ['**/*'] }, cache: { outputs: { files: [] } } } } }`,
      )
    const guards = async (): Promise<string[]> => {
      await rm(log, { force: true })
      const proc = track(
        Bun.spawn([process.execPath, '--preload', preload, BIN, 'run', 'build', '--all'], {
          cwd: root,
          stdout: 'ignore',
          stderr: 'ignore',
        }),
      )
      expect(await proc.exited).toBe(0)
      const lines = existsSync(log) ? readFileSync(log, 'utf8').split('\n') : []
      return lines.filter((l) => l === 'vx-group-guard' || l === 'sh')
    }
    // The tasks' own shells spawn on the spawn thread (spawn-off.ts),
    // which the preload does not reach; the guard spawns here.
    expect(await guards()).toEqual(['vx-group-guard'])
    expect(await guards()).toEqual([])
  }, 20_000)

  it('a terminal’s Ctrl-C leaves the guard, so a kill -9 in the teardown still takes the task', async () => {
    // A terminal signals its foreground group: vx and, were it in vx's
    // group, the guard, which a SIGINT kills. vx's teardown then waits
    // out the grace on a task that ignores the signal, and a `kill -9`
    // there left the task to nobody. The task lives until a SIGKILL, so
    // the row asserts its death: a `late.txt` written a second after the
    // task started would be red whenever the pid poll, the grace below and the
    // guard's kill took longer than that (M-14's class, M-17).
    const dir = await addProject(
      root,
      'app',
      `export default { tasks: { dev: { exec: { command: 'trap "" INT TERM; (while :; do sleep 0.05; done) & echo $! > pid.txt; echo $$ > shell.pid; wait' } } } }`,
    )
    const proc = track(
      Bun.spawn([process.execPath, BIN, 'run', 'dev', '--all'], {
        cwd: root,
        env: { ...process.env, VX_TEST_KILL_GRACE: '5000ms' },
        stdout: 'ignore',
        stderr: 'ignore',
        detached: true,
      }),
    )
    const child = await waitForPid(path.join(dir, 'pid.txt'), 10_000)
    const shell = await waitForPid(path.join(dir, 'shell.pid'), 10_000)
    expect([isAlive(child), isAlive(shell)]).toEqual([true, true])
    process.kill(-proc.pid, 'SIGINT')
    await Bun.sleep(200)
    process.kill(proc.pid, 'SIGKILL')
    expect(await proc.exited).toBe(137)
    expect([await waitForDead(child, 5_000), await waitForDead(shell, 5_000)]).toEqual([true, true])
  }, 20_000)

  it('a kill -9 in a Ctrl-C’s grace takes the child of a shell that died on the signal', async () => {
    // The shell dies on the SIGINT; the child it backgrounded ignores it
    // and runs out the grace. The runner let the group go when the shell
    // exited, so a `kill -9` of vx inside the grace left the child to
    // nobody: the teardown holds its groups until its SIGKILL sweep is
    // done (item 865). The child waits on `go`, which the row writes only
    // after the kill: a `sleep 1` let vx end in the grace before a loaded
    // CI's SIGKILL came, and the kill found no vx (ESRCH).
    const dir = await addProject(
      root,
      'app',
      `export default { tasks: { dev: { exec: { command: '(trap "" INT TERM; sh -c \\'echo $PPID\\' > child.pid; echo up > up.txt; while [ ! -f go ]; do sleep 0.02; done; echo late > late.txt) >/dev/null 2>&1 & wait' } } } }`,
    )
    const proc = track(
      Bun.spawn([process.execPath, BIN, 'run', 'dev', '--all'], {
        cwd: root,
        env: { ...process.env, VX_TEST_KILL_GRACE: '5000ms' },
        stdout: 'ignore',
        stderr: 'ignore',
        detached: true,
      }),
    )
    const up = path.join(dir, 'up.txt')
    const deadline = Date.now() + 10_000
    while (!(existsSync(up) && readFileSync(up, 'utf8') === 'up\n')) {
      if (Date.now() > deadline) throw new Error('the child never trapped the signal')
      await Bun.sleep(20)
    }
    const child = Number(readFileSync(path.join(dir, 'child.pid'), 'utf8'))
    expect(isAlive(child)).toBe(true)
    process.kill(-proc.pid, 'SIGINT')
    await Bun.sleep(200)
    process.kill(proc.pid, 'SIGKILL')
    expect(await proc.exited).toBe(137)
    // The guard kills once the kernel has closed vx's pipe and the guard is
    // scheduled: `go` written at vx's exit reached a loaded gate's child
    // first (B-38). A child the guard missed outlives this wait and writes.
    await waitForDead(child, 5_000)
    await Bun.write(path.join(dir, 'go'), '')
    await Bun.sleep(2_000)
    expect(existsSync(path.join(dir, 'late.txt'))).toBe(false)
  }, 20_000)

  it('a kill -9 in the persistent shutdown’s grace takes the server a dead shell left', async () => {
    // The end-of-run shutdown SIGTERMs a persistent dependency; its
    // `& wait` shell dies at once and the server traps the signal and
    // cleans up slowly. The runner let the group go at the shell's exit;
    // the shutdown now holds it until its SIGKILL sweep (item 865). The
    // server marks the SIGTERM and lives on, so only a SIGKILL ends it: the
    // row asserts its death, not a write on a timer. A `late.txt` written a
    // second after the mark was red whenever the reap and the kill below
    // took longer than that on a loaded box (ws-m). READY waits for the
    // server's trap: a shutdown that came first ended it untrapped, and no
    // mark ever came (a loaded gate, B-17).
    const dir = await addProject(
      root,
      'app',
      `export default { tasks: {
        dev: { exec: { command: 'sh -c "trap \\\\"echo t > term.txt\\\\" TERM; echo up > up.txt; while :; do sleep 0.05; done" >/dev/null 2>&1 & echo $! > server.pid; until [ -s up.txt ]; do sleep 0.02; done; echo $$ > shell.pid; echo READY; wait', persistent: { readyWhen: 'READY' } } },
        e2e: { dependsOn: ['dev'], exec: { command: 'true' } },
      } }`,
    )
    const proc = track(
      Bun.spawn([process.execPath, BIN, 'run', 'e2e', '--all'], {
        cwd: root,
        env: { ...process.env, VX_TEST_KILL_GRACE: '5000ms' },
        stdout: 'ignore',
        stderr: 'ignore',
      }),
    )
    const term = path.join(dir, 'term.txt')
    const until = Date.now() + 10_000
    while (!existsSync(term) && Date.now() < until) await Bun.sleep(20)
    expect(existsSync(term)).toBe(true)
    // The shell reaped, and its exit (where the runner lets the group go)
    // handled: killed before that, vx still held the group anyway.
    expect(await waitForDead(await waitForPid(path.join(dir, 'shell.pid'), 1_000), 2_000)).toBe(
      true,
    )
    const server = await waitForPid(path.join(dir, 'server.pid'), 1_000)
    await Bun.sleep(100)
    process.kill(proc.pid, 'SIGKILL')
    expect(await proc.exited).toBe(137)
    expect(await waitForDead(server, 5_000)).toBe(true)
  }, 20_000)

  it('a kill -9 in a readiness timeout’s grace takes the server a dead shell left', async () => {
    // The readiness timeout SIGTERMs the group; the `& wait` shell dies at
    // once and lets the group go, and the server traps the signal. Its
    // SIGKILL waited on an unref'd timer, so a vx that ended first left the
    // server under init. The runner, then the task's own teardown
    // (`terminateChildren`), hold the group until its SIGKILL, and vx's exit
    // hands it to the guard (item 865). vx is killed inside the grace: left
    // alone it waits the grace out and kills the server itself, and the row
    // proved nothing of the guard. A 1 s deadline: at 300 ms a
    // slow shell start lost its trap to the TERM (M-23).
    const dir = await addProject(
      root,
      'app',
      `export default { tasks: {
        dev: { exec: { command: 'sh -c "trap \\\\"echo t > term.txt\\\\" TERM; while :; do sleep 0.05; done" >/dev/null 2>&1 & echo $! > server.pid; echo $$ > shell.pid; wait', timeout: '1s', persistent: { readyWhen: 'NEVER' } } },
      } }`,
    )
    const proc = track(
      Bun.spawn([process.execPath, BIN, 'run', 'dev', '--all'], {
        cwd: root,
        env: { ...process.env, VX_TEST_KILL_GRACE: '5000ms' },
        stdout: 'ignore',
        stderr: 'ignore',
      }),
    )
    const term = path.join(dir, 'term.txt')
    const until = Date.now() + 10_000
    while (!existsSync(term) && Date.now() < until) await Bun.sleep(20)
    expect(existsSync(term)).toBe(true)
    expect(await waitForDead(await waitForPid(path.join(dir, 'shell.pid'), 1_000), 2_000)).toBe(
      true,
    )
    const server = await waitForPid(path.join(dir, 'server.pid'), 1_000)
    expect(isAlive(server)).toBe(true)
    process.kill(proc.pid, 'SIGKILL')
    expect(await proc.exited).toBe(137)
    expect(await waitForDead(server, 3_000)).toBe(true)
  }, 20_000)

  it('CONTROL: a group vx finished with is not the guard’s when vx exits', async () => {
    // A one-shot task that leaves a process behind keeps it after vx's
    // clean exit, as before the guard: vx strikes the group from the list
    // once the task is done, so the EOF of a clean exit kills nothing.
    const dir = await addProject(
      root,
      'app',
      `export default { tasks: { dev: { exec: { command: '(sleep 1; echo late > late.txt) >/dev/null 2>&1 &' } } } }`,
    )
    const proc = track(
      Bun.spawn([process.execPath, BIN, 'run', 'dev', '--all'], {
        cwd: root,
        stdout: 'ignore',
        stderr: 'ignore',
      }),
    )
    expect(await proc.exited).toBe(0)
    // The file, as in the rows above: the grandchild writes it a second
    // after it starts, and the guard's EOF would have killed it first.
    await Bun.sleep(2_000)
    expect(existsSync(path.join(dir, 'late.txt'))).toBe(true)
  }, 20_000)
})
