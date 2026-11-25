// The starters under examples/ are what a README tells a new user to copy,
// so they must run: each is copied to a fresh git repo, the @vzn packages
// it imports linked to this checkout, and `vx run` driven through a cold
// run, a warm one and a change. examples/ lives outside packages/vx, which a
// sandboxed shard cannot read — hence the unsafe suite.
import {
  cpSync,
  existsSync,
  readdirSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { lastStatus } from './helpers/last-run.js'

const CORE = path.resolve(import.meta.dir, '..')
const PACKAGES = path.dirname(CORE)
const EXAMPLES = path.resolve(PACKAGES, '..', 'examples')
const BIN = path.join(CORE, 'src', 'bin.ts')
const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

/**
 * A fresh git repo holding `examples/<name>`, with `links` (package dirs)
 * and `vx-lockfile` as its @vzn deps and the workspace's links in the
 * `bun.lock` the README's `bun install` writes, which `bun()` reads its
 * edges from, and the README's `vx lock` after it.
 */
function fixture(name: string, links: string[]): string {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), `vx-example-${name}-`)))
  roots.push(root)
  cpSync(path.join(EXAMPLES, name), root, { recursive: true })
  mkdirSync(path.join(root, 'node_modules', '@vzn'), { recursive: true })
  for (const dir of [...links, 'vx-lockfile']) {
    symlinkSync(path.join(PACKAGES, dir), path.join(root, 'node_modules', '@vzn', dir))
  }
  // As an install links them: app reaches lib by its name, never by `../`.
  for (const member of readdirSync(path.join(root, 'packages'))) {
    const { name } = JSON.parse(
      readFileSync(path.join(root, 'packages', member, 'package.json'), 'utf8'),
    ) as { name: string }
    symlinkSync(path.join('..', 'packages', member), path.join(root, 'node_modules', name))
  }
  writeFileSync(path.join(root, 'bun.lock'), JSON.stringify(bunWorkspaceLock(root), null, 2))
  const shipped = lockFiles(root)
  const lock = Bun.spawnSync([process.execPath, BIN, 'lock'], { cwd: root, stderr: 'pipe' })
  if (lock.exitCode !== 0) throw new Error(`vx lock: ${lock.stderr.toString()}`)
  if (shipped.length > 0) committedLocks.set(name, { root, files: shipped })
  commit(root)
  return root
}

/** The lock files and review copies `root` holds, root-relative. */
function lockFiles(root: string): string[] {
  // Bun.Glob's braces miss a dot directory, so two globs.
  return ['.vx/*.lock', '**/vx.lock.json']
    .flatMap((g) => [...new Bun.Glob(g).scanSync({ cwd: root, dot: true })])
    .filter((f) => !f.includes('node_modules'))
    .sort()
}

/** Each starter that commits its locks: the fixture they were copied into. */
const committedLocks = new Map<string, { root: string; files: string[] }>()

