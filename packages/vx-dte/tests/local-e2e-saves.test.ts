// A distributed run end to end on `local()`: what a worker saves and brings
// back (local-e2e-fixture.ts).

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { CORE_BIN, CORE_INDEX, DTE, root, setup, teardown, vx } from './local-e2e-fixture.ts'

beforeEach(setup)
afterEach(teardown)

// 2026-10-21: "After I kill it, long delay". Removing a worktree an
// install filled took seconds, all of them before vx exited. An `rm` that
// takes 3 s stands in for that install's 300k files, which took 45 s to
// make on a CI-sized machine.
// A task the stopped run cancelled exited 0 from a trapped SIGTERM, and its
// worker saved it under its key: the next run hit it (2026-10-24).
it('saves no entry for a task a stopped run cancelled, even on a 0 exit', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'vx-dte-halt-'))
  try {
    const { VX_DTE_RUN: _, ...env } = process.env
    const run = Bun.spawn([process.execPath, CORE_BIN, 'run', 'b#halt'], {
      cwd: root,
      env: {
        ...env,
        VX_DTE_RUN: crypto.randomUUID(),
        NO_COLOR: '1',
        TMPDIR: tmp,
        VX_E2E_HALT: '1',
      },
      stdout: 'ignore',
      stderr: 'ignore',
    })
    const started = async (): Promise<boolean> => {
      for (const d of await readdir(tmp))
        if (await Bun.file(path.join(tmp, d, '1', 'b', 'halt.started')).exists()) return true
      return false
    }
    for (let i = 0; i < 1200 && !(await started()); i++) await Bun.sleep(50)
    expect(await started()).toBe(true)
    run.kill('SIGINT')
    await run.exited
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
  const again = vx(['run', 'b#halt'], 'halt-2')
  expect([again.exitCode, again.stdout.toString().includes('linux.small#')]).toEqual([0, true])
}, 60_000)

it('a stopped run exits before its installed worktrees are removed', async () => {
  await writeFile(
    path.join(root, '.vx/workspace.mjs'),
    `import { dte, local } from ${JSON.stringify(DTE)}
export default { plugins: [dte({ workers: { linux: { machines: { small: { max: 1, cpu: 1, memory: '1GB' } } } }, adapter: local({ prepare: 'mkdir nm && touch nm/a' }) })] }
`,
  )
  Bun.spawnSync(
    ['git', '-c', 'user.email=t@vx.local', '-c', 'user.name=t', 'commit', '-qam', 'p'],
    {
      cwd: root,
    },
  )
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'vx-dte-stop-'))
  const bin = path.join(tmp, 'bin')
  await mkdir(bin)
  await writeFile(path.join(bin, 'rm'), `#!/bin/sh\nsleep 3\nexec ${Bun.which('rm')} "$@"\n`, {
    mode: 0o755,
  })
  try {
    const { VX_DTE_RUN: _, ...env } = process.env
    const run = Bun.spawn([process.execPath, CORE_BIN, 'run', 'b#slow'], {
      cwd: root,
      env: {
        ...env,
        VX_DTE_RUN: crypto.randomUUID(),
        NO_COLOR: '1',
        TMPDIR: tmp,
        PATH: `${bin}:${env['PATH']}`,
      },
      stdout: 'ignore',
      stderr: 'ignore',
    })
    const started = async (): Promise<boolean> => {
      for (const d of await readdir(tmp)) {
        if (await Bun.file(path.join(tmp, d, '1', 'b', 'started')).exists()) return true
      }
      return false
    }
    for (let i = 0; i < 1200 && !(await started()); i++) await Bun.sleep(50)
    expect(await started()).toBe(true)
    const t0 = performance.now()
    run.kill('SIGINT')
    await run.exited
    const stopMs = performance.now() - t0
    // What is left names itself, so a failure says which part stayed.
    const left = async (): Promise<string[]> => [
      ...(await readdir(tmp)).filter((d) => d.startsWith('vx-dte-')),
      ...Bun.spawnSync(['git', 'worktree', 'list', '--porcelain'], { cwd: root })
        .stdout.toString()
        .split('\n')
        .filter((l) => l.startsWith('worktree '))
        .slice(1),
    ]
    // Still there as vx exits, however it removes them; gone after.
    const atExit = (await left()).length
    for (let i = 0; i < 400 && (await left()).length > 0; i++) await Bun.sleep(50)
    expect({ atExit: atExit > 0, left: await left(), fast: stopMs < 1000 }).toEqual({
      atExit: true,
      left: [],
      fast: true,
    })
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
}, 60_000)

