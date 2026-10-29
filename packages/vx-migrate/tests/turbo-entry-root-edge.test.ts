// `deploy: { dependsOn: ["web#build", "//#format"] }` with no `deploy`
// script anywhere: `turbo run deploy` runs web's build and the root's
// format. An entry group keeps a `pkg#task` edge in pkg alone, and the
// root has no such group, so `//#format` was dropped in silence.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import type { PackageMeta } from '../src/packages.js'
import { mapTurboWorkspace } from '../src/turbo/turbo-map.js'

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-turbo-entry-root-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function map(turbo: unknown, rootScripts: Record<string, string>) {
  await writeFile(path.join(root, 'turbo.json'), JSON.stringify(turbo))
  const web = path.join(root, 'packages', 'web')
  await mkdir(web, { recursive: true })
  const metas: PackageMeta[] = [
    {
      name: 'web',
      dir: web,
      packageJson: { name: 'web', scripts: { build: 'b' } } as never,
      configPath: null,
    },
    {
      name: 'mono',
      dir: root,
      packageJson: { name: 'mono', scripts: rootScripts } as never,
      configPath: null,
    },
  ]
  const m = await mapTurboWorkspace(root, metas, {
    splice: (_k, v) => v,
    persistentTodo: 'PERSIST',
  })
  return (p: string) =>
    Object.fromEntries(
      m.projects
        .find((x) => x.name === p)!
        .tasks.map((t) => [t.name, t.task === null ? t.todos : t.task['dependsOn']]),
    )
}

it("an entry task's `//#task` edge runs from the root's own group", async () => {
  const tasks = await map(
    {
      tasks: {
        build: {},
        '//#format': { cache: false },
        deploy: { dependsOn: ['web#build', '//#format'] },
      },
    },
    { format: 'f' },
  )
  expect([tasks('web'), tasks('mono')]).toEqual([
    { build: undefined, deploy: ['build'] },
    { format: undefined, deploy: ['format'] },
  ])
})

it('CONTROL: a root that defines the entry name itself keeps its own task', async () => {
  const tasks = await map(
    {
      tasks: {
        build: {},
        '//#format': { cache: false },
        '//#deploy': {},
        deploy: { dependsOn: ['web#build', '//#format'] },
      },
    },
    { format: 'f', deploy: 'd' },
  )
  expect(tasks('mono')).toEqual({ format: undefined, deploy: undefined })
})
