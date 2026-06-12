// `vx show` / `vx info` e2e. Subprocess-driven like lock.test.ts so the
// dispatcher wiring, exit codes, and UserError presentation are all
// exercised exactly as a user sees them. Parser unit tests sit at the
// bottom against the cli contract re-export.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { parseShowArgs } from '../src/cli/index.js'
import { VERSION } from '../src/version.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const TIMEOUT = 20_000

const APP_CONFIG = `
  export default {
    tasks: {
      build: {
        description: 'compile the app',
        exec: { command: 'echo build' },
        dependsOn: ['^build'],
        cache: {
          inputs: { files: ['src/**'], env: ['NODE_ENV'] },
          outputs: { files: ['dist/**'] },
        },
      },
      dev: {
        exec: {
          command: 'echo dev',
          persistent: { readyWhen: 'ready', readyTimeoutMs: 5000 },
        },
      },
      ci: { dependsOn: ['build'] },
    },
  }
`

async function makeWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vx-show-'))
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'fixture-root', private: true }),
  )
  const appDir = path.join(root, 'packages', 'app')
  await mkdir(appDir, { recursive: true })
  await writeFile(path.join(appDir, 'package.json'), JSON.stringify({ name: 'app' }))
  await writeFile(path.join(appDir, 'vx.config.mjs'), APP_CONFIG)
  const bareDir = path.join(root, 'packages', 'bare')
  await mkdir(bareDir, { recursive: true })
  await writeFile(path.join(bareDir, 'package.json'), JSON.stringify({ name: 'bare' }))
  return root
}

interface VxResult {
  code: number
  out: string
  err: string
}

