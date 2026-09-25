// `vx watch` owns SIGINT/SIGTERM for its lifetime and exits 0 on either.
// What that must include: the cycle in flight — its children are torn
// down (SIGTERM, grace, SIGKILL) before the process goes. Until
// 2026-09-10 the handlers were installed after the initial run, so a
// SIGTERM during it took Bun's default (exit 143) and left the cycle's
// child running under init; the first pin fails that way without the fix.

import { rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { describePid, isAlive, waitForDead } from './helpers/alive.js'
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

async function waitForText(
  read: () => Promise<string>,
  needle: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if ((await read()).includes(needle)) return
    await Bun.sleep(50)
  }
  throw new Error(`timed out waiting for ${JSON.stringify(needle)}`)
}

describe('vx watch under a signal (e2e)', () => {
  let root: string
  beforeEach(async () => {
    root = await makeWorkspace({ prefix: 'vx-watch-signal-' })
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('SIGTERM during the initial run tears the cycle down and exits 0', async () => {
    const dir = await addProject(
      root,
      'app',
      `
        export default {
          tasks: { slow: { exec: { command: 'echo $$ > pid.txt; exec sleep 30' } } },
        }
      `,
    )
    const proc = Bun.spawn([process.execPath, BIN, 'watch', 'slow', '--all'], {
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, VX_KILL_GRACE_MS: '200' },
    })
    const pid = await waitForPid(path.join(dir, 'pid.txt'), 10_000)
    expect(isAlive(pid)).toBe(true)
    proc.kill('SIGTERM')
    expect(await proc.exited).toBe(0)
    expect(await waitForDead(pid, 1_000)).toBe(true)
  }, 20_000)

  it('SIGINT while idle prints stopped and exits 0', async () => {
    await addProject(
      root,
      'app',
      `
        export default {
          tasks: { quick: { exec: { command: 'echo done' } } },
        }
      `,
    )
    const proc = Bun.spawn([process.execPath, BIN, 'watch', 'quick', '--all'], {
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    let out = ''
    const reader = (async () => {
      for await (const chunk of proc.stdout) out += new TextDecoder().decode(chunk)
    })()
    await waitForText(async () => out, 'watching', 10_000)
    proc.kill('SIGINT')
    expect(await proc.exited).toBe(0)
    await reader
    expect(out).toContain('vx watch: stopped')
  }, 20_000)

  // The loop forwards the signal it received, as `vx run` does: a Ctrl-C
  // reaches the cycle's task and the dev server it holds between cycles
  // as SIGINT, so a SIGINT-only cleanup runs. The task records which
  // signal reached it.
  const TRAPS =
    "trap 'echo SIGINT > got.txt; exit 0' INT; trap 'echo SIGTERM > got.txt; exit 0' TERM"
  // Each title a literal: the upstream ledger cites them by their text.
  const reachesAsSigint = (persistent: boolean) => async () => {
    const dir = await addProject(
      root,
      'app',
      `
        export default {
          tasks: {
            t: {
              exec: {
                command: "${TRAPS}; echo $$ > pid.txt; echo READY; while :; do sleep 0.05; done",
                ${persistent ? "persistent: { readyWhen: 'READY' }," : ''}
              },
            },
          },
        }
      `,
    )
    const proc = Bun.spawn([process.execPath, BIN, 'watch', 't', '--all'], {
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, VX_KILL_GRACE_MS: '200' },
    })
    let out = ''
    const reader = (async () => {
      for await (const chunk of proc.stdout) out += new TextDecoder().decode(chunk)
    })()
    const err = new Response(proc.stderr).text()
    const pid = await waitForPid(path.join(dir, 'pid.txt'), 10_000)
    if (persistent) await waitForText(async () => out, 'watching', 10_000)
    proc.kill('SIGINT')
    const code = await proc.exited
    await reader
    const got = await Bun.file(path.join(dir, 'got.txt'))
      .text()
      .then(
        (t) => t.trim(),
        () => '<no got.txt>',
      )
    const dead = await waitForDead(pid, 1_000)
    // One comparison, and on a mismatch everything vx said beside it: the
    // macOS job failed this row once with the assertion cut from the log
    // (STATUS Next 23).
    const seen = { code, got, dead }
    const want = { code: 0, got: 'SIGINT', dead: true }
    expect(
      Bun.deepEquals(seen, want)
        ? seen
        : { ...seen, task: describePid(pid), stdout: out, stderr: await err },
    ).toEqual(want)
  }

  it('SIGINT during the initial run reaches its task as SIGINT', reachesAsSigint(false), 20_000)
  it('SIGINT while idle reaches the dev server it holds as SIGINT', reachesAsSigint(true), 20_000)
})
