// A distributed run end to end on `local()`: placement, servers, probes,
// workers started by hand or adopted, and a stopped run (local-e2e-fixture.ts).

import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
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

it('runs a task on a worker with its dependency’s outputs, and brings its outputs back', async () => {
  // a#gen runs here, so its outputs must travel to the worker that runs b#use.
  expect(vx(['run', 'a#gen']).exitCode).toBe(0)
  const first = vx(['run', 'b#use'], 'e2e-1')
  const out = first.stdout.toString() + first.stderr.toString()
  expect([first.exitCode, out]).toEqual([0, expect.stringContaining('used')])
  expect(await readFile(path.join(root, 'b/out/b.txt'), 'utf8')).toBe('made\n')
  const where = (await readFile(path.join(root, 'b/out/where.txt'), 'utf8')).trim()
  expect(where).not.toBe(path.join(root, 'b'))
  expect(where.endsWith(`${path.sep}b`)).toBe(true)
  // No --profile, no file.
  expect(await Bun.file(path.join(root, 'profile.json')).exists()).toBe(false)
  // Saved here as the run's own: the next run is all hits.
  const second = vx(['run', 'b#use'], 'e2e-2')
  expect(second.exitCode).toBe(0)
  expect(second.stdout.toString()).toContain('local 2✓')
  // Nothing to run: no worker starts, and the footer says so, not this
  // machine's pool as `N workers`.
  expect(second.stdout.toString()).toMatch(/^ {2}workers +none started: no task needed one$/m)
  expect(second.stdout.toString()).not.toMatch(/\d+ workers? ·/)
}, 60_000)

// Two uncached generators ran on two workers, and their dependant, on
// one, found the other's file missing (#4407): it now runs where both
// lie, one made again beside the other (2026-10-25).
it('a task reads the files of uncached tasks that ran on other workers', async () => {
  const run = vx(['run', 'k#both'], 'e2e-kept')
  const out = run.stdout.toString() + run.stderr.toString()
  expect([run.exitCode, out]).toEqual([0, expect.stringContaining('one\ntwo\n')])
}, 60_000)

// Timings are the orchestrator's to report: each task's, as its worker
// measured it, reaches the plugins there once, and a worker hands none to
// its own (2026-10-25). A history plugin uploads them once, at the end.
it('only the orchestrator reports timings: every task a worker ran, once, as the worker measured it', async () => {
  const log = path.join(root, 'timings.log')
  const dir = path.join(root, 'timings')
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'timings' }))
  const ws = path.join(root, '.vx/workspace.mjs')
  const text = await readFile(ws, 'utf8')
  const line = (body: string) =>
    `appendFileSync(${JSON.stringify(log)}, JSON.stringify({ cwd: process.cwd(), ${body} }) + '\\n')`
  await writeFile(
    ws,
    `import { appendFileSync } from 'node:fs'
import { definePlugin } from ${JSON.stringify(path.resolve(import.meta.dir, '../../vx/src/index.ts'))}
const timings = definePlugin({ dir: ${JSON.stringify(dir)} }, {
  setup(ctx) {
    ctx.on('onTaskComplete', (n, o) => ${line('id: n.id, status: o.status, durationMs: o.durationMs, cpuMs: o.cpuMs, rss: o.peakRssBytes, where: o.where')})
  },
  teardown() { ${line('flush: true')} },
})
` + text.replace('plugins: [', 'plugins: [timings, '),
  )
  const git = (...a: string[]) => Bun.spawnSync(['git', ...a], { cwd: root })
  git('add', '-A')
  git('-c', 'user.email=t@vx.local', '-c', 'user.name=t', 'commit', '-qm', 'timings')
  const run = vx(['run', 'm#m3'], 'e2e-timings')
  expect([run.exitCode, run.stderr.toString()]).toEqual([0, expect.any(String)])
  const rows = (await readFile(log, 'utf8'))
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as Record<string, unknown>)
  const real = await realpath(root)
  expect(rows.every((r) => r['cwd'] === real || r['cwd'] === root)).toBe(true)
  expect(rows.filter((r) => r['flush'] === true)).toHaveLength(1)
  const tasks = rows.filter((r) => r['id'] !== undefined)
  expect(
    tasks
      .map((r) => r['id'])
      .map(String)
      .toSorted((a, b) => a.localeCompare(b)),
  ).toEqual(['m#m1', 'm#m2', 'm#m3'])
  for (const r of tasks) {
    expect(r['status']).toBe('success')
    expect(r['where']).toMatch(/^small#\d+$/)
    expect(r['durationMs'] as number).toBeGreaterThanOrEqual(250)
    expect(typeof r['cpuMs']).toBe('number')
    expect(typeof r['rss']).toBe('number')
  }
}, 60_000)

