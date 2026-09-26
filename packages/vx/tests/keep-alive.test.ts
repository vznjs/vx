// The real CLI foreground keeps the persistent tasks the user REQUESTED
// alive after the summary. That session ends when ONE of them exits: the
// others are torn down (SIGTERM, grace, SIGKILL) and a non-zero exit makes
// the run exit 1, so `vx run dev` in a script fails when the server it
// started fell over. Until 2026-09-10 the wait was for every server, so a
// crash left the rest running under a run that never returned.

import { existsSync, readFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { isAlive, waitForDead } from './helpers/alive.js'
import { addProject, makeWorkspace } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')

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
            command: 'echo READY; sleep 0.3; exit ${exitCode}',
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
    await rm(root, { recursive: true, force: true })
  })

  for (const [exitCode, expected] of [
    [1, 1],
    [0, 0],
  ] as const) {
    it(`a server exiting ${exitCode} tears the other down and vx exits ${expected}`, async () => {
      const dir = await addProject(root, 'app', config(exitCode))
      const proc = Bun.spawn([process.execPath, BIN, 'run', 'dev', 'other', '--all'], {
        cwd: root,
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, VX_KILL_GRACE_MS: '200' },
      })
      const pid = await waitForPid(path.join(dir, 'pid.txt'), 10_000)
      expect(isAlive(pid)).toBe(true)
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
    }, 20_000)
  }

  // turborepo#12920: Ctrl-C during the foreground wait after the summary
  // did not end the run.
  it('SIGINT after the summary exits 130 and takes the server down', async () => {
    const dir = await addProject(root, 'app', config(0))
    const proc = Bun.spawn([process.execPath, BIN, 'run', 'app#dev'], {
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, CI: '', GITHUB_ACTIONS: '', VX_KILL_GRACE_MS: '200' },
    })
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
  }, 20_000)
})

describe('a persistent task keeps an open stdin', () => {
  let root: string
  beforeEach(async () => {
    root = await makeWorkspace({ prefix: 'vx-keepalive-stdin-' })
  })
  afterEach(async () => {
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
    const proc = Bun.spawn([process.execPath, BIN, 'run', 'dev', '--all'], {
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, VX_KILL_GRACE_MS: '200' },
    })
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
    const proc = Bun.spawn([process.execPath, BIN, 'run', 'dev', '--all'], {
      cwd: root,
      stdout: 'ignore',
      stderr: 'ignore',
    })
    const pid = await waitForPid(path.join(dir, 'pid.txt'), 10_000)
    expect(isAlive(pid)).toBe(true)
    process.kill(proc.pid, 'SIGKILL')
    expect(await proc.exited).toBe(137)
    expect(await waitForDead(pid, 2_000)).toBe(true)
  }, 20_000)
})

