// `{ dependentTasksOutputFiles }` hashes the outputs of the tasks a target
// depends on; vx folds those tasks' keys through `dependsOn`. With the
// producer not migrated (nx-examples' .NET ProductsApi, no dotnet on the
// box) the codegen kept no edge, keyed nothing it reads, and replayed the
// old generated client after the OpenAPI document changed (Growth round 2).
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import type { PackageMeta } from '../src/packages.js'
import { mapNxWorkspace, type NxGraph } from '../src/nx/nx-map.js'

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-nx-dependent-outputs-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function meta(name: string): Promise<PackageMeta> {
  const dir = path.join(root, 'libs', name)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name }))
  return { name, dir, packageJson: { name } as never, configPath: null }
}

const codegen = {
  command: 'openapi-ts',
  cache: true,
  inputs: [{ dependentTasksOutputFiles: '**/obj/ProductsApi.json' }],
  dependsOn: [{ target: 'build', projects: ['products-api'] }],
  outputs: ['{projectRoot}/src/generated'],
}

async function codegenTask(withProducer: boolean) {
  const metas = [await meta('types'), ...(withProducer ? [await meta('products-api')] : [])]
  const nodes: Record<string, unknown> = {
    types: { data: { root: 'libs/types', targets: { codegen } } },
  }
  if (withProducer)
    nodes['products-api'] = {
      data: { root: 'libs/products-api', targets: { build: { command: 'b', cache: true } } },
    }
  const m = await mapNxWorkspace(root, metas, { nodes, dependencies: {} } as NxGraph, {
    cacheable: new Set(),
  })
  return m.projects.find((p) => p.name === 'types')!.tasks.find((t) => t.name === 'codegen')!
}

it('a reader of dependency outputs whose producer is not migrated runs uncached and says why', async () => {
  const t = await codegenTask(false)
  expect(t.task!['cache']).toBeUndefined()
  expect(t.todos).toContain(
    'reads `**/obj/ProductsApi.json` from the outputs of the tasks it depends on, and no task it depends on is migrated (dependsOn [{"target":"build","projects":["products-api"]}]) — uncached here, so it never replays output generated from an older input; migrate the producer and depend on it to cache this task',
  )
})

it('control: with the producer migrated, the edge folds its key and the reader stays cached', async () => {
  const t = await codegenTask(true)
  expect(t.task!['dependsOn']).toEqual(['products-api#build'])
  expect(t.task!['cache']).toBeDefined()
  expect(t.todos.join('\n')).not.toContain('dependsOn')
})
