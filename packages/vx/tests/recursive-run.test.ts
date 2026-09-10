// A task that shells out to `vx run` in its own workspace is refused: a
// loop back to itself forks a run per run without bound, and a nested
// run that terminates is still invisible to the outer graph (schedule,
// concurrency budget, cache key). `taskEnv` marks every child with the
// workspace root and the task id (exec/env.ts); `run()` refuses when the
// root it resolves is the one already running it. The e2e shape is the
// only honest one — an in-process `run()` cannot fork. The control is
// what must keep working: vx driving a DIFFERENT workspace from a task
// (a fixture suite, a benchmark).

import { rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { addProject, makeWorkspace } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const VX = `${process.execPath} ${BIN}`

async function runVx(root: string, args: string[]): Promise<{ code: number; text: string }> {
  const proc = Bun.spawn([process.execPath, BIN, 'run', ...args], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, text: out + err }
}

describe('vx run inside a task', () => {
  let root: string
  let other: string
  beforeEach(async () => {
    root = await makeWorkspace({ prefix: 'vx-recurse-' })
    other = await makeWorkspace({ prefix: 'vx-recurse-other-' })
    await addProject(
      other,
      'lib',
      `
        export default { tasks: { hello: { exec: { command: 'echo hello from other' } } } }
      `,
    )
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
    await rm(other, { recursive: true, force: true })
  })

  it("is refused in the task's own workspace, naming the task", async () => {
    await addProject(
      root,
      'app',
      `
        export default {
          tasks: {
            loop: { exec: { command: '${VX} run loop --all' } },
          },
        }
      `,
    )
    const r = await runVx(root, ['loop', '--all'])
    expect(r.code).toBe(1)
    expect(r.text).toContain('task app#loop runs `vx run` inside its own workspace')
    expect(r.text).toContain('dependsOn')
  }, 30_000)

  it('is refused when it terminates too — ci calling `vx run lint` is a run the outer graph cannot see', async () => {
    await addProject(
      root,
      'app',
      `
        export default {
          tasks: {
            lint: { exec: { command: 'echo lint' } },
            ci: { exec: { command: '${VX} run lint --all' } },
          },
        }
      `,
    )
    const r = await runVx(root, ['ci', '--all'])
    expect(r.code).toBe(1)
    expect(r.text).toContain('task app#ci runs `vx run` inside its own workspace')
  }, 30_000)

  it('drives a different workspace from a task (control)', async () => {
    await addProject(
      root,
      'app',
      `
        export default {
          tasks: {
            bench: { exec: { command: 'cd ${other} && ${VX} run hello --all' } },
          },
        }
      `,
    )
    const r = await runVx(root, ['bench', '--all'])
    expect(r.text).not.toContain('inside its own workspace')
    expect(r.code).toBe(0)
  }, 30_000)
})
