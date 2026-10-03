// `nx({ executors })`: the workspace's own translation of an executor to a
// command. A function's return is the task's command, timeout and env; its
// undefined leaves the target to `nx-exec`, as an executor no function
// names. The mapper rows drive `mapNxWorkspace`; the plugin rows a real
// `planRun` over a workspace that declares the option.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { planRun, type Logger, type ProjectMeta } from '@vzn/vx'
import { fakeNx, fakeNxCli } from './helpers/fake-nx.js'
import { localWorkspaceSource } from './helpers/local-workspace.js'
import { mapNxWorkspace, parseNxGraph, type NxExecutors } from '../src/nx/nx-map.js'
import { nx } from '../src/index.js'

const PLUGIN_INDEX = path.resolve(import.meta.dir, '..', 'src', 'index.ts')
const TIMEOUT = 30_000

const targets = {
  build: {
    executor: '@acme/tools:run',
    options: { command: 'tsc -b', timeoutMs: 60_000 },
    configurations: { ci: { command: 'tsc -b --force' } },
  },
  serve: { executor: '@acme/tools:run', options: { port: 4200 } },
  other: { executor: '@acme/other:x', options: { a: 1 } },
}
const graph = parseNxGraph(
  JSON.stringify({
    nodes: { a: { name: 'a', data: { root: 'libs/a', targets } } },
    dependencies: {},
  }),
  'g',
)
const meta: ProjectMeta = {
  name: 'a',
  dir: '/w/libs/a',
  packageJson: { name: 'a' } as ProjectMeta['packageJson'],
  configPath: null,
}

async function execs(executors: NxExecutors): Promise<Record<string, Record<string, unknown>>> {
  const mapped = await mapNxWorkspace('/w', [meta], graph, {
    cacheable: new Set(),
    executors,
  })
  return Object.fromEntries(
    mapped.projects[0]!.tasks.map((t) => [t.name, t.task!['exec'] as Record<string, unknown>]),
  )
}

describe('executors: the mapper', () => {
  it('a translation is the command, timeout and env; undefined and unnamed executors stay nx-exec', async () => {
    const seen: unknown[] = []
    const exec = await execs({
      '@acme/tools:run': (t) => {
        seen.push(t)
        return typeof t.options['command'] === 'string'
          ? {
              command: t.options['command'],
              timeout: t.options['timeoutMs'] as number,
              env: { MODE: t.configuration ?? 'default' },
            }
          : undefined
      },
    })
    expect(exec['build']!['command']).toBe('tsc -b')
    expect(exec['build']!['timeout']).toBe(60_000)
    expect((exec['build']!['env'] as { define: Record<string, unknown> }).define['MODE']).toBe(
      'default',
    )
    expect(exec['build:ci']!['command']).toBe('tsc -b --force')
    expect((exec['build:ci']!['env'] as { define: Record<string, unknown> }).define['MODE']).toBe(
      'ci',
    )
    expect(exec['serve']!['command']).toBe(
      `nx-exec @acme/tools:run --project a --target serve --options '{"port":4200}'`,
    )
    expect(exec['serve']!['timeout']).toBeUndefined()
    expect(exec['other']!['command']).toBe(
      `nx-exec @acme/other:x --project a --target other --options '{"a":1}'`,
    )
    expect(seen).toContainEqual({
      executor: '@acme/tools:run',
      project: 'a',
      projectRoot: 'libs/a',
      target: 'build',
      configuration: 'ci',
      options: { command: 'tsc -b --force', timeoutMs: 60_000 },
    })
  })

  it('without the option every executor is an nx-exec line', async () => {
    const exec = await execs({})
    expect(exec['build']!['command']).toBe(
      `nx-exec @acme/tools:run --project a --target build --options '{"command":"tsc -b","timeoutMs":60000}'`,
    )
  })

  for (const [ret, message] of [
    ['x', 'must return { command } or undefined'],
    [{ command: '' }, 'command must be a non-empty string'],
    [{ command: 'x', timeout: 1.5 }, 'timeout must be a positive integer (ms)'],
    [{ command: 'x', env: { A: 1 } }, 'env must map names to strings'],
    [{ command: 'x', cwd: '.' }, 'unknown field "cwd" (allowed: command, env, timeout)'],
  ] as const) {
    it(`refuses a return of ${JSON.stringify(ret)}`, async () => {
      const bad = (() => ret) as unknown as NxExecutors[string]
      const err = await execs({ '@acme/tools:run': bad }).then(
        () => undefined,
        (e: Error) => e.message,
      )
      expect(err).toBe(`nx({ executors }): "@acme/tools:run" for a:build: ${message}`)
    })
  }
})

describe('executors: nx() options', () => {
  it('refuses a built-in executor and a non-function', () => {
    const f = () => undefined
    for (const name of [
      'nx:run-commands',
      'nx:run-script',
      'nx:noop',
      '@nx/workspace:run-commands',
    ])
      expect(() => nx({ executors: { [name]: f } })).toThrow(
        `nx() option "executors": ${JSON.stringify(name)} is translated by nx() itself`,
      )
    expect(() =>
      nx({ executors: { '@acme/x:y': 'tsc' as unknown as NxExecutors[string] } }),
    ).toThrow('nx() option "executors": "@acme/x:y" must be a function')
  })
})

let root: string

function silent(): Logger {
  const noop = () => {}
  return {
    status: noop,
    runStart: noop,
    taskStart: noop,
    taskStdout: noop,
    taskStderr: noop,
    taskComplete: noop,
    runStatus: noop,
    runEnd: noop,
  } as unknown as Logger
}

async function workspace(fn: string): Promise<void> {
  await Bun.write(
    path.join(root, 'vx.workspace.mjs'),
    localWorkspaceSource(
      [`nx({ executors: { '@acme/tools:run': ${fn} } })`],
      `import { nx } from ${JSON.stringify(PLUGIN_INDEX)}\n`,
    ),
  )
}

describe('executors: the plugin', () => {
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'vx-nx-executors-'))
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'ws', private: true }))
    await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
    await writeFile(path.join(root, 'nx.json'), JSON.stringify({ namedInputs: {} }))
    await writeFile(path.join(root, '.gitignore'), 'node_modules\n.vx\n.nx\n')
    const dir = path.join(root, 'packages', 'lib')
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'lib' }))
    await writeFile(
      path.join(root, 'graph.json'),
      JSON.stringify({
        graph: {
          nodes: {
            lib: {
              name: 'lib',
              type: 'lib',
              data: {
                root: 'packages/lib',
                targets: { build: { executor: '@acme/tools:run', options: { command: 'tsc' } } },
              },
            },
          },
          dependencies: { lib: [] },
        },
      }),
    )
    await fakeNx(root)
    await fakeNxCli(root)
    Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root })
    Bun.spawnSync({ cmd: ['git', 'add', '-A'], cwd: root })
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it(
    'plans the translated command, and an edited function re-maps',
    async () => {
      const command = async () =>
        (await planRun({ cwd: root, tasks: ['build'], log: silent() })).tasks[0]!.node.config.exec
          ?.command
      await workspace('(t) => ({ command: t.options.command + " -b" })')
      expect(await command()).toBe('tsc -b')
      // The cached mapping keys on the function's text.
      await workspace('() => undefined')
      expect(await command()).toBe(
        `nx-exec @acme/tools:run --project lib --target build --options '{"command":"tsc"}'`,
      )
    },
    TIMEOUT,
  )
})
