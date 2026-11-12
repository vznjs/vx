// A distributed run end to end on `local()`: where tasks may run, workers
// started by hand or adopted, runtime probes, retries and a stopped run
// (local-e2e-fixture.ts).

import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import {
  alive,
  CORE_BIN,
  descendants,
  DTE,
  root,
  setup,
  teardown,
  vx,
  workerOf,
} from './local-e2e-fixture.ts'

beforeEach(setup)
afterEach(teardown)

it('runs no task on the orchestrator, pinned ones included', async () => {
  const r = vx(['run', 'p#above', 'p#tty', 'p#near'], 'e2e-pinned')
  expect([r.exitCode, r.stderr.toString()]).toEqual([0, expect.any(String)])
  const ran = (await readFile(path.join(root, 'pinned.log'), 'utf8')).trim().split('\n')
  expect(ran.map((l) => l.split(' ')[0]!).sort((x, y) => x.localeCompare(y))).toEqual([
    'above',
    'here',
    'near',
    'srv',
    'tty',
  ])
  for (const l of ran) expect(l).not.toEndWith(` ${path.join(root, 'p')}`)
}, 60_000)

// Nothing runs on the orchestrator (2026-10-22), a task that keys
// on `bun --version` included: its worker answers the probe, and one that
// answers otherwise than this machine fails it, as its key holds this
// machine's answer (C-2).
it('runs a task whose key folds a runtime probe on a worker that answers it alike', async () => {
  const r = vx(['run', 'r#same'], 'e2e-probe')
  expect(r.exitCode).toBe(0)
  const ran = (await readFile(path.join(root, 'probed.log'), 'utf8')).trim().split('\n')
  expect(ran).toHaveLength(1)
  expect(ran[0]).not.toBe(path.join(root, 'r'))
}, 60_000)

// 2026-10-25: a path under the worker's root failed the task, though it
// names the same file there as the key's answer does here.
it('runs a task whose runtime probe answers a path under the checkout root', () => {
  const r = vx(['run', 'r#root'], 'e2e-probe')
  expect([r.exitCode, r.stdout.toString() + r.stderr.toString()]).toEqual([0, expect.anything()])
}, 60_000)

it('fails a task on a worker whose runtime probe answers otherwise', () => {
  const r = vx(['run', 'r#here'], 'e2e-probe')
  const out = r.stdout.toString() + r.stderr.toString()
  expect([r.exitCode, out]).toEqual([
    1,
    expect.stringContaining('`git rev-parse --git-dir` answers'),
  ])
}, 60_000)

it('fails a task that fails on its worker, with its output', () => {
  const r = vx(['run', 'b#fail'], 'e2e')
  expect(r.exitCode).not.toBe(0)
  expect(r.stdout.toString() + r.stderr.toString()).toContain('oops')
}, 60_000)

