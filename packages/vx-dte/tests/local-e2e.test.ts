// A distributed run end to end on `local()`: the workers are processes in
// their own git worktrees, joined through the adapter's loopback relay.

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'

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
export default { name: 's', tasks: {
  srv: { exec: { command: 'echo "$PWD" >> ' + log + ' && touch up && echo up && exec sleep 60', persistent: { readyWhen: 'up' } } },
  t1: t(1), t2: t(2), t3: t(3),
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
  // Saved here as the run's own: the next run is all hits.
  const second = vx(['run', 'b#use'], 'e2e-2')
  expect(second.exitCode).toBe(0)
  expect(second.stdout.toString()).toContain('local 2✓')
  // Nothing to run: no worker starts.
  expect(second.stdout.toString()).not.toMatch(/^ {2}workers /m)
}, 60_000)

// `--force` reads no hit, but a worker's entry is the run's own work: it
// came back unreadable and every task failed.
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
    const worker = Bun.spawn([process.execPath, CORE_BIN, 'dte', 'worker'], {
      cwd: root,
      env: { ...env, VX_DTE_RUN: hand, VX_DTE_SECRET: 'hand-secret', NO_COLOR: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    // Async: the relay is served by this process.
    const run = Bun.spawn([process.execPath, CORE_BIN, 'run', 'b#use'], {
      cwd: root,
      env: { ...env, VX_DTE_RUN: hand, VX_DTE_SECRET: 'hand-secret', NO_COLOR: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const out = await new Response(run.stdout).text()
    expect([await run.exited, out]).toEqual([
      0,
      expect.stringMatching(/└─ b#use · worker#1 ── .*success/),
    ])
    expect(out).toMatch(/workers +worker#1  stopped  1 done\n +actual \d+c\/[\d.]+G$/m)
    const own = await new Response(worker.stdout).text()
    expect(await worker.exited).toBe(0)
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
    const worker = Bun.spawn([process.execPath, CORE_BIN, 'dte', 'worker'], {
      cwd: root,
      env: { ...shared, VX_DTE_WORKER: 'small#3' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const run = Bun.spawn([process.execPath, CORE_BIN, 'run', 'b#use'], {
      cwd: root,
      env: shared,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const out = await new Response(run.stdout).text()
    expect([await run.exited, out]).toEqual([
      0,
      expect.stringMatching(/└─ b#use · small#3 ── .*success/),
    ])
    expect(await worker.exited).toBe(0)
    expect(await Bun.file(spawns).exists()).toBe(false)
  } finally {
    await relay.stop()
  }
}, 60_000)

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
