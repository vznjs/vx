// clerk's root integration tasks list `env: ["E2E_*"]`. Core takes a `*`
// env name as written and matches it each run, as Turbo does, so a written
// config keeps the pattern: nothing stands in for the run's environment.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, it } from 'bun:test'
import type { PackageMeta } from '../src/packages.js'
import { migrateTurbo } from '../src/migrate-turbo.js'

it('a task `*` env name is kept as written, in inputs.env or passThrough', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'vx-migrate-envwild-'))
  try {
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'ws', private: true, scripts: { e2e: 'playwright test' } }),
    )
    await writeFile(
      path.join(root, 'turbo.json'),
      JSON.stringify({
        tasks: {
          '//#e2e': { env: ['E2E_APP_*'] },
          build: { env: ['A_*', '!A_SECRET', 'B-*'], outputs: [] },
          lint: { passThroughEnv: ['B_*'], outputs: [] },
        },
      }),
    )
    const dir = path.join(root, 'packages', 'a')
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'index.ts'), 'export const k = process.env.A_KEY\n')
    Bun.spawnSync(['git', 'init', '-q'], { cwd: root })
    Bun.spawnSync(['git', 'add', '-A'], { cwd: root })
    const scripts = { build: 'tsc', lint: 'eslint .' }
    const metas: PackageMeta[] = [
      { name: 'a', dir, packageJson: { name: 'a', scripts } as never, configPath: null },
    ]
    const p = await migrateTurbo(root, metas)
    const task = (pkg: string, name: string) =>
      p.projects.find((x) => x.name === pkg)!.tasks.find((t) => t.name === name)!
    const of = (pkg: string, name: string) =>
      task(pkg, name).task as {
        inputs: { env?: unknown }
        exec: { env?: { passThrough?: unknown } }
      }
    expect({
      e2e: of('ws', 'e2e').inputs.env,
      build: of('a', 'build').inputs.env,
      buildPass: of('a', 'build').exec.env?.passThrough,
      buildTodos: task('a', 'build').todos,
      lintPass: of('a', 'lint').exec.env?.passThrough,
      lintTodos: task('a', 'lint').todos,
    }).toEqual({
      e2e: ['E2E_APP_*'],
      build: ['A_*'],
      buildPass: undefined,
      buildTodos: [
        'env "B-*": a vx env pattern is letters, digits, _ and * — list the names instead',
        'env "!A_SECRET": vx has no exclusion, so "A_*" still takes A_SECRET — narrow the pattern to leave it out',
      ],
      lintPass: ['B_*'],
      lintTodos: [],
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// assistant-ui's turbo.json lists "ASSISTANT_*" twice under one task's env.
it('a `*` env name listed twice is one entry', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'vx-migrate-envwild2-'))
  try {
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'ws', private: true }))
    await writeFile(
      path.join(root, 'turbo.json'),
      JSON.stringify({ tasks: { build: { env: ['C_*', 'D', 'C_*', 'D'], outputs: [] } } }),
    )
    const dir = path.join(root, 'packages', 'a')
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'index.ts'), 'export const k = 1\n')
    Bun.spawnSync(['git', 'init', '-q'], { cwd: root })
    Bun.spawnSync(['git', 'add', '-A'], { cwd: root })
    const metas: PackageMeta[] = [
      {
        name: 'a',
        dir,
        packageJson: { name: 'a', scripts: { build: 'tsc' } } as never,
        configPath: null,
      },
    ]
    const p = await migrateTurbo(root, metas)
    const build = p.projects.find((x) => x.name === 'a')!.tasks.find((t) => t.name === 'build')!
    expect({
      todos: build.todos,
      env: (build.task as { inputs: { env?: unknown } }).inputs.env,
    }).toEqual({ todos: [], env: ['C_*', 'D'] })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
