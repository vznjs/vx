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
import { freePort } from './helpers/free-port.js'

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

async function install(at = root, args: string[] = []): Promise<void> {
  await ok([process.execPath, 'install', ...args], at)
  // An install prunes node_modules to the lockfile: link the plugin again,
  // as a release's devDependency would stay.
  await mkdir(path.join(at, 'node_modules', '@vzn'), { recursive: true })
  await rm(path.join(at, 'node_modules', '@vzn', 'vx-lockfile'), { force: true })
  await symlink(LOCKFILE_PLUGIN, path.join(at, 'node_modules', '@vzn', 'vx-lockfile'))
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
  // The home exists as a machine's does: steps keep their scratch in it.
  await mkdir(env['HOME']!, { recursive: true })
  await writeFile(
    path.join(root, '.gitignore'),
    'node_modules\ndist\n.home\n.ci-home\n.bun-cache\n',
  )
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

  it('a new package is not there until vx lock, then builds', async () => {
    await pkg('web', ['lib'])
    await config('web')
    const unlocked = await vx(['run', 'build', '--filter', '@acme/web'])
    expect([unlocked.code, unlocked.out]).toEqual([
      1,
      expect.stringContaining('no projects matched filter(s): "@acme/web"'),
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
      expect.stringContaining('its directory is gone — run `vx lock`'),
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
      // Each row as its task ends: web and app both follow lib, in either order.
      for (const t of [
        '@acme/utils#build',
        '@acme/lib#build',
        '@acme/app#build',
        '@acme/web#build',
      ])
        await until(t)
      expect(out).toContain('changed @acme/utils src/index.ts')
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

  it('a task file the configs share composes them, and vx lock --check sees its edit', async () => {
    const shared = path.join(root, 'tools', 'tasks.ts')
    await mkdir(path.dirname(shared), { recursive: true })
    await writeFile(
      shared,
      BUILD.replace('export default {\n  tasks: {\n    build: ', 'export const build = ').replace(
        /,\n  },\n}\n$/,
        '\n',
      ),
    )
    for (const name of ['utils', 'lib', 'app', 'web'])
      await writeFile(
        path.join(root, 'packages', name, 'vx.config.ts'),
        "import { build } from '../../tools/tasks.ts'\n\nexport default { tasks: { build } }\n",
      )
    // The same config by another route: the lock, and so every key, holds.
    const r = await vx(['lock'])
    expect([r.code, r.out]).toEqual([0, expect.stringContaining('5 project configs')])
    expect((await vx(['lock', '--check'])).code).toBe(0)
    await writeFile(
      shared,
      (await readFile(shared, 'utf8')).replace("'src/**'", "'src/**', 'README.md'"),
    )
    const drift = await vx(['lock', '--check'])
    expect([drift.code, drift.out]).toEqual([
      1,
      expect.stringContaining('packages/lib/vx.config.ts evaluates differently from the lock'),
    ])
    expect((await vx(['lock'])).code).toBe(0)
    await ok(['git', 'add', '-A'])
    await ok(['git', 'commit', '-qm', 'shared tasks'])
  })

  it('a dev server serves the task that needs it, and stops with the run', async () => {
    const port = freePort()
    const app = path.join(root, 'packages', 'app')
    await writeFile(
      path.join(app, 'server.ts'),
      `const s = Bun.serve({ port: ${port}, fetch: () => new Response('served') })\nconsole.log('Local: http://localhost:' + s.port)\n`,
    )
    await writeFile(
      path.join(app, 'vx.config.ts'),
      `import { build } from '../../tools/tasks.ts'

export default {
  tasks: {
    build,
    dev: {
      exec: { command: '${process.execPath} server.ts', persistent: { readyWhen: 'Local:' }, timeout: '20s' },
      inputs: { files: ['server.ts'] },
    },
    e2e: {
      dependsOn: ['dev'],
      exec: { command: 'mkdir -p out && curl -sf http://127.0.0.1:${port} > out/page' },
      inputs: { files: ['e2e/**'] },
      outputs: { files: ['out/**'] },
      cache: true,
    },
  },
}
`,
    )
    expect((await vx(['lock'])).code).toBe(0)
    const r = await vx(['run', 'e2e'], app)
    expect([r.code, r.out]).toEqual([0, expect.stringContaining('@acme/app#e2e')])
    expect(await readFile(path.join(app, 'out', 'page'), 'utf8')).toBe('served')
    // The server is gone with the run: its port is free again.
    expect(() =>
      Bun.listen({ hostname: '127.0.0.1', port, socket: { data() {} } }).stop(true),
    ).not.toThrow()
    // Unsandboxed, the server may write in its project, where e2e reads:
    // it starts again, and e2e hits.
    expect((await vx(['run', 'e2e'], app)).code).toBe(0)
    expect((await lastTasks())['@acme/app#e2e']).toEqual({ status: 'cache-hit', cacheHit: true })
    await ok(['git', 'add', '-A'])
    await ok(['git', 'commit', '-qm', 'dev server'])
  })

  it('CI: a one-commit clone of the branch checks the lock and runs only what it changed', async () => {
    const remote = path.join(root, '.home', 'remote.git')
    const ci = path.join(root, '.home', 'ci')
    await ok(['git', 'clone', '-q', '--bare', root, remote])
    await ok(['git', 'symbolic-ref', 'HEAD', 'refs/heads/main'], remote)
    await ok(['git', 'clone', '-q', '--depth', '1', '--branch', 'feat', `file://${remote}`, ci])
    await install(ci, ['--frozen-lockfile'])
    // A fresh runner: no store, no memo of what `vx lock` parsed.
    const home = env['HOME']!
    env['HOME'] = path.join(root, '.ci-home')
    try {
      const check = await vx(['lock', '--check'], ci)
      expect([check.code, check.out]).toEqual([
        0,
        expect.stringContaining('up to date (5 projects)'),
      ])
      const dry = await vx(['run', 'build', '--affected', '--dry'], ci)
      expect(dry.code).toBe(0)
      // main..feat changed lib's source, added web and moved every config
      // onto the shared file: each build is affected, and says why.
      const affected = dry.out.split('\n').filter((l) => l.includes('affected:'))
      expect(affected).toHaveLength(4)
      expect((await vx(['run', 'build', '--affected'], ci)).code).toBe(0)
    } finally {
      env['HOME'] = home
    }
  })

  // Two branches that each re-locked meet in a merge git cannot resolve in
  // the locks: they are written from the configs, so `vx lock` resolves them.
  it('a merge conflicted in the locks refuses until vx lock writes them anew', async () => {
    const edit = async (name: string, from: string, to: string): Promise<void> => {
      const file =
        name === 'tools'
          ? path.join(root, 'tools', 'tasks.ts')
          : path.join(root, 'packages', name, 'package.json')
      await writeFile(file, (await readFile(file, 'utf8')).replace(from, to))
    }
    await ok(['git', 'checkout', '-qb', 'one'])
    await edit('tools', "'src/**'", "'src/**', 'one.txt'")
    await edit('app', '"dependencies":{', '"dependencies":{"@acme/utils":"workspace:*",')
    await install()
    expect((await vx(['lock'])).code).toBe(0)
    await ok(['git', 'commit', '-qam', 'one'])
    await ok(['git', 'checkout', '-q', 'feat'])
    await install()
    await ok(['git', 'checkout', '-qb', 'two'])
    await edit('tools', "'src/**'", "'src/**', 'two.txt'")
    await edit('app', '"version":"1.0.0"', '"version":"1.0.1"')
    await install()
    expect((await vx(['lock'])).code).toBe(0)
    await ok(['git', 'commit', '-qam', 'two'])
    expect((await sh(['git', 'merge', '-q', 'one'])).code).toBe(1)
    const conflicted = (file: string) => [
      1,
      expect.stringContaining(
        `${file} holds a git merge conflict: run \`vx lock\`, which writes it anew from the configs`,
      ),
    ]
    const projects = await vx(['run', 'build', '--all'])
    expect([projects.code, projects.out]).toEqual(conflicted('.vx/projects.lock'))
    // One side of the config lock kept: the dependencies lock still conflicts.
    await ok(['git', 'checkout', '-q', '--ours', '.vx/projects.lock'])
    const dependencies = await vx(['run', 'build', '--all'])
    expect([dependencies.code, dependencies.out]).toEqual(conflicted('.vx/dependencies.lock'))
    // The user resolves the source files, never the locks.
    await writeFile(
      path.join(root, 'packages', 'app', 'package.json'),
      JSON.stringify({
        name: '@acme/app',
        version: '1.0.1',
        dependencies: { '@acme/utils': 'workspace:*', '@acme/lib': 'workspace:*' },
      }),
    )
    await ok(['git', 'checkout', '-q', '--ours', 'bun.lock'])
    const shared = path.join(root, 'tools', 'tasks.ts')
    await writeFile(
      shared,
      (await readFile(shared, 'utf8')).replace(
        /<<<<<<<[^\n]*\n([^\n]*\n)=======\n[^\n]*\n>>>>>>>[^\n]*\n/,
        '$1',
      ),
    )
    await install()
    expect((await vx(['lock'])).code).toBe(0)
    expect((await vx(['run', 'build', '--all'])).code).toBe(0)
    await ok(['git', 'commit', '-qam', 'merge one'])
  })

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
