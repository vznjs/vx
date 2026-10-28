// e2e for inputs.runtime / workspaceRuntime. Spawns the real CLI:
// the headline property (output resolved live though the command is the
// lock's) only holds across real invocations.

import { existsSync } from 'node:fs'
import { readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from 'bun:test'
import { addProject, gitIn, makeWorkspace as makeWorkspaceRoot } from './helpers/workspace.js'

setDefaultTimeout(30_000)

const BIN = path.resolve(import.meta.dir, 'helpers', 'vx-locked.ts')
const REAL_BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')

function makeWorkspace(): Promise<string> {
  return makeWorkspaceRoot({ prefix: 'vx-runtime-e2e-', rootName: 'root' })
}

async function vx(root: string, args: string[], env: Record<string, string> = {}, bin = BIN) {
  const proc = Bun.spawn([process.execPath, bin, ...args], {
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
            inputs: { files: [], workspaceRuntime: ['cat marker'] },
            cache: {
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

  it('refuses runtime output that is not UTF-8 rather than key its lossy decode', async () => {
    // Latin-1 é and è both decoded to U+FFFD, so changing the marker kept
    // the key and replayed the other byte's build.
    const log = path.join(root, 'execlog')
    await writeFile(path.join(root, 'marker'), Buffer.from([0xe9]))
    await addProject(
      root,
      'a',
      `export default {
        tasks: {
          build: {
            exec: { command: "echo built >> ${log}" },
            inputs: { files: [], workspaceRuntime: ['cat marker'] },
            cache: {
              outputs: { files: [] },
            },
          },
        },
      }`,
    )
    gitIn(root)('add', '-A')
    gitIn(root)('commit', '-q', '-m', 'init')

    const r = await vx(root, ['run', 'build', '--all'])
    expect(r.code).not.toBe(0)
    expect(r.out + r.err).toContain(
      'inputs runtime command printed bytes that are not UTF-8: cat marker',
    )
    expect(existsSync(log)).toBe(false)
  })

  it('stays live from the lock (re-resolves output after lock)', async () => {
    const log = path.join(root, 'execlog')
    await writeFile(path.join(root, 'marker'), 'A')
    await addProject(
      root,
      'a',
      `export default {
        tasks: {
          build: {
            exec: { command: "echo built >> ${log}" },
            inputs: { files: [], workspaceRuntime: ['cat marker'] },
            cache: {
              outputs: { files: [] },
            },
          },
        },
      }`,
    )
    gitIn(root)('add', '-A')
    gitIn(root)('commit', '-q', '-m', 'init')

    const lock = await vx(root, ['lock'], {}, REAL_BIN)
    expect(lock.code).toBe(0)
    const r1 = await vx(root, ['run', 'build', '--all'], {}, REAL_BIN)
    expect(r1.code).toBe(0)
    expect((await readFile(log, 'utf8')).trim().split('\n').length).toBe(1)

    await writeFile(path.join(root, 'marker'), 'B') // command string unchanged; output differs
    const r2 = await vx(root, ['run', 'build', '--all'], {}, REAL_BIN)
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
            inputs: { files: [], runtime: ['sh -c "exit 7"'] }, cache: { outputs: { files: [] } },
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
          inputs: { files: [], workspaceRuntime: ["sh -c 'printf x >> ${counter}; echo v1'"] },
          cache: {
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

  it("the probe reads vx's essentials only, never a task's exec.env — which is what makes the memo sound", async () => {
    // Two tasks in one project, the same probe, different `define`s. The
    // memo is keyed on (projectDir, command), so the probe runs ONCE and
    // both tasks fold the one value — sound only because every probe gets
    // one environment. vx's own MY_PROBE stays out too: a probe sees
    // `ESSENTIAL_ENV` alone, so a task cannot read vx's secrets through
    // it. A change that threads the task env into
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
            inputs: { files: [], runtime: ['printenv MY_PROBE >> ${log} || echo unset >> ${log}'] },
            cache: {
              outputs: { files: [] },
            },
          },
          test: {
            exec: { command: 'true', env: { define: { MY_PROBE: 'b' } } },
            inputs: { files: [], runtime: ['printenv MY_PROBE >> ${log} || echo unset >> ${log}'] },
            cache: {
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
    expect(await readFile(log, 'utf8')).toBe('unset\n')
  })

  // A gitignored file a tool reads by itself (Vite's `.env.local`) is not a
  // file git lists, so a broad glob skips it. Named outright it is keyed;
  // a probe over its bytes still works: docs/caching.md § What's NOT
  // in the key. Without one, an edit replays the old build.
  it('a gitignored .env.local keys only through a probe, which survives the file being absent', async () => {
    const config = (runtime: string) => `export default {
      tasks: {
        build: {
          exec: { command: 'mkdir -p dist; (cat .env.local 2>/dev/null || echo none) > dist/env' },
          inputs: { files: ['src/**'], runtime: [${runtime}] },
          cache: { outputs: { files: ['dist/**'] } },
        },
      },
    }`
    const plain = await addProject(root, 'plain', { config: config(''), files: { 'src/a.ts': '' } })
    const keyed = await addProject(root, 'keyed', {
      config: config(`'cat .env.local .env.production.local 2>/dev/null | cksum'`),
      files: { 'src/a.ts': '' },
    })
    await writeFile(path.join(root, '.gitignore'), '.vx/cache/\ndist/\n.env*.local\n')
    gitIn(root)('add', '-A')
    gitIn(root)('commit', '-q', '-m', 'init')
    const built = (dir: string) => readFile(path.join(dir, 'dist', 'env'), 'utf8')

    for (const dir of [plain, keyed]) await writeFile(path.join(dir, '.env.local'), 'API=a\n')
    expect((await vx(root, ['run', 'build', '--all'])).code).toBe(0)
    for (const dir of [plain, keyed]) await writeFile(path.join(dir, '.env.local'), 'API=b\n')
    expect((await vx(root, ['run', 'build', '--all'])).code).toBe(0)
    expect([await built(plain), await built(keyed)]).toEqual(['API=a\n', 'API=b\n'])

    await rm(path.join(keyed, '.env.local'))
    expect((await vx(root, ['run', 'build', '--all'])).code).toBe(0)
    expect(await built(keyed)).toBe('none\n')
  })
})
