// A task killed by a signal (item 259): the frame said `failed (exit 137)`
// and nothing about what 137 is. The line names the signal and what sends
// it — a SIGKILL the runner saw, and a SIGSEGV a pipeline's exit code alone
// carries. The control: vx's own timeout keeps its own line, no verdict.
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { addProject, gitIn, makeWorkspace } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')

function vx(cwd: string, args: string[]): { code: number; text: string } {
  const p = Bun.spawnSync({
    cmd: [process.execPath, BIN, ...args],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, NO_COLOR: '1', CI: '' },
  })
  return {
    code: p.exitCode ?? 1,
    text: new TextDecoder().decode(p.stdout) + new TextDecoder().decode(p.stderr),
  }
}

describe('a task killed by a signal', () => {
  let root: string
  beforeEach(async () => {
    root = await makeWorkspace({ prefix: 'vx-signal-' })
    await addProject(root, 'app', {
      config: `
        export default {
          tasks: {
            // exec-wrapped: kill replaces the shell and kills its own pid.
            killed: { exec: { command: 'kill -9 $$' } },
            // an inner sh dies; the outer shell reports 139 with no signal
            // (a subshell's $$ is still the outer shell's pid).
            segv: { exec: { command: "sh -c 'kill -SEGV $$'; exit $?" } },
            slow: { exec: { command: 'sleep 5', timeout: 300 } },
          },
        }
      `,
      files: {},
    })
    const git = gitIn(root)
    git('add', '-A')
    git('commit', '-q', '-m', 'init')
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('a SIGKILL the runner saw is named with the OOM killer and a kill', () => {
    const r = vx(root, ['run', 'killed', '--all'])
    expect(r.code).toBe(1)
    expect(r.text).toContain('failed (exit 137)')
    expect(r.text).toContain(
      `[vx] exit 137 is how the shell reports a death by SIGKILL (9): nothing catches it — on Linux the kernel's OOM killer`,
    )
  })

  it('a 139 the shell reports for a subshell is named as SIGSEGV or its own exit', () => {
    const r = vx(root, ['run', 'segv', '--all'])
    expect(r.code).toBe(1)
    expect(r.text).toContain('failed (exit 139)')
    expect(r.text).toContain(
      `[vx] exit 139 is 128 + 11, the shell's report of a death by SIGSEGV in the last command (or that command exited 139 itself): the program crashed in native code`,
    )
  })

  // CONTROL: vx's own timeout is a SIGTERM the task already explains.
  it("vx's own timeout keeps its line and gets no signal verdict", () => {
    const r = vx(root, ['run', 'slow', '--all'])
    expect(r.code).toBe(1)
    expect(r.text).toContain('[vx] timed out after 300ms — killed (SIGTERM)')
    expect(r.text).not.toContain('is how the shell reports')
    expect(r.text).not.toContain('is 128 +')
  })
})
