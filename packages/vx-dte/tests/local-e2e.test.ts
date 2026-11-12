// A distributed run end to end on `local()`: placement, outputs, timings,
// a killed worker and servers (local-e2e-fixture.ts).

import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { Cache, localHistory } from '@vzn/vx'
import { CORE_BIN, root, setup, teardown, vx } from './local-e2e-fixture.ts'

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
    ctx.on('onMeasure', (m) => ${line('measure: m.id, def: m.def, ms: m.durationMs')})
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
  // The workers' warm-up is timed as a task (2026-11-11): heard before the
  // run's end, where a history plugin sends it, and kept in history.
  const worker = '@vzn/vx-dte#worker:linux.small'
  const warmUps = rows.filter((r) => r['measure'] === worker)
  expect(warmUps.length).toBeGreaterThan(0)
  expect(rows.findIndex((r) => r['measure'] === worker)).toBeLessThan(
    rows.findIndex((r) => r['flush'] === true),
  )
  const cache = new Cache(path.join(root, '.vx/cache'))
  try {
    const def = String(warmUps.at(-1)!['def'])
    const kept = localHistory(cache, { defs: new Map([[worker, def]]) }).measuresFor([worker])
    expect(kept.get(worker)?.durationMs).toBe(Math.round(Number(warmUps.at(-1)!['ms'])))
  } finally {
    cache.close()
  }
  const tasks = rows.filter((r) => r['id'] !== undefined)
  expect(
    tasks
      .map((r) => r['id'])
      .map(String)
      .toSorted((a, b) => a.localeCompare(b)),
  ).toEqual(['m#m1', 'm#m2', 'm#m3'])
  for (const r of tasks) {
    expect(r['status']).toBe('success')
    expect(r['where']).toMatch(/^linux.small#\d+$/)
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
  expect(names.map((e) => e.args?.name)).toEqual(['run', 'orchestrator', 'linux.small#1'])
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
  expect([r.exitCode, out]).toEqual([0, expect.stringContaining('linux.small#2')])
  expect(out).not.toContain('linux.small#3')
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

// A server stops once no task left uses it, on the worker that started it,
// not when that worker leaves.
it('stops a server on its worker once its last user finishes', () => {
  const r = vx(['run', 's#after'], 'e2e-unserve')
  const out = r.stdout.toString() + r.stderr.toString()
  // A line of its own: the command's frame header names both words.
  expect([r.exitCode, out.match(/^server-(gone|alive)$/m)?.[0]]).toEqual([0, 'server-gone'])
}, 60_000)

// A server's CPU is no task's own: what a dependant makes it do is charged
// to that dependant, so history books it (2026-11-07); its idle base is
// booked once per worker instead.
it('charges a server’s CPU to the dependant it served', () => {
  expect(vx(['run', 's#calm'], 'e2e-hot').exitCode).toBe(0)
  const r = vx([
    'last',
    '--sql',
    "SELECT cpu_ms FROM runs WHERE task = 'calm' ORDER BY id DESC LIMIT 1",
  ])
  const cpu = Number(/\d+/.exec(r.stdout.toString())?.[0])
  // 4 s of a server burning a core for it, sampled each second while its
  // fit learns: about 3 s (its own CPU is ~0).
  expect(cpu).toBeGreaterThan(1500)
}, 60_000)

// No task ever runs on the orchestrator under dte(), only cache hits
// restore there (2026-10-24): not a task that says
// \`exec.remote: false\`, its dependant, an interactive one, or a server.