it('runs on a worker started by hand, with no adapter, under one name on both sides', async () => {
  const { serveRelay } = await import('@vzn/vx-dte-server')
  const relay = serveRelay({ port: 0, hostname: '127.0.0.1' })
  const url = relay.url
  try {
    await writeFile(
      path.join(root, '.vx/workspace.mjs'),
      `import { dte } from ${JSON.stringify(DTE)}
export default { plugins: [dte({ relay: ${JSON.stringify(url)} })] }
`,
    )
    Bun.spawnSync(
      ['git', '-c', 'user.email=t@vx.local', '-c', 'user.name=t', 'commit', '-qam', 'r'],
      {
        cwd: root,
      },
    )
    expect(vx(['run', 'a#gen']).exitCode).toBe(0)
    const { VX_DTE_RUN: _, ...env } = process.env
    const hand = crypto.randomUUID()
    // Async: the relay is served by this process.
    const run = Bun.spawn([process.execPath, CORE_BIN, 'run', 'b#use'], {
      cwd: root,
      env: { ...env, VX_DTE_RUN: hand, VX_DTE_SECRET: 'hand-secret', NO_COLOR: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const worker = workerOf(
      () =>
        Bun.spawn([process.execPath, CORE_BIN, 'dte', 'worker'], {
          cwd: root,
          env: { ...env, VX_DTE_RUN: hand, VX_DTE_SECRET: 'hand-secret', NO_COLOR: '1' },
          stdout: 'pipe',
          stderr: 'pipe',
        }),
      run,
    )
    const out = await new Response(run.stdout).text()
    expect([await run.exited, out]).toEqual([
      0,
      expect.stringMatching(/└─ b#use · worker#1 ── .*success/),
    ])
    expect(out).toMatch(/workers +worker#1  stopped  1 done · b#use\n +actual \d+c\/[\d.]+G$/m)
    const { exited, out: own } = await worker
    expect(exited).toBe(0)
    expect(own).toMatch(/worker +worker#1/)
    expect(own).toContain('✓ b#use')
  } finally {
    await relay.stop()
  }
}, 60_000)

it('says what gives a job with no token a way onto a relay that wants one', async () => {
  const { serveRelay } = await import('@vzn/vx-dte-server')
  const relay = serveRelay({
    port: 0,
    hostname: '127.0.0.1',
    verify: () => Promise.reject(new Error('no token is good')),
  })
  const aud = String(relay.url).replace(/\/+$/, '')
  try {
    await writeFile(
      path.join(root, '.vx/workspace.mjs'),
      `import { dte } from ${JSON.stringify(DTE)}
export default { plugins: [dte({ relay: ${JSON.stringify(aud)} })] }
`,
    )
    const {
      VX_DTE_RUN: _,
      VX_DTE_TOKEN: __,
      ACTIONS_ID_TOKEN_REQUEST_URL: ___,
      ...env
    } = process.env
    const hint = `401 no bearer token: this job has no token for the relay (on GitLab, an id_tokens entry VX_DTE_TOKEN with aud ${aud}; on GitHub Actions, permissions: id-token: write)`
    // The run, then a worker: each dials the relay with no token.
    for (const args of [
      ['run', 'b#use'],
      ['dte', 'worker'],
    ]) {
      const p = Bun.spawn([process.execPath, CORE_BIN, ...args], {
        cwd: root,
        env: { ...env, VX_DTE_RUN: crypto.randomUUID(), VX_DTE_SECRET: 's', NO_COLOR: '1' },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const err = await new Response(p.stderr).text()
      expect([args, await p.exited, err]).toEqual([args, 1, expect.stringContaining(hint)])
    }
  } finally {
    await relay.stop()
  }
}, 60_000)

// A worker started by hand before its run exited and said nothing, and
// the run then waited on no worker (the README started the worker first,
// 2026-10-25). It still exits 0: a CI job late for a run that ended is no
// failure.
it('a worker started by hand with no live run says so', async () => {
  const { serveRelay } = await import('@vzn/vx-dte-server')
  const relay = serveRelay({ port: 0, hostname: '127.0.0.1' })
  try {
    await writeFile(
      path.join(root, '.vx/workspace.mjs'),
      `import { dte } from ${JSON.stringify(DTE)}
export default { plugins: [dte({ relay: ${JSON.stringify(relay.url)} })] }
`,
    )
    const { VX_DTE_RUN: _, VX_DTE_WORKER: __, ...env } = process.env
    const run = crypto.randomUUID()
    const worker = Bun.spawn([process.execPath, CORE_BIN, 'dte', 'worker'], {
      cwd: root,
      env: { ...env, VX_DTE_RUN: run, VX_DTE_SECRET: 'early-secret', NO_COLOR: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [exited, err] = await Promise.all([worker.exited, new Response(worker.stderr).text()])
    expect([exited, err]).toEqual([
      0,
      expect.stringContaining(
        `the relay has no live run ${run}: it ended, or has not started (start the run first, then its workers)`,
      ),
    ])
  } finally {
    await relay.stop()
  }
}, 30_000)

// A CI step that started a worker before the run began (github()'s
// adopt): the run counts it against its size's max and starts no other.
it('runs on a worker the adapter adopted, and starts none of its own', async () => {
  const { serveRelay } = await import('@vzn/vx-dte-server')
  const relay = serveRelay({ port: 0, hostname: '127.0.0.1' })
  const url = relay.url
  const spawns = path.join(root, 'spawns.log')
  try {
    await writeFile(
      path.join(root, '.vx/workspace.mjs'),
      `import { appendFileSync } from 'node:fs'
import { dte } from ${JSON.stringify(DTE)}
const adapter = {
  adopt(worker) { worker('linux.small#3', 'linux.small') },
  spawn(a) { appendFileSync(${JSON.stringify(spawns)}, a.id + '\\n') },
}
export default { plugins: [dte({ relay: ${JSON.stringify(url)}, workers: { linux: { machines: { small: { max: 1, cpu: 1, memory: '1GB' } } } }, adapter })] }
`,
    )
    Bun.spawnSync(
      ['git', '-c', 'user.email=t@vx.local', '-c', 'user.name=t', 'commit', '-qam', 'r'],
      { cwd: root },
    )
    expect(vx(['run', 'a#gen']).exitCode).toBe(0)
    const { VX_DTE_RUN: _, ...env } = process.env
    const id = crypto.randomUUID()
    const shared = { ...env, VX_DTE_RUN: id, VX_DTE_SECRET: 'adopt-secret', NO_COLOR: '1' }
    const run = Bun.spawn([process.execPath, CORE_BIN, 'run', 'b#use'], {
      cwd: root,
      env: shared,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const worker = workerOf(
      () =>
        Bun.spawn([process.execPath, CORE_BIN, 'dte', 'worker'], {
          cwd: root,
          env: { ...shared, VX_DTE_WORKER: 'linux.small#3' },
          stdout: 'pipe',
          stderr: 'pipe',
        }),
      run,
    )
    const out = await new Response(run.stdout).text()
    expect([await run.exited, out]).toEqual([
      0,
      expect.stringMatching(/└─ b#use · linux.small#3 ── .*success/),
    ])
    expect((await worker).exited).toBe(0)
    expect(await Bun.file(spawns).exists()).toBe(false)
  } finally {
    await relay.stop()
  }
}, 60_000)

// ci.yml's mac and arm sizes name no platform and join a run on Linux: a
// size that names none takes whatever worker joins it.
it('runs on a worker of another platform when its size names none', async () => {
  const { serveRelay } = await import('@vzn/vx-dte-server')
  const relay = serveRelay({ port: 0, hostname: '127.0.0.1' })
  const url = relay.url
  try {
    await writeFile(
      path.join(root, '.vx/workspace.mjs'),
      `import { dte } from ${JSON.stringify(DTE)}
const adapter = { adopt(worker) { worker('linux.mac#1', 'linux.mac') }, spawn() {} }
export default { plugins: [dte({ relay: ${JSON.stringify(url)}, workers: { linux: { machines: { mac: { max: 1, cpu: 1, memory: '1GB' } } } }, adapter })] }
`,
    )
    // The worker says it runs elsewhere: its own `process.platform`.
    const other = process.platform === 'darwin' ? 'linux' : 'darwin'
    const preload = path.join(root, '.vx/other-platform.mjs')
    await writeFile(
      preload,
      `Object.defineProperty(process, 'platform', { value: ${JSON.stringify(other)} })\n`,
    )
    Bun.spawnSync(
      ['git', '-c', 'user.email=t@vx.local', '-c', 'user.name=t', 'commit', '-qam', 'r'],
      { cwd: root },
    )
    expect(vx(['run', 'a#gen']).exitCode).toBe(0)
    const { VX_DTE_RUN: _, ...env } = process.env
    const shared = {
      ...env,
      VX_DTE_RUN: crypto.randomUUID(),
      VX_DTE_SECRET: 'other-secret',
      NO_COLOR: '1',
    }
    const run = Bun.spawn([process.execPath, CORE_BIN, 'run', 'b#use'], {
      cwd: root,
      env: shared,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const worker = workerOf(
      () =>
        Bun.spawn([process.execPath, '--preload', preload, CORE_BIN, 'dte', 'worker'], {
          cwd: root,
          env: { ...shared, VX_DTE_WORKER: 'linux.mac#1' },
          stdout: 'pipe',
          stderr: 'pipe',
        }),
      run,
    )
    const out = await new Response(run.stdout).text()
    expect([await run.exited, out]).toEqual([
      0,
      expect.stringMatching(/└─ b#use · linux.mac#1 ── .*success/),
    ])
    expect((await worker).exited).toBe(0)
  } finally {
    await relay.stop()
  }
}, 60_000)

it.each(['SIGHUP', 'SIGINT'] as const)(
  'a %s to the run stops its workers and removes their worktrees',
  async (sig) => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'vx-dte-sig-'))
    try {
      const { VX_DTE_RUN: _, ...env } = process.env
      const run = Bun.spawn([process.execPath, CORE_BIN, 'run', 'b#slow'], {
        cwd: root,
        env: { ...env, VX_DTE_RUN: crypto.randomUUID(), NO_COLOR: '1', TMPDIR: tmp },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      // The worker's worktree is `<tmp>/vx-dte-*/1`; the task touches `started` in it.
      const started = async (): Promise<boolean> => {
        for (const d of await readdir(tmp)) {
          if (await Bun.file(path.join(tmp, d, '1', 'b', 'started')).exists()) return true
        }
        return false
      }
      for (let i = 0; i < 600 && !(await started()); i++) await Bun.sleep(50)
      expect(await started()).toBe(true)
      const tree = descendants(run.pid)
      expect(tree.length).toBeGreaterThan(0)
      run.kill(sig)
      expect(await run.exited).not.toBe(0)
      for (let i = 0; i < 100 && tree.some(alive); i++) await Bun.sleep(50)
      expect(tree.filter(alive)).toEqual([])
      // Removed after vx exits (`local()`'s close leaves it to a detached shell).
      const left = async (): Promise<string[]> =>
        (await readdir(tmp)).filter((d) => d.startsWith('vx-dte-'))
      for (let i = 0; i < 200 && (await left()).length > 0; i++) await Bun.sleep(50)
      expect(await left()).toEqual([])
      // A `git worktree list` racing the detached removal can print nothing
      // and fail (CI, PR #4867): that answer is "not settled", not zero trees.
      const trees = (): number | null => {
        const p = Bun.spawnSync(['git', 'worktree', 'list', '--porcelain'], { cwd: root })
        return p.exitCode === 0 ? (p.stdout.toString().match(/^worktree /gm)?.length ?? 0) : null
      }
      for (let i = 0; i < 100 && trees() !== 1; i++) await Bun.sleep(50)
      expect(trees()).toBe(1)
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  },
  60_000,
)

// Nx's rule (2026-11-06): a retry runs on another agent, so neither the
// worker nor what ran beside it is the flake. One worker left runs it there.
it('runs a retry on another worker than the attempt that failed', async () => {
  const run = vx(['run', 'b#flake', 'b#beside'], 'e2e-flake')
  const out = run.stdout.toString() + run.stderr.toString()
  expect([run.exitCode, out]).toEqual([0, expect.stringContaining('b#flake')])
  const where = (await readFile(path.join(root, 'flake.log'), 'utf8')).trim().split('\n')
  expect(where.length).toBe(2)
  expect(where[0]).not.toBe(where[1])
}, 60_000)
