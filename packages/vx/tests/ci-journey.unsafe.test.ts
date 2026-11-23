// A workspace's CI, end to end through the CLI: a remote cache on a real
// @vzn/vx-cache-server behind CI OIDC tokens (main's job writes, a branch's
// job restores it, a stranger's token and a laptop with none still run),
// then a pipeline that fails fast and one whose timeout kills a hung task.
// `.unsafe`: the fixture links @vzn/vx-lockfile and @vzn/vx-cache from this
// repo, reads outside this project a sandboxed shard may not make.
import { realpathSync } from 'node:fs'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { dropCi } from './helpers/env.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const PACKAGES = path.resolve(import.meta.dir, '..', '..')
const SERVER = path.join(PACKAGES, 'vx-cache-server')
const GITHUB = 'https://token.actions.githubusercontent.com'

let root = ''
let env: Record<string, string> = {}
let server: { url: URL; stop(force: boolean): Promise<void> }
let held: Map<string, Uint8Array>
let sign: (claims: Record<string, unknown>) => Promise<string>

type Result = { code: number; out: string }

async function sh(cmd: string[], extra: Record<string, string> = {}): Promise<Result> {
  const proc = Bun.spawn(cmd, {
    cwd: root,
    env: { ...env, ...extra },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, out: out + err }
}

const vx = (args: string[], extra: Record<string, string> = {}): Promise<Result> =>
  sh([process.execPath, BIN, ...args], extra)

async function ok(cmd: string[], extra: Record<string, string> = {}): Promise<string> {
  const r = await sh(cmd, extra)
  expect([cmd.join(' '), r.code, r.out]).toEqual([cmd.join(' '), 0, r.out])
  return r.out
}

/** The last run's tasks, as `vx last --format json` reports them. */
async function lastTasks(extra: Record<string, string> = {}): Promise<Record<string, string>> {
  const r = await vx(['last', '--format', 'json'], extra)
  expect(r.code).toBe(0)
  const { tasks } = JSON.parse(r.out) as {
    tasks: { project: string; task: string; status: string }[]
  }
  return Object.fromEntries(tasks.map((t) => [`${t.project}#${t.task}`, t.status]))
}

/** A CI job: its own machine (cache and home), the token its job holds. */
async function job(name: string, token?: string): Promise<Record<string, string>> {
  const home = path.join(root, `.job-${name}`)
  await mkdir(home, { recursive: true })
  return {
    CI: 'true',
    HOME: home,
    VX_CACHE_DIR: path.join(home, 'cache'),
    ...(token === undefined ? {} : { VX_CACHE_TOKEN: token }),
  }
}

async function pkg(name: string, deps: string[], check: string): Promise<void> {
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
  await writeFile(
    path.join(dir, 'vx.config.ts'),
    `export default {
  tasks: {
    build: {
      exec: { command: 'mkdir -p dist && cat src/*.ts > dist/index.js' },
      inputs: { files: ['src/**'] },
      outputs: { files: ['dist/**'] },
      dependsOn: ['^build'],
      cache: true,
    },
    check: { exec: { command: ${JSON.stringify(check)} } },
  },
}
`,
  )
}

beforeAll(async () => {
  root = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'vx-ci-journey-')))
  // The server in this process: its issuer's keys are served without a network.
  const { issuer, ALLOW } = (await import(path.join(SERVER, 'tests', 'issuer.ts'))) as {
    issuer(): Promise<{
      fetchJson(url: string): Promise<unknown>
      sign(claims: Record<string, unknown>, aud: string): Promise<string>
    }>
    ALLOW: unknown
  }
  const { memBlobs } = await import(path.join(SERVER, 'tests', 'mem-blobs.ts'))
  const { createCacheServer } = await import(path.join(SERVER, 'src', 'server.ts'))
  const { listen } = await import(path.join(SERVER, 'src', 'bun.ts'))
  const { oidcAuth } = await import(path.join(PACKAGES, 'vx-devtools', 'src', 'index.ts'))
  const iss = await issuer()
  held = new Map()
  server = listen(
    createCacheServer({
      blobs: memBlobs(held),
      authorize: oidcAuth({ allow: ALLOW, fetchJson: iss.fetchJson }),
    }),
    '127.0.0.1',
    0,
  )
  sign = (claims) => iss.sign(claims, server.url.origin)

  const base: Record<string, string | undefined> = { ...process.env }
  dropCi(base)
  delete base['npm_config_user_agent']
  delete base['VX_CACHE_TOKEN']
  env = Object.fromEntries(
    Object.entries(base).filter((e): e is [string, string] => e[1] !== undefined),
  )
  Object.assign(env, {
    HOME: path.join(root, '.home'),
    BUN_INSTALL_CACHE_DIR: path.join(root, '.bun-cache'),
    VX_CACHE_DIR: path.join(root, '.home', 'cache'),
    VX_CACHE_URL: server.url.origin,
    NO_COLOR: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@t',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@t',
  })
  await mkdir(env['HOME']!, { recursive: true })
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'acme', private: true, workspaces: ['packages/*'] }),
  )
  await writeFile(path.join(root, '.gitignore'), 'node_modules\ndist\n.home\n.job-*\n.bun-cache\n')
  await pkg('utils', [], 'exit 1')
  await pkg('lib', ['utils'], 'true')
  await pkg('app', ['lib'], 'sleep 30')
  await mkdir(path.join(root, '.vx'))
  await writeFile(
    path.join(root, '.vx', 'workspace.ts'),
    `import { vxCache } from '@vzn/vx-cache'
import { bun } from '@vzn/vx-lockfile'

export default {
  plugins: [bun(), vxCache({ issuer: '${GITHUB}', repository: 'acme/app' })],
  pipelines: {
    pr: { tasks: ['check'], failFast: true },
    nightly: { tasks: ['@acme/app#check'], timeout: '1s' },
  },
}
`,
  )
  await ok(['git', 'init', '-q', '-b', 'main'])
  await ok([process.execPath, 'install'])
  // Linked as a release's devDependencies would be installed.
  await mkdir(path.join(root, 'node_modules', '@vzn'), { recursive: true })
  for (const p of ['vx-lockfile', 'vx-cache'])
    await symlink(path.join(PACKAGES, p), path.join(root, 'node_modules', '@vzn', p))
  await ok([process.execPath, BIN, 'lock'])
  await ok(['git', 'add', '-A'])
  await ok(['git', 'commit', '-qm', 'workspace'])
})

