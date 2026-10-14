// Turbo leaves an output in place while its producer runs, so a task
// whose inputs read it with no edge sees the last run's bytes. vx cleans
// it first: vueuse's builds import `packages/metadata/index.json`, which
// `@vueuse/metadata#update` writes, and every build failed on a cold
// cache. A reader of another task's one-file output now waits for it.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import type { ProjectMeta } from '@vzn/vx'
import { mapTurboWorkspace } from '../src/turbo/turbo-map.js'

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-turbo-reader-order-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function pkg(name: string, scripts: Record<string, string>, turbo?: object) {
  const dir = path.join(root, 'packages', name)
  await mkdir(dir, { recursive: true })
  if (turbo !== undefined) await writeFile(path.join(dir, 'turbo.json'), JSON.stringify(turbo))
  return {
    name,
    dir,
    packageJson: { name, scripts } as never,
    configPath: null,
  } satisfies ProjectMeta
}

it("a reader of another task's one-file output waits for it; a dist glob orders nothing", async () => {
  await writeFile(
    path.join(root, 'turbo.json'),
    JSON.stringify({
      globalDependencies: ['packages/metadata/**', 'packages/core/**'],
      tasks: { build: { outputs: ['dist/**'] } },
    }),
  )
  const metas = [
    await pkg(
      'metadata',
      { update: 'node update.js', build: 'tsdown' },
      {
        extends: ['//'],
        tasks: { build: { dependsOn: ['update'] }, update: { outputs: ['index.json'] } },
      },
    ),
    await pkg('core', { build: 'tsdown' }),
    await pkg('components', { build: 'tsdown' }),
  ]
  const m = await mapTurboWorkspace(root, metas, { splice: (_k, v) => v, persistentTodo: 'P' })
  const deps = Object.fromEntries(
    m.projects.flatMap((p) =>
      p.tasks.map((t) => [`${p.name}#${t.name}`, t.task?.['dependsOn'] ?? []]),
    ),
  )
  expect(deps).toEqual({
    'metadata#update': [],
    'metadata#build': ['update'],
    'core#build': ['metadata#update'],
    'components#build': ['metadata#update'],
  })
  expect(m.notes.filter((n) => n.includes('wait for'))).toEqual([
    'core#build, components#build wait for metadata#update: their inputs read its outputs, which vx cleans before it runs where Turbo leaves the last ones in place',
  ])
})
