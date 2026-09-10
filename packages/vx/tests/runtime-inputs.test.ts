// e2e for cache.inputs.runtime / workspaceRuntime. Spawns the real CLI:
// the headline property (output resolved live even under --frozen) only
// holds across real invocations.

import { readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from 'bun:test'
import { addProject, gitIn, makeWorkspace as makeWorkspaceRoot } from './helpers/workspace.js'

setDefaultTimeout(30_000)

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')

function makeWorkspace(): Promise<string> {
  return makeWorkspaceRoot({ prefix: 'vx-runtime-e2e-', rootName: 'root' })
}

async function vx(root: string, args: string[], env: Record<string, string> = {}) {
  const proc = Bun.spawn([process.execPath, BIN, ...args], {
    cwd: root,
    env: { ...process.env, CI: '', GITHUB_ACTIONS: '', ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, out, err }
}

describe('runtime inputs — e2e', () => {
  let root: string
  beforeEach(async () => {
    root = await makeWorkspace()
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('runtime output change invalidates the cache (re-executes)', async () => {
    // Marker file feeds the runtime command's output; the task appends to
    // a hit-log on every real execution. The log path is inlined into the
    // command because vx runs tasks in an isolated env (parent vars are
    // not passed through unless declared in exec.env.passThrough).
    const log = path.join(root, 'execlog')
    await writeFile(path.join(root, 'marker'), 'A')
    await addProject(
      root,
      'a',
      `export default {
        tasks: {
          build: {
            exec: { command: "echo built >> ${log}" },
            cache: {
              inputs: { files: [], workspaceRuntime: ['cat marker'] },
              outputs: { files: [] },
            },
          },
        },
      }`,
    )
    gitIn(root)('add', '-A')
    gitIn(root)('commit', '-q', '-m', 'init')

    const r1 = await vx(root, ['run', 'build', '--all'])
    expect(r1.code).toBe(0)
    const r2 = await vx(root, ['run', 'build', '--all']) // same marker → hit
    expect(r2.code).toBe(0)
    expect((await readFile(log, 'utf8')).trim().split('\n').length).toBe(1)

    await writeFile(path.join(root, 'marker'), 'B') // output changes → miss
    const r3 = await vx(root, ['run', 'build', '--all'])
    expect(r3.code).toBe(0)
    expect((await readFile(log, 'utf8')).trim().split('\n').length).toBe(2)
  })

  it('stays live under --frozen (re-resolves output after lock)', async () => {
    const log = path.join(root, 'execlog')
    await writeFile(path.join(root, 'marker'), 'A')
    await addProject(
      root,
      'a',
      `export default {
        tasks: {
          build: {
            exec: { command: "echo built >> ${log}" },
            cache: {
              inputs: { files: [], workspaceRuntime: ['cat marker'] },
              outputs: { files: [] },
            },
          },
        },
      }`,
    )
    gitIn(root)('add', '-A')
    gitIn(root)('commit', '-q', '-m', 'init')

    const lock = await vx(root, ['lock'])
    expect(lock.code).toBe(0)
    const r1 = await vx(root, ['run', 'build', '--all', '--frozen'])
    expect(r1.code).toBe(0)
    expect((await readFile(log, 'utf8')).trim().split('\n').length).toBe(1)

    await writeFile(path.join(root, 'marker'), 'B') // command string unchanged; output differs
    const r2 = await vx(root, ['run', 'build', '--all', '--frozen'])
    expect(r2.code).toBe(0)
    // Lock froze only the command 'cat marker'; output is resolved live →
    // the changed output must produce a miss and re-execute.
    expect((await readFile(log, 'utf8')).trim().split('\n').length).toBe(2)
  })

  it('non-zero runtime command fails the run', async () => {
    await addProject(
      root,
      'a',
      `export default {
        tasks: {
          build: {
            exec: { command: "echo hi" },
            cache: { inputs: { files: [], runtime: ['sh -c "exit 7"'] }, outputs: { files: [] } },
          },
        },
      }`,
    )
    gitIn(root)('add', '-A')
    gitIn(root)('commit', '-q', '-m', 'init')
    const r = await vx(root, ['run', 'build', '--all'])
    expect(r.code).not.toBe(0)
    expect(`${r.out}${r.err}`).toMatch(/runtime command exited 7/)
    // A failed runtime command is a user/config error, not a vx bug —
    // it must not be reported as an "internal error".
    expect(`${r.out}${r.err}`).not.toMatch(/internal error/)
  })

  it('workspaceRuntime shared by two projects spawns once', async () => {
    const counter = path.join(root, 'spawncount')
    const cfg = (n: string) => `export default {
      tasks: {
        build: {
          exec: { command: "echo ${n}" },
          cache: {
            inputs: { files: [], workspaceRuntime: ["sh -c 'printf x >> ${counter}; echo v1'"] },
            outputs: { files: [] },
          },
        },
      },
    }`
    await addProject(root, 'a', cfg('a'))
    await addProject(root, 'b', cfg('b'))
    gitIn(root)('add', '-A')
    gitIn(root)('commit', '-q', '-m', 'init')

    const r = await vx(root, ['run', 'build', '--all'])
    expect(r.code).toBe(0)
    // Both projects declare the identical workspaceRuntime command →
    // global dedup → exactly one spawn for the whole run.
    expect((await readFile(counter, 'utf8')).length).toBe(1)
  })

  it("the probe reads the AMBIENT env, never a task's exec.env — which is what makes the memo sound", async () => {
    // Two tasks in one project, the same probe, different `define`s. The
    // memo is keyed on (projectDir, command), so the probe runs ONCE and
    // both tasks fold the one value — sound only because the value comes
    // from vx's own environment. A change that threads the task env into
    // the probe without widening the memo would hand task A's value to
    // task B (one line, 'a' or 'b'); one that widens the memo would spawn
    // twice (two lines). Both fail here; Nx pins the same regression.
    const log = path.join(root, 'probe.log')
    await addProject(
      root,
      'a',
      `export default {
        tasks: {
          build: {
            exec: { command: 'true', env: { define: { MY_PROBE: 'a' } } },
            cache: {
              inputs: { files: [], runtime: ['printenv MY_PROBE >> ${log} || echo unset >> ${log}'] },
              outputs: { files: [] },
            },
          },
          test: {
            exec: { command: 'true', env: { define: { MY_PROBE: 'b' } } },
            cache: {
              inputs: { files: [], runtime: ['printenv MY_PROBE >> ${log} || echo unset >> ${log}'] },
              outputs: { files: [] },
            },
          },
        },
      }
      `,
    )
    // `--dry` derives every key, so the probe runs without executing a task.
    const r = await vx(root, ['run', 'build', 'test', '--filter', 'a', '--dry'], {
      MY_PROBE: 'ambient',
    })
    expect(r.code).toBe(0)
    expect(await readFile(log, 'utf8')).toBe('ambient\n')
  })
})