afterAll(async () => {
  await server?.stop(true)
  if (root !== '') await rm(root, { recursive: true, force: true })
})

const BUILDS = ['@acme/utils#build', '@acme/lib#build', '@acme/app#build']

describe("a workspace's CI, end to end", () => {
  it("main's job builds and uploads each artifact", async () => {
    const main = await job('main', await sign({ ref: 'refs/heads/main', event_name: 'push' }))
    const r = await vx(['run', 'build', '--all'], main)
    expect([r.code, r.out]).toEqual([0, r.out])
    expect(await lastTasks(main)).toEqual(Object.fromEntries(BUILDS.map((t) => [t, 'success'])))
    expect(held.size).toBe(3)
  })

  it("a branch's job on a fresh machine restores main's artifacts", async () => {
    await ok(['git', 'checkout', '-qb', 'feature'])
    const branch = await job(
      'branch',
      await sign({ ref: 'refs/heads/feature', event_name: 'push' }),
    )
    const r = await vx(['run', 'build', '--all'], branch)
    expect([r.code, r.out]).toEqual([0, r.out])
    expect(await lastTasks(branch)).toEqual(
      Object.fromEntries(BUILDS.map((t) => [t, 'cache-hit-remote'])),
    )
    expect(await Bun.file(path.join(root, 'packages', 'app', 'dist', 'index.js')).text()).toBe(
      'export const app = 1\n',
    )
    expect(held.size).toBe(3)
  })

  it("another repository's token is refused, and the run still builds", async () => {
    const stranger = await job(
      'stranger',
      await sign({
        ref: 'refs/heads/main',
        event_name: 'push',
        repository: 'acme/other',
        job_workflow_ref: 'acme/other/.github/workflows/ci.yml@refs/heads/main',
      }),
    )
    const r = await vx(['run', 'build', '--all'], stranger)
    expect([r.code, r.out]).toEqual([0, r.out])
    expect(r.out).toContain("repository acme/other is not in this server's ALLOW")
    expect(await lastTasks(stranger)).toEqual(Object.fromEntries(BUILDS.map((t) => [t, 'success'])))
    expect(held.size).toBe(3)
  })

  it('a laptop with no token builds and writes nothing remote', async () => {
    const r = await vx(['run', 'build', '--all'])
    expect([r.code, r.out]).toEqual([0, r.out])
    expect(held.size).toBe(3)
  })

  it('a fail-fast pipeline kills the hung task at the first failure', async () => {
    const started = performance.now()
    const r = await vx(['pipeline', 'pr'])
    expect(r.code).toBe(1)
    // app's `sleep 30` was killed, not waited for.
    expect(performance.now() - started).toBeLessThan(15_000)
    const tasks = await lastTasks()
    expect(tasks['@acme/utils#check']).toBe('failed')
    expect(tasks['@acme/app#check']).not.toBe('success')
  })

  it("a pipeline's timeout kills a task that hangs", async () => {
    const started = performance.now()
    const r = await vx(['pipeline', 'nightly'])
    expect(r.code).toBe(1)
    expect(performance.now() - started).toBeLessThan(15_000)
    expect(r.out).toContain('timed out')
    expect(await lastTasks()).toEqual({ '@acme/app#check': 'failed' })
  })
})
