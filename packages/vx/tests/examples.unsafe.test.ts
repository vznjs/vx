// The starters under examples/ are what a README tells a new user to copy,
// so they must run: each is copied to a fresh git repo, the @vzn packages
// it imports linked to this checkout, and `vx run` driven through a cold
// run, a warm one and a change. examples/ lives outside packages/vx, which a
// sandboxed shard cannot read — hence the unsafe suite.
import {
  cpSync,
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

const CORE = path.resolve(import.meta.dir, '..')
const PACKAGES = path.dirname(CORE)
const EXAMPLES = path.resolve(PACKAGES, '..', 'examples')
const BIN = path.join(CORE, 'src', 'bin.ts')
const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

/** A fresh git repo holding `examples/<name>`, with `links` (package dirs) as its @vzn deps. */
function fixture(name: string, links: string[]): string {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), `vx-example-${name}-`)))
  roots.push(root)
  cpSync(path.join(EXAMPLES, name), root, { recursive: true })
  mkdirSync(path.join(root, 'node_modules', '@vzn'), { recursive: true })
  for (const dir of links) {
    symlinkSync(path.join(PACKAGES, dir), path.join(root, 'node_modules', '@vzn', dir))
  }
  commit(root)
  return root
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

let n = 0
/** One `vx run <task> --all`: its exit, each task's status from --summarize,
 *  and the summary's cache legend (`3 miss`). */
function run(
  root: string,
  task: string,
): { exit: number; status: Record<string, string>; cache: string } {
  const summary = path.join(path.dirname(root), `${path.basename(root)}-${n++}.json`)
  const r = Bun.spawnSync({
    cmd: [process.execPath, BIN, 'run', task, '--all', `--summarize=${summary}`],
    cwd: root,
    env: { ...process.env, CI: 'true' },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const tasks = (
    JSON.parse(readFileSync(summary, 'utf8')) as {
      tasks: { id: string; status: string }[]
    }
  ).tasks
  rmSync(summary, { force: true })
  const lines = r.stdout.toString().split('\n')
  const cache = lines[lines.findIndex((l) => l.startsWith('  cache ')) + 1]?.trim() ?? ''
  return {
    exit: r.exitCode,
    status: Object.fromEntries(tasks.map((t) => [t.id, t.status])),
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
    writeFileSync(path.join(root, 'packages/lib/src/greet.js'), 'const greet = (n) => `hi, ${n}`\n')
    const edited = run(root, 'ci')
    expect(edited.exit).toBe(0)
    expect([
      edited.status['lib#build'],
      edited.status['app#build'],
      edited.status['app#test'],
    ]).toEqual(['success', 'success', 'success'])
  })
})