async function vx(root: string, args: string[]): Promise<VxResult> {
  const proc = Bun.spawn([process.execPath, BIN, ...args], {
    cwd: root,
    env: { ...process.env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, out, err }
}

describe('vx show (e2e)', () => {
  let root: string
  beforeAll(async () => {
    root = await makeWorkspace()
  })
  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it(
    'no target lists every project with dir, task count, and no-config marker',
    async () => {
      const r = await vx(root, ['show'])
      expect(r.code).toBe(0)
      expect(r.out).toContain('app')
      expect(r.out).toContain('packages/app')
      expect(r.out).toContain('3 tasks')
      expect(r.out).toContain('bare')
      expect(r.out).toContain('(no vx config)')
    },
    TIMEOUT,
  )

  it(
    'no target with --format=json emits {name, dir, tasks[]} per project',
    async () => {
      const r = await vx(root, ['show', '--format=json'])
      expect(r.code).toBe(0)
      const list = JSON.parse(r.out) as { name: string; dir: string; tasks: string[] }[]
      const app = list.find((p) => p.name === 'app')
      expect(app).toEqual({ name: 'app', dir: 'packages/app', tasks: ['build', 'dev', 'ci'] })
      const bare = list.find((p) => p.name === 'bare')
      expect(bare).toEqual({ name: 'bare', dir: 'packages/bare', tasks: [] })
    },
    TIMEOUT,
  )

  it(
    'show <project> pretty prints every task field block',
    async () => {
      const r = await vx(root, ['show', 'app'])
      expect(r.code).toBe(0)
      expect(r.out).toContain('compile the app')
      expect(r.out).toContain('echo build')
      expect(r.out).toContain('^build')
      expect(r.out).toContain('src/**')
      expect(r.out).toContain('NODE_ENV')
      expect(r.out).toContain('dist/**')
      // Group task renders a marker instead of a command.
      expect(r.out).toContain('(group)')
      // Persistent fields surface.
      expect(r.out).toContain('ready')
      expect(r.out).toContain('5000')
    },
    TIMEOUT,
  )

  it(
    'show <pkg>#<task> --format json round-trips the resolved task config',
    async () => {
      const r = await vx(root, ['show', 'app#build', '--format', 'json'])
      expect(r.code).toBe(0)
      const obj = JSON.parse(r.out) as {
        name: string
        dir: string
        task: string
        config: unknown
      }
      expect(obj.name).toBe('app')
      expect(obj.dir).toBe('packages/app')
      expect(obj.task).toBe('build')
      expect(obj.config).toEqual({
        description: 'compile the app',
        exec: { command: 'echo build' },
        dependsOn: ['^build'],
        cache: {
          inputs: { files: ['src/**'], env: ['NODE_ENV'] },
          outputs: { files: ['dist/**'] },
        },
      })
    },
    TIMEOUT,
  )

  it(
    'unknown project errors with near-match suggestions',
    async () => {
      const r = await vx(root, ['show', 'ap'])
      expect(r.code).toBe(1)
      expect(r.err).toContain('unknown project')
      expect(r.err).toContain('app')
      expect(r.err).not.toContain('at ') // clean UserError, no stack
    },
    TIMEOUT,
  )

  it(
    'unknown task errors with near-match suggestions',
    async () => {
      const r = await vx(root, ['show', 'app#bui'])
      expect(r.code).toBe(1)
      expect(r.err).toContain('unknown task')
      expect(r.err).toContain('build')
    },
    TIMEOUT,
  )

  it(
    'invalid --format is a parse error',
    async () => {
      const r = await vx(root, ['show', '--format', 'yaml'])
      expect(r.code).toBe(1)
      expect(r.err).toContain('--format must be pretty or json')
    },
    TIMEOUT,
  )
})

describe('vx info (e2e)', () => {
  let root: string
  beforeAll(async () => {
    root = await makeWorkspace()
  })
  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it(
    'prints versions, workspace shape, cache stats, lock + remote status',
    async () => {
      const r = await vx(root, ['info'])
      expect(r.code).toBe(0)
      expect(r.out).toContain(`vx:             ${VERSION}`)
      expect(r.out).toContain(Bun.version)
      expect(r.out).toContain('git:')
      // macOS realpaths /var → /private/var inside the child; match on
      // the unique tmpdir basename rather than the absolute prefix.
      expect(r.out).toContain('workspace root: ')
      expect(r.out).toContain(path.basename(root))
      expect(r.out).toContain('projects:       2 (3 tasks)')
      expect(r.out).toContain('cache dir:')
      expect(r.out).toContain('cache entries:  0 (0 B)')
      expect(r.out).toContain('runs (24h):     0')
      expect(r.out).toContain('vx-lock.json:   no')
      expect(r.out).toContain('remote cache:   no')
    },
    TIMEOUT,
  )

  it(
    'vx stats is an alias: byte-identical output',
    async () => {
      const info = await vx(root, ['info'])
      const stats = await vx(root, ['stats'])
      expect(stats.code).toBe(0)
      expect(stats.out).toBe(info.out)
    },
    TIMEOUT,
  )
})

describe('parseShowArgs', () => {
  it('defaults to pretty with no target', () => {
    expect(parseShowArgs([])).toEqual({ format: 'pretty' })
  })

  it('captures a positional target', () => {
    expect(parseShowArgs(['app#build'])).toEqual({ format: 'pretty', target: 'app#build' })
  })

  it('accepts --format json in both spellings', () => {
    expect(parseShowArgs(['--format', 'json']).format).toBe('json')
    expect(parseShowArgs(['--format=json']).format).toBe('json')
  })

  it('rejects an invalid format value', () => {
    expect(parseShowArgs(['--format', 'yaml']).error).toBe('--format must be pretty or json')
    expect(parseShowArgs(['--format=']).error).toBe('--format must be pretty or json')
  })

  it('rejects unknown flags and extra positionals', () => {
    expect(parseShowArgs(['--bogus']).error).toBe('unknown flag: --bogus')
    expect(parseShowArgs(['a', 'b']).error).toBe('unexpected argument: b')
  })
})