// A worker masked only secret-named values out of the output it uploaded:
// one the task's env.secret names (a GH_PAT) reached the remote whole.
it("masks what a task's env.secret names out of the entry its worker uploads", async () => {
  const away = await mkdtemp(path.join(os.tmpdir(), 'vx-dte-pat-'))
  const store = path.join(away, 'store')
  await mkdir(store)
  await mkdir(path.join(away, 'plugin'))
  await writeFile(path.join(away, 'plugin', 'package.json'), '{"name":"e2e-remote"}')
  const at = (h: string) => `${JSON.stringify(store)} + '/' + ${h}`
  await writeFile(
    path.join(root, '.vx/workspace.mjs'),
    `import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { definePlugin } from ${JSON.stringify(CORE_INDEX)}
import { dte, local } from ${JSON.stringify(DTE)}
export default { plugins: [
  dte({ workers: { linux: { machines: { small: { max: 1, cpu: 1, memory: '1GB' } } } }, adapter: local() }),
  definePlugin({ dir: ${JSON.stringify(path.join(away, 'plugin'))} }, { cache: () => ({
    has: async (h) => (existsSync(${at('h')}) ? {} : null),
    get: async (h) => (existsSync(${at('h')}) ? { body: new Blob([readFileSync(${at('h')})]), durationMs: 1 } : null),
    // First write wins, as a content-addressed store keeps it.
    put: async (h, b) => existsSync(${at('h')}) || writeFileSync(${at('h')}, new Uint8Array(await b.arrayBuffer())),
  }) }),
] }
`,
  )
  Bun.spawnSync(
    ['git', '-c', 'user.email=t@vx.local', '-c', 'user.name=t', 'commit', '-qam', 'p'],
    {
      cwd: root,
    },
  )
  const pat = 'pat-value-the-worker-saw'
  try {
    const r = vx(['run', 'b#pat'], 'pat', { VX_E2E_PAT: pat, CI: 'true' })
    const out = r.stdout.toString() + r.stderr.toString()
    expect([r.exitCode, out.includes('auth=***'), out.includes(pat)]).toEqual([0, true, false])
    const stored: string[] = []
    for (const f of await readdir(store)) {
      const bytes = await Bun.file(path.join(store, f)).bytes()
      try {
        stored.push(new TextDecoder().decode(Bun.zstdDecompressSync(bytes)))
      } catch {
        stored.push(new TextDecoder().decode(bytes))
      }
    }
    expect([
      stored.some((t) => t.includes('auth=***')),
      stored.some((t) => t.includes(pat)),
    ]).toEqual([true, false])
  } finally {
    await rm(away, { recursive: true, force: true })
  }
}, 60_000)

// A task's timeout counts from its start on a worker: core's clock,
// armed as the task was sent, killed a 0.5 s task with a 2 s timeout
// while its worker still booted (2026-10-24).
it('times a task from its start on the worker, not from the wait for one', async () => {
  await writeFile(
    path.join(root, '.vx/workspace.mjs'),
    `import { dte, local } from ${JSON.stringify(DTE)}
export default { plugins: [dte({ workers: { linux: { machines: { small: { max: 1, cpu: 1, memory: '1GB' } } } }, adapter: local({ prepare: 'sleep 3' }) })] }
`,
  )
  Bun.spawnSync(
    ['git', '-c', 'user.email=t@vx.local', '-c', 'user.name=t', 'commit', '-qam', 'p'],
    {
      cwd: root,
    },
  )
  const r = vx(['run', 'b#timed'], 'timed')
  const out = r.stdout.toString() + r.stderr.toString()
  expect([r.exitCode, out.includes('timed-ok'), out.includes('timed out')]).toEqual([
    0,
    true,
    false,
  ])
}, 60_000)