// The migrate guide's temporary start: turbo() maps the Turbo repo until
// `vx-migrate` writes native configs, which derive the same keys, so the
// cache turbo() filled still hits. Each step's output is what the guide's
// "Try it in five minutes" block says in its comments.
describe('examples/turbo', () => {
  const said: string[] = []
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
    said.push(`${cold.cache}: ${Object.keys(cold.status).toSorted().join(', ')}`)
    const warm = run(root, 'test')
    expect(warm.exit).toBe(0)
    expect(warm.status).toEqual(all('cache-hit'))
    said.push(warm.cache)
  })

  // The migrate guide's steps as written: the workspace file stays (the
  // CLI never overwrites one), then turbo() goes and the configs stand alone.
  it('migrates to written configs that hit the cache turbo() filled', () => {
    const workspace = readFileSync(path.join(root, 'vx.workspace.ts'), 'utf8')
    const migrate = Bun.spawnSync({
      cmd: [process.execPath, path.join(PACKAGES, 'vx-migrate', 'src', 'bin.ts')],
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(migrate.exitCode).toBe(0)
    const out = migrate.stdout.toString()
    said.push(out.split('\n').find((l) => l.includes('migrated'))!)
    expect(out.slice(out.indexOf('files written:')).split('\n').slice(1, 3)).toEqual([
      '  packages/app/vx.config.ts',
      '  packages/lib/vx.config.ts',
    ])
    expect(readFileSync(path.join(root, 'vx.workspace.ts'), 'utf8')).toBe(workspace)
    commit(root)
    const kept = run(root, 'test')
    expect(kept.exit).toBe(0)
    expect(kept.status).toEqual(all('cache-hit'))
    said.push(kept.cache)

    rmSync(path.join(root, 'vx.workspace.ts'))
    commit(root)
    const alone = run(root, 'test')
    expect(alone.exit).toBe(0)
    expect(alone.status).toEqual(all('cache-hit'))
    said.push(alone.cache)
  })

  it('says in the migrate guide what each step printed', () => {
    const guide = readFileSync(
      path.join(PACKAGES, 'vx-docs', 'src', 'content', 'docs', 'guides', 'migrate.md'),
      'utf8',
    )
    const block = /### Try it in five minutes[\s\S]*?```sh\n([\s\S]*?)```/.exec(guide)![1]!
    const comments = block
      .split('\n')
      .filter((l) => /^(npx vx run|bunx @vzn\/vx-migrate)/.test(l))
      .map((l) => l.slice(l.indexOf('# ') + 2))
    // The first comment lists the tasks that missed; the rest name only the legend.
    const [legend, missed] = comments[0]!.split(': ')
    expect([
      `${legend}: ${missed!.split(', ').toSorted().join(', ')}`,
      ...comments.slice(1).map((c) => c.split(':')[0]),
    ]).toEqual(said)
  })
})

// The README's and the landing's terminal demo is this starter's real
// output; the script re-runs it and compares all but timings and cores.
describe('the terminal demo', () => {
  it('matches a real run of examples/basic', () => {
    const r = Bun.spawnSync({
      cmd: [
        process.execPath,
        path.resolve(CORE, '..', 'vx-docs', 'scripts', 'terminal-demo.ts'),
        '--check',
      ],
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(r.stderr.toString()).toBe('')
    expect(r.exitCode).toBe(0)
    // A whole vx run of the starter: a loaded gate took it past bun's
    // 5 s default (5,006 ms) though it passes alone.
  }, 20_000)
})

// Each starter's README opens with `npm install`, and the fixtures above
// link node_modules instead of installing, so nothing ran it: npm refuses
// pnpm's `workspace:` protocol (EUNSUPPORTEDPROTOCOL), and both starters
// declared `"lib": "workspace:*"` until 2026-10-03.
describe('the starters install with the package manager their README names', () => {
  it('no npm starter declares a workspace: dependency', () => {
    const bad: string[] = []
    for (const name of starters()) {
      expect(readFileSync(path.join(EXAMPLES, name, 'README.md'), 'utf8')).toContain('npm install')
      for (const pkg of [
        'package.json',
        'packages/app/package.json',
        'packages/lib/package.json',
      ]) {
        const json = JSON.parse(readFileSync(path.join(EXAMPLES, name, pkg), 'utf8')) as Record<
          string,
          Record<string, string> | undefined
        >
        for (const field of ['dependencies', 'devDependencies'])
          for (const [dep, spec] of Object.entries(json[field] ?? {}))
            if (spec.startsWith('workspace:')) bad.push(`${name}/${pkg}: ${dep} ${spec}`)
      }
    }
    expect(bad).toEqual([])
  })
})

/** Every directory under examples/: what a README can point a reader at. */
function starters(): string[] {
  return readdirSync(EXAMPLES, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
}

// The runs above name their starters; one added to examples/ without a
// describe block here would ship unrun. The set is read from the tree.
describe('every starter under examples/ has a run in this suite', () => {
  it('the directories are the ones the describe blocks above drive', () => {
    const driven = [
      ...readFileSync(import.meta.path, 'utf8').matchAll(/^describe\('examples\/(\w+)'/gm),
    ]
      .map((m) => m[1]!)
      .sort()
    expect(starters()).toEqual(driven)
  })
})
