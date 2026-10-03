// clerk's root integration tasks list `env: ["E2E_*"]`; a written config
// cannot ask the run's environment, so the entry was dropped with a TODO
// in each of 24 configs and the tests ran without their variables. The
// names the task's package (the whole repo, for a root task) spells
// stand in, as for a framework prefix.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, it } from 'bun:test'
import type { ProjectMeta } from '@vzn/vx'
import { migrateTurbo } from '../src/migrate-turbo.js'

it('a task `*` env name lists what its package spells; one nothing spells stays a todo', async () => {
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
          build: { env: ['A_*'], outputs: [] },
          lint: { passThroughEnv: ['B_*'], outputs: [] },
        },
      }),
    )
    await mkdir(path.join(root, 'integration'), { recursive: true })
    await writeFile(
      path.join(root, 'integration', 'setup.ts'),
      'const keys = Object.keys(process.env).filter((k) => k.startsWith("E2E_APP_"))\n' +
        'export const app = process.env.E2E_APP_ID\n',
    )
    const dir = path.join(root, 'packages', 'a')
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'index.ts'), 'export const k = process.env.A_KEY\n')
    Bun.spawnSync(['git', 'init', '-q'], { cwd: root })
    Bun.spawnSync(['git', 'add', '-A'], { cwd: root })
    const scripts = { build: 'tsc', lint: 'eslint .' }
    const metas: ProjectMeta[] = [
      { name: 'a', dir, packageJson: { name: 'a', scripts } as never, configPath: null },
    ]
    const p = await migrateTurbo(root, metas)
    const task = (pkg: string, name: string) =>
      p.projects.find((x) => x.name === pkg)!.tasks.find((t) => t.name === name)!
    const env = (pkg: string, name: string) =>
      (task(pkg, name).task as { cache?: { inputs: { env?: unknown } } }).cache?.inputs.env
    expect({
      e2e: env('ws', 'e2e'),
      build: env('a', 'build'),
      lintTodos: task('a', 'lint').todos,
      notes: p.notes.filter((n) => n.startsWith('env ')),
    }).toEqual({
      e2e: ['E2E_APP_ID'],
      build: ['A_KEY'],
      lintTodos: ['passThroughEnv "B_*": wildcards are not supported — list explicit names'],
      notes: [
        'env "A_*": the configs list the names the files of each task\'s package and its workspace dependencies spell (1 task) — add any other a task reads to cache.inputs.env and exec.env.passThrough',
        'env "E2E_APP_*": the configs list the names the files of each task\'s package and its workspace dependencies spell (1 task) — add any other a task reads to cache.inputs.env and exec.env.passThrough',
      ],
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