// 2026-10-25: a `cache.dir` the workspace names, relative, named each
// worktree's own store, and every task failed: the run read no entry.
it('saves where the run reads under a relative cache.dir', async () => {
  const ws = path.join(root, '.vx/workspace.mjs')
  const text = await readFile(ws, 'utf8')
  await writeFile(
    ws,
    text.replace('export default { ', "export default { cache: { dir: '.vx/store' }, "),
  )
  await writeFile(path.join(root, '.gitignore'), 'out\n.vx/cache\n.vx/store\n')
  const git = (...a: string[]) => Bun.spawnSync(['git', ...a], { cwd: root })
  git('-c', 'user.email=t@vx.local', '-c', 'user.name=t', 'commit', '-qam', 'store')
  const run = vx(['run', 'a#gen'], 'e2e-store', { VX_CACHE_DIR: '' })
  const out = run.stdout.toString() + run.stderr.toString()
  expect([run.exitCode, out]).toEqual([0, expect.stringContaining('local 1↑')])
  expect(await readFile(path.join(root, 'a/out/a.txt'), 'utf8')).toBe('made\n')
}, 60_000)

it('saves where the run reads under --cache-dir', async () => {
  const run = vx(['run', 'a#gen', '--cache-dir', '.vx/elsewhere'], 'e2e-flag', { VX_CACHE_DIR: '' })
  const out = run.stdout.toString() + run.stderr.toString()
  expect([run.exitCode, out]).toEqual([0, expect.stringContaining('local 1↑')])
}, 60_000)

// `--force` reads no hit, but a worker's entry is the run's own work: it
// came back unreadable and every task failed.
// The run in time (2026-10-23): --profile holds the workers' lanes.
it('profiles a distributed run’s workers with --profile', async () => {
  const r = vx(['run', 'b#use', '--profile=out.json'], 'e2e-profile')
  expect(r.exitCode).toBe(0)
  const ev = (
    JSON.parse(await readFile(path.join(root, 'out.json'), 'utf8')) as {
      traceEvents: { ph: string; name: string; cat?: string; args?: { name?: string } }[]
    }
  ).traceEvents
  const names = ev.filter((e) => e.ph === 'M' && e.name === 'process_name')
  expect(names.map((e) => e.args?.name)).toEqual(['run', 'orchestrator', 'small#1'])
  expect(ev.some((e) => e.ph === 'X' && e.cat === 'task' && e.name === 'b#use')).toBe(true)
  expect(ev.some((e) => e.ph === 'X' && e.name === 'warm-up')).toBe(true)
}, 60_000)

it('brings a worker’s outputs back under --force', async () => {
  const run = vx(['run', 'b#use', '--force'], 'e2e-force')
  const out = run.stdout.toString() + run.stderr.toString()
  expect([run.exitCode, out]).toEqual([0, expect.stringContaining('used')])
  expect(await readFile(path.join(root, 'b/out/b.txt'), 'utf8')).toBe('made\n')
}, 60_000)

// An idle worker stays while the rest of the run will need it again: one
// left in the lull and another started for the wide part after it.
it('keeps an idle worker the rest of the run needs again', () => {
  const r = vx(['run', 'c#z1', 'c#z2'], 'e2e-lull')
  const out = r.stdout.toString() + r.stderr.toString()
  expect([r.exitCode, out]).toEqual([0, expect.stringContaining('small#2')])
  expect(out).not.toContain('small#3')
}, 60_000)

// The footer prints after teardown: its ideal lost the graph there, and a
// chain whose longest path was 7 s read `ideal 3.2s`.
it('the footer’s ideal waits for each task’s dependencies', () => {
  const r = vx(['run', 'c#z1', 'c#z2'], 'e2e-ideal')
  expect(r.exitCode).toBe(0)
  const ideal = /^ +ideal +([\d.]+)s:/m.exec(r.stdout.toString())?.[1]
  // x1 → y1 → y2 → z1: four `sleep 0.3` one after another.
  expect(Number(ideal)).toBeGreaterThanOrEqual(1.2)
}, 60_000)

