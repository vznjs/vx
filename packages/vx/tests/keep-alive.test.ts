// The real CLI foreground keeps the persistent tasks the user REQUESTED
// alive after the summary. That session ends when ONE of them exits: the
// others are torn down (SIGTERM, grace, SIGKILL) and a non-zero exit makes
// the run exit 1, so `vx run dev` in a script fails when the server it
// started fell over. Until 2026-09-10 the wait was for every server, so a
// crash left the rest running under a run that never returned.

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
