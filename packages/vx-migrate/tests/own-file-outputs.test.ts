// An output glob that covers a project's own package.json: Turbo caches it
// (trpc's client build lists `package.json`, ec0b0a4), core refuses the
// config. The mappers run such a task uncached; the copy of core's rule in
// shared-outputs.ts is held to the loader in both directions.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { loadProjectConfig, type ProjectMeta } from '@vzn/vx'
import { mapNxWorkspace, type NxGraph } from '../src/nx/nx-map.js'
import { ownFileOutput } from '../src/shared-outputs.js'
import { mapTurboWorkspace } from '../src/turbo/turbo-map.js'

let root: string

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-own-file-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const TODO =
  'output "package.json" covers the project\'s own package.json, which vx cleans before every run — task runs uncached; declare the outputs without it in a vx.config to cache it'

async function pkg(name: string, scripts: Record<string, string>): Promise<ProjectMeta> {
  const dir = path.join(root, 'packages', name)
  await mkdir(dir, { recursive: true })
  const packageJson = { name, scripts }
  await writeFile(path.join(dir, 'package.json'), JSON.stringify(packageJson))
  return { name, dir, packageJson: packageJson as never, configPath: null }
}

describe('an output that covers the project’s own package.json', () => {
  it('agrees with the loader on which globs it refuses', async () => {
    const dir = path.join(root, 'p')
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'package.json'), '{"name":"p"}')
    const globs = [
      'package.json',
      './package.json',
      '*.json',
      '*',
      '**',
      '**/*',
      'vx.config.mjs',
      '*.mjs',
      '{package,other}.json',
      'dist/**',
      'dist',
      'package.json.bak',
      'src/**/*.json',
    ]
    const loader: Record<string, boolean> = {}
    const copy: Record<string, boolean> = {}
    for (const g of globs) {
      const file = path.join(dir, 'vx.config.mjs')
      await writeFile(
        file,
        `export default {
  tasks: {
    build: {
      exec: { command: 'b' },
      cache: { inputs: { files: ['src/**'] }, outputs: { files: [${JSON.stringify(g)}] } },
    },
  },
}
`,
      )
      loader[g] = await loadProjectConfig(file).then(
        () => false,
        (e: Error) => e.message.includes("covers the project's own"),
      )
      copy[g] = ownFileOutput([g]) !== undefined
    }
    expect(copy).toEqual(loader)
    expect(Object.values(loader).filter(Boolean).length).toBe(9)
  })

  it('also flags a vx.config name the project does not have yet', () => {
    // Core checks the config file the project has; a mapped task lands in
    // one a user may add later, so the copy names every spelling.
    expect(ownFileOutput(['vx.config.ts'])).toEqual({
      glob: 'vx.config.ts',
      file: 'vx.config.ts',
    })
    expect(ownFileOutput(['!package.json', 'dist/**'])).toBeUndefined()
  })

  it('with the config file named, only it and package.json are the project’s own', () => {
    expect(ownFileOutput(['*.js'], null)).toBeUndefined()
    expect(ownFileOutput(['*.js'], 'vx.config.ts')).toBeUndefined()
    expect(ownFileOutput(['*.js'], 'vx.config.js')).toEqual({ glob: '*.js', file: 'vx.config.js' })
    expect(ownFileOutput(['*.json'], null)).toEqual({ glob: '*.json', file: 'package.json' })
  })

  it('turbo(): the task runs uncached with a todo, and the workspace loads', async () => {
    await writeFile(path.join(root, 'turbo.json'), JSON.stringify({ tasks: { build: {} } }))
    const a = await pkg('a', { build: 'tsdown' })
    await writeFile(
      path.join(a.dir, 'turbo.json'),
      JSON.stringify({
        extends: ['//'],
        tasks: { build: { outputs: ['package.json', 'dist/**'] } },
      }),
    )
    const m = await mapTurboWorkspace(root, [a], {
      splice: (_k: string, v: readonly string[]) => v,
      persistentTodo: 'PERSIST',
    })
    const t = m.projects[0]!.tasks[0]!
    expect([t.name, t.task?.['cache'], t.todos]).toEqual(['build', undefined, [TODO]])
  })

  it('nx(): a cached target runs uncached with a todo', async () => {
    const a = await pkg('a', { build: 'tsdown' })
    const m = await mapNxWorkspace(
      root,
      [a],
      {
        nodes: {
          a: {
            data: {
              root: 'packages/a',
              targets: {
                build: {
                  executor: 'nx:run-script',
                  options: { script: 'build' },
                  outputs: ['{projectRoot}/package.json', '{projectRoot}/dist'],
                  cache: true,
                },
              },
            },
          },
        },
        dependencies: {},
      } as NxGraph,
      { persistentTodo: 'PERSIST', cacheable: new Set<string>() },
    )
    const t = m.projects[0]!.tasks.find((x) => x.name === 'build')!
    expect(t.task?.['cache']).toBeUndefined()
    expect(t.todos).toContain(TODO)
  })
})