describe('a SIGKILLed vx takes the groups it holds with it', () => {
  let root: string
  beforeEach(async () => {
    root = await makeWorkspace({ prefix: 'vx-keepalive-' })
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  // The rest of a `kill -9`: vx's group guard (kill-tree.ts) holds the
  // groups vx has not finished with and SIGKILLs them when vx's end of
  // its pipe closes. Each row's grandchild watches nothing, so only the
  // group kill takes it (turborepo#9666). It writes `late.txt` a second
  // after it starts: a file, not a pid, because under a sandbox's pid
  // namespace a killed orphan stays a zombie that signal 0 still finds.
  async function outlivesVx(exec: string): Promise<boolean> {
    const dir = await addProject(
      root,
      'app',
      `export default { tasks: { dev: { exec: ${exec} } } }`,
    )
    const proc = Bun.spawn([process.execPath, BIN, 'run', 'dev', '--all'], {
      cwd: root,
      stdout: 'ignore',
      stderr: 'ignore',
    })
    await waitForPid(path.join(dir, 'pid.txt'), 10_000)
    process.kill(proc.pid, 'SIGKILL')
    expect(await proc.exited).toBe(137)
    // Twice the grandchild's second: without the guard it writes at one.
    await Bun.sleep(2_000)
    return existsSync(path.join(dir, 'late.txt'))
  }

  it('a SIGKILLed vx takes an unsandboxed persistent task’s backgrounded server with it', async () => {
    expect(
      await outlivesVx(
        `{ command: '(sleep 1; echo late > late.txt) & echo $! > pid.txt; echo READY; wait', persistent: { readyWhen: 'READY' } }`,
      ),
    ).toBe(false)
  }, 20_000)

  it('a SIGKILLed vx takes an unsandboxed one-shot task’s backgrounded child with it', async () => {
    expect(
      // It ignores SIGTERM, as a server's cleanup might: only a SIGKILL takes it.
      await outlivesVx(
        `{ command: '(trap "" INT TERM; sleep 1; echo late > late.txt) & echo $! > pid.txt; wait' }`,
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
        `export default { tasks: { build: { exec: { command: 'true' }, cache: { inputs: { files: ['**/*'] }, outputs: { files: [] } } } } }`,
      )
    const guards = async (): Promise<string[]> => {
      await rm(log, { force: true })
      const proc = Bun.spawn(
        [process.execPath, '--preload', preload, BIN, 'run', 'build', '--all'],
        {
          cwd: root,
          stdout: 'ignore',
          stderr: 'ignore',
        },
      )
      expect(await proc.exited).toBe(0)
      const lines = existsSync(log) ? readFileSync(log, 'utf8').split('\n') : []
      return lines.filter((l) => l === 'vx-group-guard' || l === 'sh')
    }
    expect(await guards()).toEqual(['vx-group-guard', 'sh', 'sh'])
    expect(await guards()).toEqual([])
  }, 20_000)

  it('a terminal’s Ctrl-C leaves the guard, so a kill -9 in the teardown still takes the task', async () => {
    // A terminal signals its foreground group: vx and, were it in vx's
    // group, the guard, which a SIGINT kills. vx's teardown then waits
    // out the grace on a task that ignores the signal, and a `kill -9`
    // there left the task to nobody.
    const dir = await addProject(
      root,
      'app',
      `export default { tasks: { dev: { exec: { command: 'trap "" INT TERM; (sleep 1; echo late > late.txt) & echo $! > pid.txt; wait' } } } }`,
    )
    const proc = Bun.spawn([process.execPath, BIN, 'run', 'dev', '--all'], {
      cwd: root,
      env: { ...process.env, VX_KILL_GRACE_MS: '5000' },
      stdout: 'ignore',
      stderr: 'ignore',
      detached: true,
    })
    await waitForPid(path.join(dir, 'pid.txt'), 10_000)
    process.kill(-proc.pid, 'SIGINT')
    await Bun.sleep(200)
    process.kill(proc.pid, 'SIGKILL')
    expect(await proc.exited).toBe(137)
    await Bun.sleep(2_000)
    expect(existsSync(path.join(dir, 'late.txt'))).toBe(false)
  }, 20_000)

  it('a kill -9 in a Ctrl-C’s grace takes the child of a shell that died on the signal', async () => {
    // The shell dies on the SIGINT; the child it backgrounded ignores it
    // and runs out the grace. The runner let the group go when the shell
    // exited, so a `kill -9` of vx inside the grace left the child to
    // nobody: the teardown holds its groups until its SIGKILL sweep is
    // done (item 865).
    const dir = await addProject(
      root,
      'app',
      `export default { tasks: { dev: { exec: { command: '(trap "" INT TERM; sleep 1; echo late > late.txt) >/dev/null 2>&1 & echo $! > pid.txt; wait' } } } }`,
    )
    const proc = Bun.spawn([process.execPath, BIN, 'run', 'dev', '--all'], {
      cwd: root,
      env: { ...process.env, VX_KILL_GRACE_MS: '5000' },
      stdout: 'ignore',
      stderr: 'ignore',
      detached: true,
    })
    await waitForPid(path.join(dir, 'pid.txt'), 10_000)
    process.kill(-proc.pid, 'SIGINT')
    await Bun.sleep(200)
    process.kill(proc.pid, 'SIGKILL')
    expect(await proc.exited).toBe(137)
    await Bun.sleep(2_000)
    expect(existsSync(path.join(dir, 'late.txt'))).toBe(false)
  }, 20_000)

  it('a kill -9 in the persistent shutdown’s grace takes the server a dead shell left', async () => {
    // The end-of-run shutdown SIGTERMs a persistent dependency; its
    // `& wait` shell dies at once and the server traps the signal and
    // cleans up slowly. The runner let the group go at the shell's exit;
    // the shutdown now holds it until its SIGKILL sweep (item 865). The
    // server marks the SIGTERM, then writes a second later.
    const dir = await addProject(
      root,
      'app',
      `export default { tasks: {
        dev: { exec: { command: 'sh -c "trap \\\\"echo t > term.txt; sleep 1; echo late > late.txt\\\\" TERM; while :; do sleep 0.05; done" >/dev/null 2>&1 & echo $$ > shell.pid; echo READY; wait', persistent: { readyWhen: 'READY' } } },
        e2e: { dependsOn: ['dev'], exec: { command: 'true' } },
      } }`,
    )
    const proc = Bun.spawn([process.execPath, BIN, 'run', 'e2e', '--all'], {
      cwd: root,
      env: { ...process.env, VX_KILL_GRACE_MS: '5000' },
      stdout: 'ignore',
      stderr: 'ignore',
    })
    const term = path.join(dir, 'term.txt')
    const until = Date.now() + 10_000
    while (!existsSync(term) && Date.now() < until) await Bun.sleep(20)
    expect(existsSync(term)).toBe(true)
    // The shell reaped, and its exit (where the runner lets the group go)
    // handled: killed before that, vx still held the group anyway.
    expect(await waitForDead(await waitForPid(path.join(dir, 'shell.pid'), 1_000), 2_000)).toBe(
      true,
    )
    await Bun.sleep(100)
    process.kill(proc.pid, 'SIGKILL')
    expect(await proc.exited).toBe(137)
    await Bun.sleep(2_000)
    expect(existsSync(path.join(dir, 'late.txt'))).toBe(false)
  }, 20_000)

  it('a never-ready server a dead shell left goes with a vx that exits inside the grace', async () => {
    // The readiness timeout SIGTERMs the group; the `& wait` shell dies at
    // once and lets the group go, and the server traps the signal. Its
    // SIGKILL waits on an unref'd timer, so a vx whose run ended first
    // exited and left the server under init. The timeout holds the group
    // until its SIGKILL, and vx's exit hands it to the guard (item 865).
    const dir = await addProject(
      root,
      'app',
      `export default { tasks: {
        dev: { exec: { command: 'sh -c "echo s > started.txt; trap \\\\"echo t > term.txt; sleep 1; echo late > late.txt\\\\" TERM; while :; do sleep 0.05; done" >/dev/null 2>&1 & wait', timeout: 300, persistent: { readyWhen: 'NEVER' } } },
      } }`,
    )
    const proc = Bun.spawn([process.execPath, BIN, 'run', 'dev', '--all'], {
      cwd: root,
      env: { ...process.env, VX_KILL_GRACE_MS: '5000' },
      stdout: 'ignore',
      stderr: 'ignore',
    })
    expect(await proc.exited).toBe(1)
    // The server ran. Not its SIGTERM mark: the trap waits for the
    // loop's sleep, and a vx that exits first hands the group to the
    // guard, which may kill it before the mark (macOS CI, item 867).
    expect(existsSync(path.join(dir, 'started.txt'))).toBe(true)
    await Bun.sleep(2_000)
    expect(existsSync(path.join(dir, 'late.txt'))).toBe(false)
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
    const proc = Bun.spawn([process.execPath, BIN, 'run', 'dev', '--all'], {
      cwd: root,
      stdout: 'ignore',
      stderr: 'ignore',
    })
    expect(await proc.exited).toBe(0)
    // The file, as in the rows above: the grandchild writes it a second
    // after it starts, and the guard's EOF would have killed it first.
    await Bun.sleep(2_000)
    expect(existsSync(path.join(dir, 'late.txt'))).toBe(true)
  }, 20_000)
})
