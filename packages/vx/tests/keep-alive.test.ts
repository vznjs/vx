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
})
