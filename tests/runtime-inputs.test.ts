// e2e for cache.inputs.runtime / workspaceRuntime. Spawns the real CLI:
// the headline property (output resolved live even under --frozen) only
// holds across real invocations.

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from 'bun:test'
import { writeLocalWorkspace } from './helpers/local-workspace.js'

setDefaultTimeout(30_000)

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')

function git(cwd: string, ...args: string[]): void {
  const p = Bun.spawnSync({
    cmd: ['git', '-c', 'commit.gpgsign=false', ...args],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (p.exitCode !== 0)
    throw new Error(`git ${args.join(' ')}: ${new TextDecoder().decode(p.stderr)}`)
}

async function makeWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vx-runtime-e2e-'))
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'root', private: true }))
  await writeLocalWorkspace(root)
  await mkdir(path.join(root, 'packages'), { recursive: true })
  git(root, 'init', '-q')
  git(root, 'config', 'user.email', 't@vx.local')
  git(root, 'config', 'user.name', 'vx')
  return root
}

async function addProject(root: string, name: string, config: string): Promise<string> {
  const dir = path.join(root, 'packages', name)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name, version: '0.0.0' }))
  await writeFile(path.join(dir, 'vx.config.mjs'), config)
  return dir
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
    git(root, 'add', '-A')
    git(root, 'commit', '-q', '-m', 'init')

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
    git(root, 'add', '-A')
    git(root, 'commit', '-q', '-m', 'init')

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
    git(root, 'add', '-A')
    git(root, 'commit', '-q', '-m', 'init')
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
    git(root, 'add', '-A')
    git(root, 'commit', '-q', '-m', 'init')

    const r = await vx(root, ['run', 'build', '--all'])
    expect(r.code).toBe(0)
    // Both projects declare the identical workspaceRuntime command →
    // global dedup → exactly one spawn for the whole run.
    expect((await readFile(counter, 'utf8')).length).toBe(1)
  })
})
