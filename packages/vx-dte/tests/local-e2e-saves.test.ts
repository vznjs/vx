// A distributed run end to end on `local()`: what a worker saves and brings
// back, and `local()`'s worktrees (local-e2e-fixture.ts).

import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { local } from '../src/index.ts'
import { snapshot } from '../src/tree.ts'
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
  dte({ workers: { small: { max: 1, cpu: 1, memory: '1GB' } }, adapter: local() }),
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

// From the worktree's root, a workspace in a subdirectory of its
// repository had no `.vx/workspace` above: every worker exited
// `unknown command: dte` (2026-10-25).
it('local() starts a worker at the workspace’s place in its repository', async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'vx-dte-sub-'))
  const said = await mkdtemp(path.join(os.tmpdir(), 'vx-dte-pwd-'))
  try {
    const ws = path.join(repo, 'ws')
    await mkdir(ws, { recursive: true })
    await writeFile(path.join(ws, 'package.json'), '{}')
    const git = (...a: string[]) => Bun.spawnSync(['git', ...a], { cwd: repo })
    git('init', '-q')
    git('add', '-A')
    git('-c', 'user.email=t@vx.local', '-c', 'user.name=t', 'commit', '-qm', 'i')
    const a = local({ prepare: `pwd -P > ${JSON.stringify(path.join(said, 'pwd'))}; exit 1` })
    await a.relay!()
    await Promise.resolve(
      a.spawn({
        run: crypto.randomUUID(),
        relay: '',
        size: 'small',
        max: 1,
        cpu: 1,
        memory: 1e9,
        index: 1,
        id: 'small#1',
        workspaceRoot: ws,
        commit: (await snapshot(ws)).commit,
        env: {},
        exited: () => {},
      }),
    ).catch(() => {})
    const list = git('worktree', 'list', '--porcelain')
    const dir = list.stdout
      .toString()
      .match(/^worktree (.+)$/gm)![1]!
      .slice('worktree '.length)
    expect((await readFile(path.join(said, 'pwd'), 'utf8')).trim()).toBe(
      await realpath(path.join(dir, 'ws')),
    )
    await a.close!()
  } finally {
    await rm(repo, { recursive: true, force: true })
    await rm(said, { recursive: true, force: true })
  }
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

// A closed run stopped a prepare's shell alone: an install it started
// (`bun install && …` keeps the shell) kept running, writing into a
// worktree being removed.
it('local() stops a prepare’s whole process tree at close', async () => {
  const said = await mkdtemp(path.join(os.tmpdir(), 'vx-dte-prep-'))
  const began = path.join(said, 'began')
  const late = path.join(said, 'late')
  // Liveness by what it writes, not by pid: a killed child under a pid 1
  // that does not reap still answers `kill -0`.
  try {
    const a = local({
      prepare: `(touch ${JSON.stringify(began)}; sleep 1; touch ${JSON.stringify(late)}) & wait; true`,
    })
    await a.relay!()
    const spawned = Promise.resolve(
      a.spawn({
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
      }),
    ).catch(() => {})
    for (let i = 0; i < 400 && !(await Bun.file(began).exists()); i++) await Bun.sleep(25)
    expect(await Bun.file(began).exists()).toBe(true)
    await a.close!()
    await spawned
    await Bun.sleep(1_500)
    expect(await Bun.file(late).exists()).toBe(false)
  } finally {
    await rm(said, { recursive: true, force: true })
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

// pnpm prints an install's error on stdout: a prepare that said only there
// failed with no reason and no log.
it("says a prepare's reason it printed on stdout", async () => {
  await writeFile(
    path.join(root, '.vx/workspace.mjs'),
    `import { dte, local } from ${JSON.stringify(DTE)}
export default { plugins: [dte({ workers: { small: { max: 1, cpu: 1, memory: '1GB' } }, adapter: local({ prepare: 'echo ERR_PNPM_NO_LOCKFILE none; exit 4' }) })] }
`,
  )
  Bun.spawnSync(
    ['git', '-c', 'user.email=t@vx.local', '-c', 'user.name=t', 'commit', '-qam', 'p'],
    { cwd: root },
  )
  const r = vx(['run', 'a#gen'], 'e2e-stdout')
  const out = r.stdout.toString() + r.stderr.toString()
  const log = out.match(/\(log: ([^)]+)\)/)?.[1]
  if (log !== undefined) await rm(path.dirname(log), { recursive: true, force: true })
  expect(out).toMatch(/small#1  failed  prepare exited 4: ERR_PNPM_NO_LOCKFILE none/)
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