// The worker running a task is killed: the task runs again on one the run
// starts in its place, where it once waited for it forever.
it('runs a task again on a new worker when its worker is killed', async () => {
  const { VX_DTE_RUN: _, ...env } = process.env
  const run = Bun.spawn([process.execPath, CORE_BIN, 'run', 'b#once'], {
    cwd: root,
    env: { ...env, VX_DTE_RUN: crypto.randomUUID(), NO_COLOR: '1' },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const marker = (): Promise<boolean> => Bun.file(path.join(root, 'once')).exists()
  for (let i = 0; i < 200 && !(await marker()); i++) await Bun.sleep(100)
  const workers = Bun.spawnSync(['pgrep', '-P', String(run.pid), '-f', 'dte worker'])
  const pids = workers.stdout.toString().trim().split('\n').filter(Boolean)
  expect(pids).toHaveLength(1)
  process.kill(Number(pids[0]), 'SIGKILL')
  const out = (await new Response(run.stdout).text()) + (await new Response(run.stderr).text())
  expect([await run.exited, out]).toEqual([0, expect.stringContaining('again')])
}, 90_000)

// The orchestrator sends each task its own resolved env, and a worker adds
// only its host names and PATH: a name the task does not pass through
// reaches it from neither machine's env.
it('gives a task on a worker only the env it passes through', () => {
  const r = vx(['run', 'b#env'], 'e2e-env', { VX_E2E_SHOWN: 'yes', VX_E2E_HIDDEN: 'leak' })
  const out = r.stdout.toString() + r.stderr.toString()
  expect([r.exitCode, out]).toEqual([0, expect.stringContaining('shown=yes hidden=none')])
  expect(out).toMatch(/^ {2}workers /m)
}, 60_000)

// Nothing runs on the orchestrator (2026-10-22): each worker that
// runs a server's dependant starts the server itself, once, beside it.
it('starts a task’s server on the worker that runs it, once per worker, never here', async () => {
  const r = vx(['run', 's#t1', 's#t2', 's#t3'], 'e2e-srv')
  const out = r.stdout.toString() + r.stderr.toString()
  expect([r.exitCode, out]).toEqual([0, expect.stringContaining('saw3')])
  const starts = (await readFile(path.join(root, 'servers.log'), 'utf8')).trim().split('\n')
  expect(starts).not.toContain(path.join(root, 's'))
  expect(new Set(starts).size).toBe(starts.length)
}, 60_000)

// Two shards of one suite on two machines each need the server where they
// run: it starts on both, never once for both (2026-10-24).
it('starts a server on each machine its shards run on', async () => {
  const r = vx(['run', 's#shard1', 's#shard2'], 'e2e-shards')
  const out = r.stdout.toString() + r.stderr.toString()
  expect([r.exitCode, out]).toEqual([0, expect.stringContaining('shard2')])
  const starts = (await readFile(path.join(root, 'servers.log'), 'utf8')).trim().split('\n')
  expect(starts).toHaveLength(2)
  expect(new Set(starts).size).toBe(2)
  expect(starts).not.toContain(path.join(root, 's'))
}, 60_000)

// No task ever runs on the orchestrator under dte(), only cache hits
// restore there (2026-10-24): not a task that says
// \`exec.remote: false\`, its dependant, an interactive one, or a server.
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
  adopt(worker) { worker('small#3', 'small') },
  spawn(a) { appendFileSync(${JSON.stringify(spawns)}, a.id + '\\n') },
}
export default { plugins: [dte({ relay: ${JSON.stringify(url)}, workers: { small: { max: 1, cpu: 1, memory: '1GB' } }, adapter })] }
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
          env: { ...shared, VX_DTE_WORKER: 'small#3' },
          stdout: 'pipe',
          stderr: 'pipe',
        }),
      run,
    )
    const out = await new Response(run.stdout).text()
    expect([await run.exited, out]).toEqual([
      0,
      expect.stringMatching(/└─ b#use · small#3 ── .*success/),
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
const adapter = { adopt(worker) { worker('mac#1', 'mac') }, spawn() {} }
export default { plugins: [dte({ relay: ${JSON.stringify(url)}, workers: { mac: { max: 1, cpu: 1, memory: '1GB' } }, adapter })] }
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
          env: { ...shared, VX_DTE_WORKER: 'mac#1' },
          stdout: 'pipe',
          stderr: 'pipe',
        }),
      run,
    )
    const out = await new Response(run.stdout).text()
    expect([await run.exited, out]).toEqual([
      0,
      expect.stringMatching(/└─ b#use · mac#1 ── .*success/),
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
      const trees = () => Bun.spawnSync(['git', 'worktree', 'list', '--porcelain'], { cwd: root })
      for (
        let i = 0;
        i < 100 &&
        trees()
          .stdout.toString()
          .match(/^worktree /gm)!.length > 1;
        i++
      )
        await Bun.sleep(50)
      expect(
        trees()
          .stdout.toString()
          .match(/^worktree /gm),
      ).toHaveLength(1)
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  },
  60_000,
)