/** The workspace half of the bun.lock Bun writes for `root`'s `packages/*` members. */
function bunWorkspaceLock(root: string): unknown {
  const pkg = (rel: string) =>
    JSON.parse(readFileSync(path.join(root, rel, 'package.json'), 'utf8')) as {
      name: string
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
  const entry = ({ name, dependencies, devDependencies }: ReturnType<typeof pkg>) => ({
    name,
    ...(dependencies === undefined ? {} : { dependencies }),
    ...(devDependencies === undefined ? {} : { devDependencies }),
  })
  const workspaces: Record<string, unknown> = { '': entry(pkg('.')) }
  const packages: Record<string, unknown> = {}
  const members = path.join(root, 'packages')
  for (const dir of readdirSync(members).sort()) {
    if (!existsSync(path.join(members, dir, 'package.json'))) continue
    const m = pkg(`packages/${dir}`)
    workspaces[`packages/${dir}`] = entry(m)
    packages[m.name] = [`${m.name}@workspace:packages/${dir}`]
  }
  return { lockfileVersion: 1, workspaces, packages }
}

function commit(root: string): void {
  for (const args of [
    ['init', '-q'],
    ['add', '-A'],
    ['commit', '-qm', 'step'],
  ]) {
    const r = Bun.spawnSync({
      cmd: ['git', '-c', 'user.email=t@t', '-c', 'user.name=t', ...args],
      cwd: root,
      stdout: 'ignore',
      stderr: 'pipe',
    })
    if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`)
  }
}

/** One `vx run <task> --all`: its exit, each task's status from `vx last`,
 *  and the summary's cache legend (`local 3↑`). */
function run(
  root: string,
  task: string,
): { exit: number; status: Record<string, string>; cache: string } {
  const r = Bun.spawnSync({
    cmd: [process.execPath, BIN, 'run', task, '--all'],
    cwd: root,
    env: { ...process.env, CI: 'true' },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const lines = r.stdout.toString().split('\n')
  const cache = lines[lines.findIndex((l) => l.startsWith('  cache ')) + 1]?.trim() ?? ''
  return {
    exit: r.exitCode,
    status: lastStatus(root),
    cache,
  }
}

describe('examples/basic', () => {
  const root = fixture('basic', ['vx'])

  it('builds cold, replays warm, and re-runs what an edit reaches', () => {
    // `ci` is a group: it runs nothing, so the summary has no row for it.
    const tasks = ['app#build', 'app#test', 'lib#build']
    const cold = run(root, 'ci')
    expect(cold.exit).toBe(0)
    expect(Object.keys(cold.status).sort()).toEqual(tasks)
    expect(cold.status['lib#build']).toBe('success')
    const warm = run(root, 'ci')
    expect(warm.exit).toBe(0)
    expect(warm.status['lib#build']).toBe('cache-hit')
    expect(warm.status['app#test']).toBe('cache-hit')
    writeFileSync(
      path.join(root, 'packages/lib/src/greet.js'),
      'export const greet = (n) => `hi, ${n}`\n',
    )
    const edited = run(root, 'ci')
    expect(edited.exit).toBe(0)
    expect([
      edited.status['lib#build'],
      edited.status['app#build'],
      edited.status['app#test'],
    ]).toEqual(['success', 'success', 'success'])
  })
})

// The migrate guide's check (`init --keep`): turbo() maps the Turbo repo until
// `vx-migrate` writes native configs. Those hold only what each task
// declares, without the Turbo env turbo() keys, so each task runs once more.
describe('examples/turbo', () => {
  const root = fixture('turbo', ['vx', 'vx-migrate'])
  const all = (status: string) => ({
    'app#build': status,
    'app#test': status,
    'lib#build': status,
  })

  it('builds through the turbo() bridge, cold then warm', () => {
    const cold = run(root, 'test')
    expect(cold.exit).toBe(0)
    expect(cold.status).toEqual(all('success'))
    const warm = run(root, 'test')
    expect(warm.exit).toBe(0)
    expect(warm.status).toEqual(all('cache-hit'))
  })

  // The migrate guide's steps as written: the workspace file stays (the
  // CLI never overwrites one), then turbo() goes and the configs stand alone.
  it('migrates to written configs that run once, then stand alone', () => {
    const workspace = readFileSync(path.join(root, '.vx/workspace.ts'), 'utf8')
    const migrate = Bun.spawnSync({
      cmd: [process.execPath, path.join(PACKAGES, 'vx-migrate', 'src', 'bin.ts')],
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(migrate.exitCode).toBe(0)
    const out = migrate.stdout.toString()
    const lines = out.split('\n')
    expect(lines.find((l) => l.startsWith('  tasks '))?.replace(/\s+/g, ' ')).toBe(' tasks 3 clean')
    const files = lines.findIndex((l) => l.startsWith('  files '))
    expect(lines.slice(files, files + 2)).toEqual([
      '  files     packages/app/vx.config.ts',
      '            packages/lib/vx.config.ts',
    ])
    expect(readFileSync(path.join(root, '.vx/workspace.ts'), 'utf8')).toBe(workspace)
    commit(root)
    const kept = run(root, 'test')
    expect(kept.exit).toBe(0)
    expect(kept.status).toEqual(all('success'))

    // The file stays: it marks the root, and bun() keeps the edges.
    mkdirSync(path.join(root, '.vx'), { recursive: true })
    writeFileSync(
      path.join(root, '.vx/workspace.ts'),
      "import { bun } from '@vzn/vx-lockfile'\n\nexport default { plugins: [bun()] }\n",
    )
    commit(root)
    const alone = run(root, 'test')
    expect(alone.exit).toBe(0)
    expect(alone.status).toEqual(all('cache-hit'))
  })
})

// The CI guide's workflow, step by step, as GitHub would run it: a push to
// main and a pull request, each with the env the runner sets. No remote is
// configured: the local cache never knows a scope
// (2026-10-17), so one disk is one pool for every ref.
describe('examples/ci', () => {
  const root = fixture('ci', ['vx', 'vx-ci'])
  const workflow = readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8')
  const event = path.join(path.dirname(root), `${path.basename(root)}-event.json`)
  writeFileSync(event, JSON.stringify({ repository: { default_branch: 'main' } }))
  roots.push(event)

  /** A vx line as the job runs it: CI set, the GitHub env of `ref`, nothing of this runner's. */
  function step(ref: string, args: string[]): { exit: number; status: Record<string, string> } {
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env))
      if (v !== undefined && (k === 'VX_CACHE_DIR' || !/^(GITHUB_|VX_|RUNNER_)/.test(k))) env[k] = v
    Object.assign(env, {
      CI: 'true',
      GITHUB_ACTIONS: 'true',
      GITHUB_REF: ref,
      GITHUB_REF_NAME: ref.split('/').slice(2).join('/'),
      GITHUB_EVENT_PATH: event,
    })
    const r = Bun.spawnSync({
      cmd: [process.execPath, BIN, ...args],
      cwd: root,
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if (args[0] === 'lock') return { exit: r.exitCode, status: {} }
    return { exit: r.exitCode, status: lastStatus(root, env) }
  }

  it('runs the lines the workflow runs', () => {
    expect(
      [...workflow.matchAll(/^\s+- run: >?\s*bun (vx \w+(?: --[\w-]+)?)/gm)].map((m) => m[1]),
    ).toEqual(['vx lock --check', 'vx pipeline'])
    expect(workflow).toContain("github.event_name == 'pull_request' && 'pr' || 'main' }}")
  })

  it('the CI guide shows the workflow and the workspace as they are here', () => {
    const guide = readFileSync(
      path.join(PACKAGES, '..', 'private', 'vx-docs', 'src', 'content', 'docs', 'docs', 'ci.mdx'),
      'utf8',
    )
    const fence = (title: string): string | undefined =>
      new RegExp(
        '```\\w+ title="' + title.replace(/\./g, '\\.') + '"[^\\n]*\\n([\\s\\S]*?)```',
      ).exec(guide)?.[1]
    expect(fence('.github/workflows/ci.yml')).toBe(workflow)
    expect(fence('.vx/workspace.ts')).toBe(
      readFileSync(path.join(root, '.vx/workspace.ts'), 'utf8'),
    )
  })

  it('main fills the cache, a pull request reuses it and builds only what it changed', () => {
    const main = 'refs/heads/main'
    const pr = 'refs/pull/7/merge'
    // A laptop wrote the locks and committed them (the fixture, as the README says).
    expect(step(main, ['lock', '--check']).exit).toBe(0)
    const pushed = step(main, ['pipeline', 'main'])
    expect(pushed.exit).toBe(0)
    expect(pushed.status).toEqual({
      'app#build': 'success',
      'app#lint': 'success',
      'app#test': 'success',
      'lib#build': 'success',
      'lib#lint': 'success',
    })
    Bun.spawnSync(['git', 'update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: root })

    // The pull request changes app alone: lib comes from main's keys.
    writeFileSync(
      path.join(root, 'packages/app/src/main.js'),
      "import { greet } from 'lib'\n\nconsole.log(greet('vx'))\nconsole.log(greet('pr'))\n",
    )
    commit(root)
    expect(step(pr, ['lock', '--check']).exit).toBe(0)
    const opened = step(pr, ['pipeline', 'pr'])
    expect(opened.exit).toBe(0)
    expect(opened.status).toEqual({
      'app#build': 'success',
      'app#lint': 'success',
      'app#test': 'success',
      'lib#build': 'cache-hit',
    })
    expect(step(pr, ['pipeline', 'pr']).status['app#build']).toBe('cache-hit')
    // One disk, one pool: main on the same tree hits what the pull request built.
    expect(step(main, ['pipeline', 'main']).status).toEqual({
      'app#build': 'cache-hit',
      'app#lint': 'cache-hit',
      'app#test': 'cache-hit',
      'lib#build': 'cache-hit',
      'lib#lint': 'cache-hit',
    })
  }, 60_000)

  it('vx lock --check fails a config changed without vx lock', () => {
    const config = path.join(root, 'packages/lib/vx.config.ts')
    writeFileSync(config, readFileSync(config, 'utf8').replace('cp src/*.js', 'cp -p src/*.js'))
    commit(root)
    expect(step('refs/pull/8/merge', ['lock', '--check']).exit).toBe(1)
  })
})

// Each starter's README opens with `bun install`, and the fixtures above
// link node_modules instead of installing, so nothing ran it: the lockfile
// plugin each workspace declares must read the lockfile that install writes.
describe('the starters install with the package manager their README names', () => {
  it('each starter installs with bun, locks, and reads bun.lock', () => {
    for (const name of starters()) {
      const readme = readFileSync(path.join(EXAMPLES, name, 'README.md'), 'utf8')
      expect(readme).toContain('bun install')
      // A run keys from the digests `vx lock` records, and refuses without them.
      expect(readme.indexOf('vx lock')).toBeGreaterThan(readme.indexOf('bun install'))
      const workspace = readFileSync(path.join(EXAMPLES, name, '.vx', 'workspace.ts'), 'utf8')
      expect(workspace).toContain("import { bun } from '@vzn/vx-lockfile'")
    }
  })
})

// A starter's committed locks are what a reader copies: a lock an older
// vx wrote refuses their first run. Each must be what `vx lock` writes
// now (VX_UPDATE_CONTRACT=1 rewrites them).
it('each starter that commits its locks commits the ones vx lock writes', () => {
  const stale: string[] = []
  for (const [name, { root, files }] of committedLocks)
    for (const f of files) {
      const now = readFileSync(path.join(root, f), 'utf8')
      const shippedAt = path.join(EXAMPLES, name, f)
      if (now === readFileSync(shippedAt, 'utf8')) continue
      if (process.env['VX_UPDATE_CONTRACT'] === '1' && process.env['CI'] !== 'true')
        writeFileSync(shippedAt, now)
      else stale.push(`examples/${name}/${f}`)
    }
  expect(committedLocks.size).toBeGreaterThan(0)
  expect(stale).toEqual([])
})

/** Every directory under examples/: what a README can point a reader at. */
function starters(): string[] {
  return readdirSync(EXAMPLES, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
}

// The runs above and examples.live.test.ts's (the stacks, installed from
// npm) name their starters; one added to examples/ without a describe
// block would ship unrun. The set is read from the tree.
describe('every starter under examples/ has a run in this suite or the live one', () => {
  it('the directories are the ones the describe blocks drive', () => {
    const live = path.join(import.meta.dir, 'examples.live.test.ts')
    const driven = [
      ...[import.meta.path, live]
        .map((f) => readFileSync(f, 'utf8'))
        .join('\n')
        .matchAll(/^describe\('examples\/(\w+)'/gm),
    ]
      .map((m) => m[1]!)
      .sort()
    expect(starters()).toEqual(driven)
  })
})
