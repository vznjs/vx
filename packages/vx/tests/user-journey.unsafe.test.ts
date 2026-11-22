// A new user's first hour, end to end through the CLI a release ships: a
// Bun workspace of three packages gets `vx init`, a build per package,
// `vx lock`, a miss then a hit, an edit `vx why` names, deleted outputs
// restored, `--affected` on a branch, a package and a dependency added, a
// package removed, `vx watch` rebuilding an edit, and a failure skipping
// its dependents. Each step runs where the previous one left the workspace,
// as a user's would. `.unsafe`: the fixture links @vzn/vx-lockfile from this repo, a
// read outside this project a sandboxed shard may not make.
import { existsSync, realpathSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { dropCi } from './helpers/env.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const LOCKFILE_PLUGIN = path.resolve(import.meta.dir, '..', '..', 'vx-lockfile')

let root = ''
let env: Record<string, string> = {}

type Result = { code: number; out: string }

async function sh(cmd: string[], cwd = root): Promise<Result> {
  const proc = Bun.spawn(cmd, { cwd, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, out: out + err }
}

const vx = (args: string[], cwd = root): Promise<Result> =>
  sh([process.execPath, BIN, ...args], cwd)

async function ok(cmd: string[], cwd = root): Promise<string> {
  const r = await sh(cmd, cwd)
  expect([cmd.join(' '), r.code, r.out]).toEqual([cmd.join(' '), 0, r.out])
  return r.out
}

/** The last run's tasks, as `vx last --format json` reports them. */
async function lastTasks(): Promise<Record<string, { status: string; cacheHit: boolean }>> {
  const r = await vx(['last', '--format', 'json'])
  expect(r.code).toBe(0)
  const tasks = (
    JSON.parse(r.out) as {
      tasks: { project: string; task: string; status: string; cacheHit: boolean }[]
    }
  ).tasks
  return Object.fromEntries(
    tasks.map((t) => [`${t.project}#${t.task}`, { status: t.status, cacheHit: t.cacheHit }]),
  )
}

async function install(): Promise<void> {
  await ok([process.execPath, 'install'])
  // An install prunes node_modules to the lockfile: link the plugin again,
  // as a release's devDependency would stay.
  await mkdir(path.join(root, 'node_modules', '@vzn'), { recursive: true })
  await rm(path.join(root, 'node_modules', '@vzn', 'vx-lockfile'), { force: true })
  await symlink(LOCKFILE_PLUGIN, path.join(root, 'node_modules', '@vzn', 'vx-lockfile'))
}

async function pkg(name: string, deps: string[]): Promise<void> {
  const dir = path.join(root, 'packages', name)
  await mkdir(path.join(dir, 'src'), { recursive: true })
  await writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({
      name: `@acme/${name}`,
      version: '1.0.0',
      dependencies: Object.fromEntries(deps.map((d) => [`@acme/${d}`, 'workspace:*'])),
    }),
  )
  await writeFile(path.join(dir, 'src', 'index.ts'), `export const ${name} = 1\n`)
}

// The quickstart's task, with a command any machine has in place of tsc.
const BUILD = `export default {
  tasks: {
    build: {
      exec: { command: 'mkdir -p dist && cat src/*.ts > dist/index.js' },
      inputs: { files: ['src/**'] },
      outputs: { files: ['dist/**'] },
      dependsOn: ['^build'],
      cache: true,
    },
  },
}
`

const config = (name: string): Promise<void> =>
  writeFile(path.join(root, 'packages', name, 'vx.config.ts'), BUILD)

beforeAll(async () => {
  // Real path: macOS's /tmp is a link, and a child's cwd is resolved.
  root = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'vx-journey-')))
  const base: Record<string, string | undefined> = { ...process.env }
  dropCi(base)
  // The `next:` line names the runner that started vx; none here.
  delete base['npm_config_user_agent']
  env = Object.fromEntries(
    Object.entries(base).filter((e): e is [string, string] => e[1] !== undefined),
  )
  Object.assign(env, {
    // The machine store is ~/.vx/<id>: a fresh machine, and nothing left behind.
    HOME: path.join(root, '.home'),
    // Bun's install cache is under the home; keep it in the fixture.
    BUN_INSTALL_CACHE_DIR: path.join(root, '.bun-cache'),
    NO_COLOR: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@t',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@t',
  })
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'acme', private: true, workspaces: ['packages/*'] }),
  )
  await writeFile(path.join(root, '.gitignore'), 'node_modules\ndist\n.home\n.bun-cache\n')
  await pkg('utils', [])
  await pkg('lib', ['utils'])
  await pkg('app', ['lib'])
  await ok(['git', 'init', '-q', '-b', 'main'])
  await install()
  await ok(['git', 'add', '-A'])
  await ok(['git', 'commit', '-qm', 'workspace'])
})

