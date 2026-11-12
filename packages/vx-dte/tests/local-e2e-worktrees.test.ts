// A distributed run end to end on `local()`: the worktrees it checks out,
// starts workers in and stops, and what a worker runs from them
// (local-e2e-fixture.ts).

import { mkdir, mkdtemp, readFile, realpath, rm, writeFile, readdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { local } from '../src/index.ts'
import { snapshot } from '../src/tree.ts'
import { DTE, root, setup, teardown, vx } from './local-e2e-fixture.ts'

beforeEach(setup)
afterEach(teardown)

async function commitProject(
  dir: string,
  config: string,
  files: Record<string, string> = {},
): Promise<void> {
  for (const [rel, text] of Object.entries({
    'vx.config.mjs': config,
    '.gitignore': 'dist\ngen\n',
    ...files,
  })) {
    await mkdir(path.dirname(path.join(root, dir, rel)), { recursive: true })
    await writeFile(path.join(root, dir, rel), text)
  }
  expect(vx(['lock']).exitCode).toBe(0)
  commit()
}

const commit = (): void => {
  Bun.spawnSync(['git', 'add', '-A'], { cwd: root })
  Bun.spawnSync(['git', '-c', 'user.email=t@vx.local', '-c', 'user.name=t', 'commit', '-qm', 'c'], {
    cwd: root,
  })
}

// A restore lays files and removes none: an uncached task's `rm -rf dist`
// on its worker left this machine's old file beside its new one, where a
// local run leaves only the new (2026-11-10).
it('leaves an uncached task’s outputs as its worker left them, an old one gone', async () => {
  await commitProject(
    'sh',
    `export default { name: 'sh', tasks: { build: {
  exec: { command: 'rm -rf dist; mkdir -p dist && cp src/* dist/' },
  inputs: { files: ['src/**'] },
  outputs: { files: ['dist/**'] },
} } }
`,
    { 'src/one.txt': '1\n' },
  )
  const first = vx(['run', 'sh#build'], 'shrink-1')
  expect([first.exitCode, await readdir(path.join(root, 'sh/dist'))]).toEqual([0, ['one.txt']])
  Bun.spawnSync(['git', 'mv', 'sh/src/one.txt', 'sh/src/two.txt'], { cwd: root })
  commit()
  const again = vx(['run', 'sh#build'], 'shrink-2')
  expect([again.exitCode, await readdir(path.join(root, 'sh/dist'))]).toEqual([0, ['two.txt']])
}, 60_000)

// A committed file under a task's outputs it deleted on its worker stayed
// here: a local run leaves it gone (2026-11-10).
it('removes a committed file under its outputs the task deleted on its worker', async () => {
  await commitProject(
    'td',
    `export default { name: 'td', tasks: { build: {
  exec: { command: 'rm -rf out && mkdir -p out && echo new > out/new.txt' },
  outputs: { files: ['out/**'] },
} } }
`,
    { 'out/old.txt': 'old\n' },
  )
  const run = vx(['run', 'td#build'], 'tdel')
  expect([run.exitCode, await readdir(path.join(root, 'td/out'))]).toEqual([0, ['new.txt']])
}, 60_000)

// A key reading an uncached dependency's output was refused as a file the
// commit lacks: the dependency runs on its worker first (2026-11-10).
it('runs a task whose key reads an uncached dependency’s output', async () => {
  await commitProject(
    'ud',
    `export default { name: 'ud', tasks: {
  gen: { exec: { command: 'mkdir -p gen && echo g > gen/g.txt' }, inputs: { files: ['src/**'] }, outputs: { files: ['gen/**'] } },
  build: { dependsOn: ['gen'], exec: { command: 'mkdir -p dist && cp gen/g.txt dist/' }, inputs: { files: ['src/**', 'gen/**'], tasks: [] }, outputs: { files: ['dist/**'] }, cache: true },
} }
`,
    { 'src/s.txt': 's\n' },
  )
  const run = vx(['run', 'ud#build'], 'udo')
  expect([run.exitCode, run.stdout.toString() + run.stderr.toString()]).toEqual([
    0,
    expect.any(String),
  ])
  expect(await readFile(path.join(root, 'ud/dist/g.txt'), 'utf8')).toBe('g\n')
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
  expect([again.exitCode, again.stdout.toString().includes('linux.small#')]).toEqual([0, true])
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
    id: 'linux.small#1',
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
        id: 'linux.small#1',
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
    id: 'linux.small#1',
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
        id: 'linux.small#1',
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
export default { plugins: [dte({ workers: { linux: { machines: { small: { max: 1, cpu: 1, memory: '1GB' } } } }, adapter: local({ prepare: 'echo no bun here >&2; exit 4' }) })] }
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
  expect(out).toMatch(/linux.small#1  failed  prepare exited 4: no bun here/)
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
export default { plugins: [dte({ workers: { linux: { machines: { small: { max: 1, cpu: 1, memory: '1GB' } } } }, adapter: local({ prepare: 'echo ERR_PNPM_NO_LOCKFILE none; exit 4' }) })] }
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
  expect(out).toMatch(/linux.small#1  failed  prepare exited 4: ERR_PNPM_NO_LOCKFILE none/)
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
  expect([r.exitCode, out]).toEqual([0, expect.stringContaining(' · linux.small#')])
  // Nothing was committed or reset to get there.
  expect(git('status', '--porcelain').stdout.toString()).toContain(' M .vx/workspace.mjs\n')
}, 60_000)

// A `.gitattributes` committed after the file: this disk kept LF, which
// the key read, the worker's worktree checked it out CRLF, and the CRLF
// copy was saved under that key, a stale hit for the next run (2026-11-08).
it('runs a task on the bytes its key read, not those a git filter checks out', async () => {
  const git = (...a: string[]) =>
    Bun.spawnSync(['git', '-c', 'user.email=t@vx.local', '-c', 'user.name=t', ...a], { cwd: root })
  await writeFile(path.join(root, '.gitattributes'), 'e/src/*.txt text eol=crlf\n')
  git('add', '.gitattributes')
  git('commit', '-qm', 'crlf')
  const r = vx(['run', 'e#copy'], 'e2e-eol')
  const out = r.stdout.toString() + r.stderr.toString()
  expect([r.exitCode, out]).toEqual([0, expect.stringContaining(' · linux.small#')])
  expect(await readFile(path.join(root, 'e/out/t.txt'), 'utf8')).toBe('a\nb\n')
  // Checked out CRLF here too: the commit holds LF, so no worker has the bytes the key reads.
  await rm(path.join(root, 'e/src/t.txt'))
  git('checkout', 'e/src/t.txt')
  const crlf = vx(['run', 'e#copy'], 'e2e-crlf')
  expect([crlf.exitCode, crlf.stdout.toString() + crlf.stderr.toString()]).toEqual([
    1,
    expect.stringContaining(
      'e#copy keys e/src/t.txt, which is on disk other than the commit workers check out holds it',
    ),
  ])
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
  up: { exec: { command: 'mkdir -p dist && echo up > dist/a.txt' }, inputs: { files: ['vx.config.mjs'] }, outputs, cache: true },
  dep: { dependsOn: ['up'], exec: { command: 'mkdir -p dist/ind && cp dist/a.txt dist/ind/b.txt' }, inputs: { files: ['vx.config.mjs'] }, outputs, cache: true },
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
  up: { exec: { command: 'mkdir -p dist && cp v.txt dist/a.txt' }, inputs: { files: ['v.txt'] }, outputs, cache: true },
  add: { dependsOn: ['up'], exec: { command: 'echo b > dist/b.txt' }, inputs: { files: ['vx.config.mjs'], tasks: [] }, outputs, cache: true },
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
  up: { exec: { command: 'mkdir -p dist && echo up > dist/a.txt' }, inputs: { files: ['vx.config.mjs'] }, outputs, cache: true },
  prune: { dependsOn: ['up'], exec: { command: 'rm dist/a.txt && echo b > dist/b.txt' }, inputs: { files: ['vx.config.mjs'] }, outputs, cache: true },
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

/** Project `dir` of `config`, its other `files` and a `.gitignore` of `dist`, committed. */
