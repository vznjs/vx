// A script that is nothing but `wireit` maps from its wireit config:
// lit's members declare every task there, and init wrote each as the
// command `wireit`, a second runner with its own cache under vx's.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'bun:test'
import { migrateScripts } from '../src/workspace/migrate-scripts.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')

const meta = (name: string, dir: string, pkg: Record<string, unknown>) => ({
  name,
  dir,
  packageJson: { name, ...pkg } as never,
  configPath: null,
})

it('maps command, dependencies, files, output, env and service', () => {
  const plan = migrateScripts(
    [
      meta('lib', '/w/packages/lib', {
        scripts: { build: 'wireit' },
        wireit: { build: { command: 'tsc', files: ['src/**'], output: ['lib/**'] } },
      }),
      meta('app', '/w/packages/app', {
        scripts: {
          build: 'wireit',
          test: 'wireit',
          serve: 'wireit',
          odd: 'wireit',
          plain: 'vite build',
        },
        wireit: {
          build: {
            command: 'rollup -c',
            dependencies: ['../lib:build', { script: 'plain', cascade: false }, 'nope'],
            files: ['src/**', '!src/**/*.test.ts', '../../rollup-common.js', '../lib/src/x.ts'],
            output: ['dist/**'],
            env: { MODE: 'prod', BROWSERS: { external: true } },
            clean: false,
          },
          test: { dependencies: ['build'] },
          serve: {
            command: 'node s.js',
            service: { readyWhen: { lineMatches: 'ready' } },
            files: ['s.js'],
            output: [],
          },
          odd: { command: 'x', files: ['a'], weird: 1 },
        },
      }),
    ],
    { name: 'root' },
    '/w',
  )
  const app = Object.fromEntries(
    plan.projects.find((p) => p.name === 'app')!.tasks.map((t) => [t.name, t]),
  )
  expect(app['build']!.task).toEqual({
    exec: { command: 'rollup -c', env: { define: { MODE: 'prod' }, passThrough: ['BROWSERS'] } },
    dependsOn: ['lib#build', 'plain'],
    cache: {
      inputs: {
        files: ['src/**', '!src/**/*.test.ts'],
        workspaceFiles: ['rollup-common.js'],
        env: ['BROWSERS'],
      },
      outputs: { files: ['dist/**'] },
    },
  })
  expect(app['build']!.todos).toEqual([
    'wireit\'s `cascade: false` on "plain" only ordered the two; vx folds the dependency\'s key, so this task re-runs when it changes',
    'wireit dependency "nope" names no script here; add its edge by hand',
    'wireit file "../lib/src/x.ts" reaches outside this package into another member, which a vx task may not read or write; declare that task under dependsOn instead',
    "wireit kept this script's outputs between runs (`clean: false`); vx deletes declared outputs before running",
  ])
  expect(app['test']!.task).toEqual({ dependsOn: ['build'] })
  // A service is persistent and caches nothing.
  expect(app['serve']!.task).toEqual({
    exec: { command: 'node s.js', persistent: { readyWhen: 'ready' } },
  })
  expect(app['odd']!.todos).toEqual([
    'wireit skipped this script when its `files` were unchanged; vx caches only with `output` declared — add a cache block with its outputs',
    'wireit field "weird" has no vx spelling here',
  ])
  // CONTROL: a script that is not just `wireit` maps as a command.
  expect(app['plain']!.task).toEqual({ exec: { command: 'vite build' } })
})

it('maps a wireit-only script another depends on, at a member, not at the root', () => {
  const plan = migrateScripts([
    {
      name: 'root',
      dir: '/w',
      packageJson: {
        name: 'root',
        scripts: { lint: 'eslint .' },
        wireit: { extra: { command: 'x' } },
      } as never,
      configPath: null,
    },
    {
      name: 'a',
      dir: '/w/packages/a',
      packageJson: {
        name: 'a',
        scripts: { test: 'wireit' },
        wireit: {
          test: { dependencies: ['test:ts5'] },
          // No `scripts` entry: run only as test's dependency (lit's tests-typescript).
          'test:ts5': { command: 'tsc --noEmit' },
        },
      } as never,
      configPath: null,
    },
  ])
  const tasks = (n: string) =>
    Object.fromEntries(plan.projects.find((p) => p.name === n)!.tasks.map((t) => [t.name, t.task]))
  expect(tasks('a')).toEqual({
    test: { dependsOn: ['test:ts5'] },
    'test:ts5': { exec: { command: 'tsc --noEmit' } },
  })
  expect(Object.keys(tasks('root'))).toEqual(['lint'])
})

it('the mapped tasks run, and the second run hits', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vx-wireit-'))
  try {
    await writeFile(
      path.join(root, 'package.json'),
      '{ "name": "r", "workspaces": ["packages/*"] }',
    )
    const pkg = (name: string, wireit: object) =>
      writeFile(
        path.join(root, 'packages', name, 'package.json'),
        JSON.stringify({ name, scripts: { build: 'wireit' }, wireit: { build: wireit } }),
      )
    for (const n of ['lib', 'app'])
      await mkdir(path.join(root, 'packages', n, 'src'), { recursive: true })
    await writeFile(path.join(root, 'packages', 'lib', 'src', 'a.txt'), 'a\n')
    await writeFile(path.join(root, 'packages', 'app', 'src', 'b.txt'), 'b\n')
    await pkg('lib', {
      command: 'mkdir -p out && cp src/a.txt out/',
      files: ['src/**'],
      output: ['out/**'],
    })
    await pkg('app', {
      command: 'mkdir -p out && cp src/b.txt out/',
      dependencies: ['../lib:build'],
      files: ['src/**'],
      output: ['out/**'],
    })
    const vx = (...args: string[]) =>
      Bun.spawnSync([process.execPath, BIN, ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' })
    Bun.spawnSync(['git', 'init', '-q'], { cwd: root })
    expect(vx('init').exitCode).toBe(0)
    const statuses = () => {
      const r = vx('run', 'build', '--all')
      expect(r.exitCode).toBe(0)
      const last = JSON.parse(vx('last', '--format', 'json').stdout.toString()) as {
        tasks: { project: string; status: string }[]
      }
      return Object.fromEntries(last.tasks.map((t) => [t.project, t.status]))
    }
    expect(statuses()).toEqual({ lib: 'success', app: 'success' })
    expect(statuses()).toEqual({ lib: 'cache-hit', app: 'cache-hit' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 60_000)