afterAll(async () => {
  if (root !== '') await rm(root, { recursive: true, force: true })
})

describe('a new user, end to end', () => {
  it('vx init declares the lockfile plugin and writes the lock', async () => {
    const r = await vx(['init'])
    expect([r.code, r.out]).toEqual([0, expect.stringContaining('.vx/projects.lock')])
    expect(await readFile(path.join(root, '.vx', 'workspace.ts'), 'utf8')).toContain(
      'plugins: [bun()]',
    )
  })

  it('a build per package locks, and the root asks for --all', async () => {
    for (const name of ['utils', 'lib', 'app']) await config(name)
    expect((await vx(['lock'])).code).toBe(0)
    const bare = await vx(['run', 'build'])
    expect([bare.code, bare.out]).toEqual([1, expect.stringContaining('pass --all')])
  })

  it('the first run builds every package, dependencies first', async () => {
    expect((await vx(['run', 'build', '--all'])).code).toBe(0)
    expect(await lastTasks()).toEqual({
      '@acme/utils#build': { status: 'success', cacheHit: false },
      '@acme/lib#build': { status: 'success', cacheHit: false },
      '@acme/app#build': { status: 'success', cacheHit: false },
    })
    expect(await readFile(path.join(root, 'packages', 'app', 'dist', 'index.js'), 'utf8')).toBe(
      'export const app = 1\n',
    )
    await ok(['git', 'add', '-A'])
    await ok(['git', 'commit', '-qm', 'vx'])
  })

  it('the second run hits for every task', async () => {
    expect((await vx(['run', 'build', '--all'])).code).toBe(0)
    const tasks = await lastTasks()
    expect(Object.values(tasks).every((t) => t.cacheHit)).toBe(true)
    expect(Object.keys(tasks)).toHaveLength(3)
  })

  it('an edit re-runs its task and dependents, and vx why names the file', async () => {
    await writeFile(
      path.join(root, 'packages', 'utils', 'src', 'index.ts'),
      'export const utils = 2\n',
    )
    expect((await vx(['run', 'build', '--all'])).code).toBe(0)
    expect(Object.values(await lastTasks()).map((t) => t.cacheHit)).toEqual([false, false, false])
    const own = await vx(['why', 'build'], path.join(root, 'packages', 'utils'))
    expect([own.code, own.out]).toEqual([
      0,
      expect.stringContaining('cache key changed: file packages/utils/src/index.ts'),
    ])
    const app = await vx(['why', '@acme/app#build'])
    expect(app.out).toContain(
      '@acme/app#build ← @acme/lib#build ← @acme/utils#build ← file packages/utils/src/index.ts',
    )
    // Back to the committed bytes: the entries from the first run answer.
    await ok(['git', 'checkout', '-q', '--', 'packages/utils'])
    expect((await vx(['run', 'build', '--all'])).code).toBe(0)
    expect(Object.values(await lastTasks()).every((t) => t.cacheHit)).toBe(true)
  })

  it('deleted and edited outputs come back from the cache', async () => {
    for (const name of ['utils', 'lib'])
      await rm(path.join(root, 'packages', name, 'dist'), { recursive: true })
    const appOut = path.join(root, 'packages', 'app', 'dist', 'index.js')
    await writeFile(appOut, 'tampered\n')
    expect((await vx(['run', 'build', '--all'])).code).toBe(0)
    expect(Object.values(await lastTasks()).every((t) => t.cacheHit)).toBe(true)
    expect(await readFile(appOut, 'utf8')).toBe('export const app = 1\n')
    expect(existsSync(path.join(root, 'packages', 'utils', 'dist', 'index.js'))).toBe(true)
  })

  it('--affected on a branch runs what the change reaches', async () => {
    await ok(['git', 'checkout', '-qb', 'feat'])
    await writeFile(path.join(root, 'packages', 'lib', 'src', 'index.ts'), 'export const lib = 2\n')
    await ok(['git', 'commit', '-qam', 'lib'])
    const dry = await vx(['run', 'build', '--affected', '--dry'])
    expect(dry.code).toBe(0)
    const line = (task: string): string => dry.out.split('\n').find((l) => l.includes(task)) ?? ''
    expect(line('@acme/lib#build')).toContain('affected: packages/lib/src/index.ts changed')
    expect(line('@acme/app#build')).toContain('via @acme/lib#build')
    expect(line('@acme/utils#build')).not.toContain('affected')
    expect((await vx(['run', 'build', '--affected'])).code).toBe(0)
    const tasks = await lastTasks()
    expect([tasks['@acme/lib#build']?.cacheHit, tasks['@acme/app#build']?.cacheHit]).toEqual([
      false,
      false,
    ])
  })

  it('a new package needs vx lock, then builds', async () => {
    await pkg('web', ['lib'])
    await config('web')
    const unlocked = await vx(['run', 'build', '--filter', '@acme/web'])
    expect([unlocked.code, unlocked.out]).toEqual([
      1,
      expect.stringContaining('packages/web/vx.config.ts is not in the lock yet — run `vx lock`'),
    ])
    await install()
    expect((await vx(['lock'])).code).toBe(0)
    expect((await vx(['run', 'build', '--filter', '@acme/web'])).code).toBe(0)
    expect((await lastTasks())['@acme/web#build']).toEqual({ status: 'success', cacheHit: false })
    await ok(['git', 'add', '-A'])
    await ok(['git', 'commit', '-qm', 'web'])
  })

  it('a new dependency refuses until vx lock', async () => {
    const manifest = path.join(root, 'packages', 'app', 'package.json')
    const before = await readFile(manifest, 'utf8')
    const json = JSON.parse(before) as { dependencies: Record<string, string> }
    json.dependencies['@acme/utils'] = 'workspace:*'
    await writeFile(manifest, JSON.stringify(json))
    await install()
    const r = await vx(['run', 'build', '--all'])
    expect([r.code, r.out]).toEqual([
      1,
      expect.stringContaining('bun.lock changed since `vx lock`'),
    ])
    await writeFile(manifest, before)
    await install()
    expect((await vx(['run', 'build', '--all'])).code).toBe(0)
  })

  it('a removed package refuses until vx lock', async () => {
    const away = path.join(root, '.home', 'web')
    await rename(path.join(root, 'packages', 'web'), away)
    const r = await vx(['run', 'build', '--all'])
    expect([r.code, r.out]).toEqual([
      1,
      expect.stringContaining('its vx.config.ts is gone — run `vx lock`'),
    ])
    await rename(away, path.join(root, 'packages', 'web'))
    expect((await vx(['run', 'build', '--all'])).code).toBe(0)
  })

  it('vx watch rebuilds an edit and its dependents, and stops on Ctrl-C', async () => {
    const proc = Bun.spawn([process.execPath, BIN, 'watch', 'build', '--all'], {
      cwd: root,
      env,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    let out = ''
    const drain = async (s: ReadableStream<Uint8Array>): Promise<void> => {
      const dec = new TextDecoder()
      for await (const c of s) out += dec.decode(c, { stream: true })
    }
    const drained = Promise.all([drain(proc.stdout), drain(proc.stderr)])
    const until = async (needle: string): Promise<void> => {
      const end = Date.now() + 20_000
      while (!out.includes(needle)) {
        if (Date.now() > end || proc.exitCode !== null)
          throw new Error(`no "${needle}" in:\n${out}`)
        await Bun.sleep(50)
      }
    }
    try {
      await until('watching')
      await writeFile(
        path.join(root, 'packages', 'utils', 'src', 'index.ts'),
        'export const utils = 3\n',
      )
      await until('@acme/web#build')
      expect(out).toContain('changed @acme/utils src/index.ts')
      for (const t of ['@acme/utils#build', '@acme/lib#build', '@acme/app#build'])
        expect(out).toContain(t)
      expect(await readFile(path.join(root, 'packages', 'utils', 'dist', 'index.js'), 'utf8')).toBe(
        'export const utils = 3\n',
      )
    } finally {
      proc.kill('SIGINT')
      await proc.exited
      await drained
    }
    expect(out).toContain('vx watch: stopped')
  }, 30_000)

  it('a failure skips its dependents, and vx last --failed names it', async () => {
    await writeFile(
      path.join(root, 'packages', 'utils', 'vx.config.ts'),
      BUILD.replace("'mkdir -p dist && cat src/*.ts > dist/index.js'", "'echo broken >&2; exit 3'"),
    )
    expect((await vx(['lock'])).code).toBe(0)
    const r = await vx(['run', 'build', '--all'])
    expect([r.code, r.out]).toEqual([1, expect.stringContaining('broken')])
    const tasks = await lastTasks()
    expect(tasks['@acme/utils#build']?.status).toBe('failed')
    for (const t of ['@acme/lib#build', '@acme/app#build', '@acme/web#build'])
      expect(tasks[t]?.status).toBe('skipped')
    const failed = await vx(['last', '--failed'])
    expect(failed.out).toContain('next      vx run @acme/utils#build')
  })
})
