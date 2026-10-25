// A distributed run end to end on `local()`: the workers are processes in
// their own git worktrees, joined through the adapter's loopback relay.

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { local } from '../src/index.ts'
import { snapshot } from '../src/tree.ts'

const DTE = path.resolve(import.meta.dir, '..', 'src', 'index.ts')
const CORE_BIN = path.resolve(import.meta.dir, '../../vx/src/bin.ts')
// Relative, as this package's test task sets it: each worker's worktree
// must still share the run's store.
process.env['VX_CACHE_DIR'] = '.vx/cache'
let root = ''

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-dte-e2e-'))
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'ws', private: true }),
    '.gitignore': 'out\n.vx/cache\n',
    '.vx/workspace.mjs': `import { dte, local } from ${JSON.stringify(DTE)}
export default { plugins: [dte({ workers: { small: { max: 2, cpu: 1, memory: '1GB' } }, adapter: local() })] }
`,
    'a/vx.config.mjs': `export default { name: 'a', tasks: { gen: {
  exec: { command: 'mkdir -p out && echo made > out/a.txt' },
  inputs: { files: ['vx.config.mjs'] },
  cache: { outputs: { files: ['out/**'] } },
}, ro: {
  exec: { command: 'mkdir -p out && echo far > out/ro.txt', remote: 'only' },
  inputs: { files: ['vx.config.mjs'] },
  cache: { outputs: { files: ['out/ro.txt'] } },
} } }
`,
    // The marker lives outside every worktree, so the worker that runs the
    // task again sees the first one started it: in its own worktree it
    // slept the 60 s out (80 s of this file's 111 s).
    'b/vx.config.mjs': `const once = ${JSON.stringify(path.join(root, 'once'))}
export default { name: 'b', tasks: {
  use: {
    dependsOn: ['a#gen'],
    exec: { command: 'mkdir -p out && cat ../a/out/a.txt > out/b.txt && pwd > out/where.txt && echo used' },
    inputs: { files: ['vx.config.mjs'] },
    cache: { outputs: { files: ['out/**'] } },
  },
  fail: { exec: { command: 'echo oops >&2; exit 3' } },
  trap: {
    exec: { command: "trap 'exit 0' TERM; echo > t.txt; sleep 10 & wait", timeout: '1s' },
    inputs: { files: ['vx.config.mjs'] },
    cache: { outputs: { files: ['t.txt'] } },
  },
  far: { dependsOn: ['a#ro'], exec: { command: 'cat ../a/out/ro.txt' } },
  away: {
    exec: { command: 'rm -f away && ln -s / away' },
    inputs: { files: ['vx.config.mjs'] },
    cache: { outputs: { files: ['away/**'] } },
  },
  bg: {
    exec: { command: 'echo a > bg.txt && (sleep 1; echo late > late.txt) &' },
    inputs: { files: ['vx.config.mjs'] },
    cache: { outputs: { files: ['bg.txt', 'late.txt'] } },
  },
  timed: { exec: { command: 'sleep 0.5 && echo timed-ok', timeout: '2s' } },
  halt: {
    exec: {
      command: "trap 'exit 0' TERM; echo > h.txt; if [ x$VX_E2E_HALT = x1 ]; then touch halt.started; sleep 30 & wait; fi",
      env: { passThrough: ['VX_E2E_HALT'] },
    },
    inputs: { files: ['vx.config.mjs'] },
    cache: { outputs: { files: ['h.txt'] } },
  },
  slow: { exec: { command: 'touch started && sleep 60' } },
  once: { exec: { command: 'if [ -e ' + once + ' ]; then echo again; else touch ' + once + ' && sleep 60; fi' } },
  env: { exec: {
    command: 'echo "shown=\${VX_E2E_SHOWN:-none} hidden=\${VX_E2E_HIDDEN:-none}"',
    env: { passThrough: ['VX_E2E_SHOWN'] },
  } },
} }
`,
    // A server its tests need where they run: each start says where.
    's/vx.config.mjs': `const log = ${JSON.stringify(path.join(root, 'servers.log'))}
const t = (n) => ({ dependsOn: ['srv'], exec: { command: 'test -e up && echo saw' + n } })
// Two shards long enough to run at once, so on two machines.
const shard = (n) => ({ dependsOn: ['srv'], exec: { command: 'test -e up && sleep 3 && echo shard' + n } })
export default { name: 's', tasks: {
  srv: { exec: { command: 'echo "$PWD" >> ' + log + ' && touch up && echo up && exec sleep 60', persistent: { readyWhen: 'up' } } },
  t1: t(1), t2: t(2), t3: t(3), shard1: shard(1), shard2: shard(2),
} }
`,
    // Keys that fold a runtime probe: one every machine answers alike, one
    // the worker's worktree answers otherwise.
    'r/vx.config.mjs': `const log = ${JSON.stringify(path.join(root, 'probed.log'))}
const t = (probe) => ({
  exec: { command: 'echo "$PWD" >> ' + log },
  inputs: { files: ['vx.config.mjs'], runtime: [probe] },
  cache: { outputs: { files: [] } },
})
export default { name: 'r', tasks: { same: t('echo 1.4.2'), here: t('pwd') } }
`,
    // Tasks core pins to the machine that runs \`vx run\`, each saying where it ran.
    'p/vx.config.mjs': `const log = ${JSON.stringify(path.join(root, 'pinned.log'))}
const at = (name) => 'echo "' + name + ' $PWD" >> ' + log
export default { name: 'p', tasks: {
  here: { exec: { command: at('here'), remote: false } },
  above: { dependsOn: ['here'], exec: { command: at('above') } },
  tty: { exec: { command: at('tty'), interactive: true } },
  srv: { exec: { command: at('srv') + ' && touch up && echo up && exec sleep 60', remote: false, persistent: { readyWhen: 'up' } } },
  near: { dependsOn: ['srv'], exec: { command: at('near') } },
} }
`,
    // A committed file under a task's output glob: never its output.
    'g/gen/keep.txt': 'tracked\n',
    'g/vx.config.mjs': `export default { name: 'g', tasks: {
  gen: { exec: { command: 'echo made > gen/out.txt' }, inputs: { files: ['vx.config.mjs'] }, cache: { outputs: { files: ['gen/**'] } } },
  use: { dependsOn: ['gen'], exec: { command: 'cat gen/keep.txt gen/out.txt' } },
} }
`,
    // A task that rewrites its own input, as a formatter does.
    'f/in.txt': '1\n',
    'f/vx.config.mjs': `export default { name: 'f', tasks: {
  fmt: { exec: { command: 'echo x >> in.txt && mkdir -p out && cp in.txt out/f.txt' }, inputs: { files: ['in.txt'] }, cache: { outputs: { files: ['out/**'] } } },
} }
`,
    // Wide, then a two-task lull, then wide again.
    'c/vx.config.mjs': `const t = (dependsOn) => ({ exec: { command: 'sleep 0.3' }, dependsOn })
export default { name: 'c', tasks: {
  x1: t([]), x2: t([]), y1: t(['x1', 'x2']), y2: t(['y1']), z1: t(['y2']), z2: t(['y2']),
} }
`,
  }
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true })
    await writeFile(path.join(root, rel), text)
  }
  const git = (...a: string[]) => Bun.spawnSync(['git', ...a], { cwd: root })
  git('init', '-q')
  expect(vx(['lock']).exitCode).toBe(0)
  git('add', '-A')
  git('-c', 'user.email=t@vx.local', '-c', 'user.name=t', 'commit', '-q', '-m', 'i')
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** `vx`, a distributed run when `run` names one; its id is a fresh UUID. */
function vx(args: string[], run?: string, extra: Record<string, string> = {}) {
  const { VX_DTE_RUN: _, ...env } = process.env
  return Bun.spawnSync([process.execPath, CORE_BIN, ...args], {
    cwd: root,
    env: {
      ...env,
      ...(run === undefined ? {} : { VX_DTE_RUN: crypto.randomUUID() }),
      NO_COLOR: '1',
      ...extra,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
}

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
  // Nothing to run: no worker starts.
  expect(second.stdout.toString()).not.toMatch(/^ {2}workers /m)
}, 60_000)

// `--force` reads no hit, but a worker's entry is the run's own work: it
// came back unreadable and every task failed.
// The run in time (owner, 2026-10-23): --profile holds the workers' lanes.
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

// Nothing runs on the orchestrator (owner, 2026-10-22): each worker that
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
// run: it starts on both, never once for both (owner, 2026-10-24).
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
// restore there (owner, 2026-10-24): not a task that says
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

// Nothing runs on the orchestrator (owner, 2026-10-22), a task that keys
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

it('fails a task on a worker whose runtime probe answers otherwise', () => {
  const r = vx(['run', 'r#here'], 'e2e-probe')
  const out = r.stdout.toString() + r.stderr.toString()
  expect([r.exitCode, out]).toEqual([1, expect.stringContaining('`pwd` answers')])
}, 60_000)

it('fails a task that fails on its worker, with its output', () => {
  const r = vx(['run', 'b#fail'], 'e2e')
  expect(r.exitCode).not.toBe(0)
  expect(r.stdout.toString() + r.stderr.toString()).toContain('oops')
}, 60_000)

it('runs on a worker started by hand, with no adapter, under one name on both sides', async () => {
  const { serveRelay } = await import('@vzn/vx-dte-relay')
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

// A CI step that started a worker before the run began (github()'s
// adopt): the run counts it against its size's max and starts no other.
it('runs on a worker the adapter adopted, and starts none of its own', async () => {
  const { serveRelay } = await import('@vzn/vx-dte-relay')
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
  const { serveRelay } = await import('@vzn/vx-dte-relay')
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

/**
 * A worker started as CI starts one, after its run's orchestrator: one
 * that finds no live run yet leaves at once, and is started again.
 */
async function workerOf(
  start: () => Bun.Subprocess<'ignore', 'pipe', 'pipe'>,
  run: Bun.Subprocess,
): Promise<{ exited: number; out: string }> {
  let over = false
  void run.exited.then(() => (over = true))
  for (;;) {
    const w = start()
    const [out, exited] = await Promise.all([new Response(w.stdout).text(), w.exited])
    if (out !== '' || over) return { exited, out }
    await Bun.sleep(100)
  }
}

/**
 * The pids under `pid`, by `pgrep -P`: macOS's `ps` is setuid, which the
 * sandbox will not spawn (EPERM on M's Mac, 2026-10-21).
 */
function descendants(pid: number): number[] {
  const kids = (p: number): number[] =>
    Bun.spawnSync(['pgrep', '-P', String(p)])
      .stdout.toString()
      .split('\n')
      .filter(Boolean)
      .map(Number)
  const out: number[] = []
  for (let i = -1; i < out.length; i++) out.push(...kids(i < 0 ? pid : out[i]!))
  return out
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

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

// M, 2026-10-21: "After I kill it, long delay". Removing a worktree an
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
  expect([again.exitCode, again.stdout.toString().includes('small#')]).toEqual([0, true])
}, 60_000)

it('a stopped run exits before its installed worktrees are removed', async () => {
  await writeFile(
    path.join(root, '.vx/workspace.mjs'),
    `import { dte, local } from ${JSON.stringify(DTE)}
export default { plugins: [dte({ workers: { small: { max: 1, cpu: 1, memory: '1GB' } }, adapter: local({ prepare: 'mkdir nm && touch nm/a' }) })] }
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

// A task's timeout counts from its start on a worker: core's clock,
// armed as the task was sent, killed a 0.5 s task with a 2 s timeout
// while its worker still booted (2026-10-24).
it('times a task from its start on the worker, not from the wait for one', async () => {
  await writeFile(
    path.join(root, '.vx/workspace.mjs'),
    `import { dte, local } from ${JSON.stringify(DTE)}
export default { plugins: [dte({ workers: { small: { max: 1, cpu: 1, memory: '1GB' } }, adapter: local({ prepare: 'sleep 3' }) })] }
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
    expect([run, r.exitCode, r.stdout.toString().includes('small#')]).toEqual([run, 0, true])
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
  expect(out).toMatch(/└─ b#away · small#\d ── \(\d+ms\) failed \(exit 1\)/)
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

// `--cache-download` holds for a worker's task: under `none` every file of
// the run came home anyway (2026-10-24).
it('brings home only the asked task’s files under --cache-download=toplevel', async () => {
  const r = vx(['run', 'b#use', '--cache-download=toplevel'], 'toplevel')
  expect([r.exitCode, r.stdout.toString().includes('used')]).toEqual([0, true])
  expect(await Bun.file(path.join(root, 'b/out/b.txt')).exists()).toBe(true)
  expect(await Bun.file(path.join(root, 'a/out/a.txt')).exists()).toBe(false)
}, 60_000)

// A worker cleared every file under a task's output globs, its upstream's
// too: an additive task (outputs over its upstream's tree) found the files
// it builds on gone (2026-10-24).
it('leaves an upstream’s files in place for an additive task on its worker', async () => {
  const ws = path.join(root, '.vx/workspace.mjs')
  await writeFile(
    ws,
    (await readFile(ws, 'utf8')).replace(
      'export default {',
      'export default { run: { rules: { exclusiveOutputs: false } },',
    ),
  )
  await mkdir(path.join(root, 'ad'))
  await writeFile(
    path.join(root, 'ad/vx.config.mjs'),
    `const outputs = { files: ['dist/**'] }
export default { name: 'ad', tasks: {
  up: { exec: { command: 'mkdir -p dist && echo up > dist/a.txt' }, inputs: { files: ['vx.config.mjs'] }, cache: { outputs } },
  dep: { dependsOn: ['up'], exec: { command: 'mkdir -p dist/ind && cp dist/a.txt dist/ind/b.txt' }, inputs: { files: ['vx.config.mjs'] }, cache: { outputs } },
} }
`,
  )
  await writeFile(path.join(root, 'ad/.gitignore'), 'dist\n')
  expect(vx(['lock']).exitCode).toBe(0)
  const git = (...a: string[]) =>
    Bun.spawnSync(['git', '-c', 'user.email=t@vx.local', '-c', 'user.name=t', ...a], { cwd: root })
  git('add', '-A')
  git('commit', '-qm', 'ad')
  const r = vx(['run', 'ad#dep'], 'additive')
  expect([r.exitCode, r.stdout.toString() + r.stderr.toString()]).toEqual([0, expect.any(String)])
  expect(await readFile(path.join(root, 'ad/dist/ind/b.txt'), 'utf8')).toBe('up\n')
}, 60_000)

// A worker saved an additive task's upstream files in its entry: a hit
// whose key did not fold the upstream's replayed its old bytes over the
// new ones (2026-10-24). `none` keeps this machine's save from replacing
// the worker's entry.
it('saves only the files an additive task wrote on its worker', async () => {
  const ws = path.join(root, '.vx/workspace.mjs')
  await writeFile(
    ws,
    (await readFile(ws, 'utf8')).replace(
      'export default {',
      'export default { run: { rules: { exclusiveOutputs: false } },',
    ),
  )
  await mkdir(path.join(root, 'ad'))
  await writeFile(path.join(root, 'ad/v.txt'), '1\n')
  await writeFile(
    path.join(root, 'ad/vx.config.mjs'),
    `const outputs = { files: ['dist/**'] }
export default { name: 'ad', tasks: {
  up: { exec: { command: 'mkdir -p dist && cp v.txt dist/a.txt' }, inputs: { files: ['v.txt'] }, cache: { outputs } },
  add: { dependsOn: ['up'], exec: { command: 'echo b > dist/b.txt' }, inputs: { files: ['vx.config.mjs'], tasks: [] }, cache: { outputs } },
} }
`,
  )
  await writeFile(path.join(root, 'ad/.gitignore'), 'dist\n')
  expect(vx(['lock']).exitCode).toBe(0)
  const git = (...a: string[]) =>
    Bun.spawnSync(['git', '-c', 'user.email=t@vx.local', '-c', 'user.name=t', ...a], { cwd: root })
  git('add', '-A')
  git('commit', '-qm', 'ad')
  const first = vx(['run', 'ad#add', '--cache-download=none'], 'add-1')
  expect([first.exitCode, first.stdout.toString() + first.stderr.toString()]).toEqual([
    0,
    expect.any(String),
  ])
  await writeFile(path.join(root, 'ad/v.txt'), '2\n')
  git('commit', '-qam', 'v2')
  const again = vx(['run', 'ad#add'], 'add-2')
  expect([again.exitCode, await readFile(path.join(root, 'ad/dist/a.txt'), 'utf8')]).toEqual([
    0,
    '2\n',
  ])
}, 60_000)

// An additive task that removed an upstream's file was saved under its
// key: a hit left the file it removes in place. Core saves none (2026-10-24).
it('saves no entry for an additive task that removed an upstream’s file', async () => {
  const ws = path.join(root, '.vx/workspace.mjs')
  await writeFile(
    ws,
    (await readFile(ws, 'utf8')).replace(
      'export default {',
      'export default { run: { rules: { exclusiveOutputs: false } },',
    ),
  )
  await mkdir(path.join(root, 'ad'))
  await writeFile(
    path.join(root, 'ad/vx.config.mjs'),
    `const outputs = { files: ['dist/**'] }
export default { name: 'ad', tasks: {
  up: { exec: { command: 'mkdir -p dist && echo up > dist/a.txt' }, inputs: { files: ['vx.config.mjs'] }, cache: { outputs } },
  prune: { dependsOn: ['up'], exec: { command: 'rm dist/a.txt && echo b > dist/b.txt' }, inputs: { files: ['vx.config.mjs'] }, cache: { outputs } },
} }
`,
  )
  await writeFile(path.join(root, 'ad/.gitignore'), 'dist\n')
  expect(vx(['lock']).exitCode).toBe(0)
  const git = (...a: string[]) =>
    Bun.spawnSync(['git', '-c', 'user.email=t@vx.local', '-c', 'user.name=t', ...a], { cwd: root })
  git('add', '-A')
  git('commit', '-qm', 'ad')
  const first = vx(['run', 'ad#prune'], 'prune-1')
  expect([first.exitCode, first.stdout.toString() + first.stderr.toString()]).toEqual([
    0,
    expect.any(String),
  ])
  await rm(path.join(root, 'ad/dist'), { recursive: true, force: true })
  const again = vx(['run', 'ad#prune'], 'prune-2')
  expect([again.exitCode, await Bun.file(path.join(root, 'ad/dist/a.txt')).exists()]).toEqual([
    0,
    false,
  ])
}, 60_000)

// A worker saved a task that rewrote its own input under its key: this
// machine never saw the rewrite, and the next run hit it (2026-10-24).
it('saves no entry under its key for a task that changed its input on its worker', async () => {
  const first = vx(['run', 'f#fmt'], 'fmt-1')
  expect([first.exitCode, first.stdout.toString() + first.stderr.toString()]).toEqual([
    0,
    expect.stringContaining('`f/in.txt` changed after its key was taken'),
  ])
  const again = vx(['run', 'f#fmt'], 'fmt-2')
  expect([again.exitCode, again.stdout.toString().includes('small#')]).toEqual([0, true])
}, 60_000)

// local() took a snapshot of its own at its first worker, after a hit had
// restored a committed file: another tree, and every worker was refused
// (2026-10-25).
it('local() checks out the run’s commit, not the tree as it is at its first worker', async () => {
  const { commit } = await snapshot(root)
  await writeFile(path.join(root, 'package.json'), '{"name":"changed"}')
  const a = local()
  await a.relay!()
  await a.spawn({
    run: crypto.randomUUID(),
    relay: '',
    size: 'small',
    max: 1,
    cpu: 1,
    memory: 1e9,
    index: 1,
    id: 'small#1',
    workspaceRoot: root,
    commit,
    env: {},
    exited: () => {},
  })
  const list = Bun.spawnSync(['git', 'worktree', 'list', '--porcelain'], { cwd: root })
  const dir = list.stdout
    .toString()
    .match(/^worktree (.+)$/gm)![1]!
    .slice('worktree '.length)
  expect(await readFile(path.join(dir, 'package.json'), 'utf8')).toBe(
    JSON.stringify({ name: 'ws', private: true }),
  )
  await a.close!()
}, 60_000)

// `vx watch` runs again in one process: a `local()` the last run closed
// started no worker, and the run's tasks were aborted (2026-10-24).
it('local() starts workers again after a run closed it', async () => {
  const a = local()
  await a.relay!()
  await a.close!()
  await a.relay!()
  await a.spawn({
    run: crypto.randomUUID(),
    relay: '',
    size: 'small',
    max: 1,
    cpu: 1,
    memory: 1e9,
    index: 1,
    id: 'small#1',
    workspaceRoot: root,
    commit: (await snapshot(root)).commit,
    env: {},
    exited: () => {},
  })
  const trees = Bun.spawnSync(['git', 'worktree', 'list', '--porcelain'], { cwd: root })
  expect(trees.stdout.toString().match(/^worktree /gm)?.length).toBe(2)
  await a.close!()
}, 60_000)

it('says why a worker never joined, and fails the run when none can', async () => {
  await writeFile(
    path.join(root, '.vx/workspace.mjs'),
    `import { dte, local } from ${JSON.stringify(DTE)}
export default { plugins: [dte({ workers: { small: { max: 1, cpu: 1, memory: '1GB' } }, adapter: local({ prepare: 'echo no bun here >&2; exit 4' }) })] }
`,
  )
  Bun.spawnSync(
    ['git', '-c', 'user.email=t@vx.local', '-c', 'user.name=t', 'commit', '-qam', 'p'],
    {
      cwd: root,
    },
  )
  const r = vx(['run', 'a#gen'], 'e2e-none')
  const out = r.stdout.toString() + r.stderr.toString()
  expect(r.exitCode).not.toBe(0)
  expect(out).toMatch(/small#1  failed  prepare exited 4: no bun here/)
  expect(out).toContain('no worker could start')
  const log = out.match(/\(log: ([^)]+)\)/)?.[1]
  expect(log === undefined ? '' : await readFile(log, 'utf8')).toBe('no bun here\n')
  if (log !== undefined) await rm(path.dirname(log), { recursive: true, force: true })
}, 60_000)

it('workers run the tracked files as they are, uncommitted changes too', async () => {
  // Committed without dte(), as a user trying it first: a worktree of HEAD
  // alone had no `dte` verb, so every worker exited.
  const ws = path.join(root, '.vx/workspace.mjs')
  const withDte = await readFile(ws, 'utf8')
  await writeFile(ws, 'export default { plugins: [] }\n')
  const git = (...a: string[]) =>
    Bun.spawnSync(['git', '-c', 'user.email=t@vx.local', '-c', 'user.name=t', ...a], { cwd: root })
  git('commit', '-qam', 'no dte')
  await writeFile(ws, withDte)
  const r = vx(['run', 'a#gen'], 'e2e-dirty')
  const out = r.stdout.toString() + r.stderr.toString()
  expect([r.exitCode, out]).toEqual([0, expect.stringContaining(' · small#')])
  // Nothing was committed or reset to get there.
  expect(git('status', '--porcelain').stdout.toString()).toContain(' M .vx/workspace.mjs\n')
}, 60_000)