// A worker saved each task under its key whatever the run's policy, so a
// `--no-cache` run left an entry the next run hit (2026-10-24).
it('saves no entry under its key that the run would not', async () => {
  for (const flag of ['--no-cache', '--cache-policy=local:r']) {
    expect(vx(['cache', 'clean']).exitCode).toBe(0)
    await rm(path.join(root, 'a/out'), { recursive: true, force: true })
    const r = vx(['run', 'b#use', flag], 'unsaved')
    expect([flag, r.exitCode]).toEqual([flag, 0])
    expect(await readFile(path.join(root, 'b/out/b.txt'), 'utf8')).toBe('made\n')
    const next = vx(['run', 'a#gen']).stdout.toString()
    expect([flag, next.includes('restored')]).toEqual([flag, false])
  }
}, 60_000)

// A task that exits 0 past its timeout (it traps SIGTERM) failed, but its
// worker saved it under its key, and the next run hit it green (2026-10-24).
it('saves no entry for a task that timed out, even on a 0 exit', async () => {
  for (const run of ['trap-1', 'trap-2']) {
    const r = vx(['run', 'b#trap'], run)
    expect([run, r.exitCode, r.stdout.toString().includes('timed out')]).toEqual([run, 1, true])
  }
}, 60_000)

// A worker cleared every file under a task's output globs before it ran,
// a committed one too, which core never cleans: its dependant on that
// worker found it gone (2026-10-24).
// A task that left a process running was saved under its key on its
// worker, where core saves none, and the next run restored it (2026-10-24).
it('saves no entry for a task that left a process running', async () => {
  for (const run of ['bg-1', 'bg-2']) {
    const r = vx(['run', 'b#bg'], run)
    expect([run, r.exitCode, r.stdout.toString().includes('linux.small#')]).toEqual([run, 0, true])
  }
}, 60_000)

// Outputs through a link out of the project are refused, as core refuses
// them: the worker took the refusal as its own fault, and two such faults
// failed the run (2026-10-24).
it('fails a task whose outputs link out of its project, not its worker', async () => {
  const r = vx(['run', 'b#away', 'a#gen', '--continue'], 'away')
  const out = r.stdout.toString()
  expect(r.exitCode).toBe(1)
  // Its worker's result, not a fault: the line names the worker that ran it.
  expect(out).toMatch(/└─ b#away · linux.small#\d ── \(\d+ms\) failed \(exit 1\)/)
  expect(out).toContain('leaves the project')
  expect(await readFile(path.join(root, 'a/out/a.txt'), 'utf8')).toBe('made\n')
}, 60_000)

it('leaves a tracked file under a task’s outputs in place on its worker', async () => {
  const r = vx(['run', 'g#use'], 'tracked')
  const out = r.stdout.toString()
  expect([r.exitCode, out.includes('tracked'), out.includes('made')]).toEqual([0, true, true])
}, 60_000)

// A remote-only task's files stay off the run's machine (schema: 'only'):
// its worker's install was laid over this machine's own (2026-10-24).
it('leaves a remote-only task’s files on the workers', async () => {
  const r = vx(['run', 'b#far'], 'far')
  expect([r.exitCode, r.stdout.toString().includes('far')]).toEqual([0, true])
  expect(await Bun.file(path.join(root, 'a/out/ro.txt')).exists()).toBe(false)
}, 60_000)

// A remote-only task this machine's store held counted as a hit to restore:
// the run asked no worker for it, and it waited on one forever (2026-11-11).
it('runs a remote-only task on a worker when this machine’s store holds it', () => {
  const { VX_DTE_RUN: _, ...env } = process.env
  const run = () =>
    Bun.spawnSync([process.execPath, CORE_BIN, 'run', 'a#ro'], {
      cwd: root,
      env: { ...env, VX_DTE_RUN: crypto.randomUUID(), NO_COLOR: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 20_000,
    })
  expect(run().exitCode).toBe(0)
  const again = run()
  expect([again.exitCode, again.stdout.toString().includes('far')]).toEqual([0, true])
}, 60_000)

// `--cache-download` holds for a worker's task: under `none` every file of
// the run came home anyway (2026-10-24).
it('brings home only the asked task’s files under --cache-download=toplevel', async () => {
  const r = vx(['run', 'b#use', '--cache-download=toplevel'], 'toplevel')
  expect([r.exitCode, r.stdout.toString().includes('used')]).toEqual([0, true])
  expect(await Bun.file(path.join(root, 'b/out/b.txt')).exists()).toBe(true)
  expect(await Bun.file(path.join(root, 'a/out/a.txt')).exists()).toBe(false)
}, 60_000)
