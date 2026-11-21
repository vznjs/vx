// Turbo reads `""`, `"."` and `"./"` as the package directory: as an output
// it caches and restores every file in the package, as an input it hashes
// every package file (checked on turbo 2.11.10). graphql-hive's `check:build`
// writes `"outputs": [""]`. It mapped to `"."`, which core refuses as naming
// the project directory, so `vx lock` refused every config the migration
// wrote; mapped to no output, a hit restored nothing. `**` and `**/*` beside
// the default inputs were refused as the task's own sources; `*/**` (and its
// zero-segment `*`) names the same files and core takes it.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { PackageMeta } from '../src/packages.js'
import { trackedKinds } from '../src/tracked-outputs.js'
import { mapTurboWorkspace } from '../src/turbo/turbo-map.js'
import { ownSplice } from './helpers/turbo-own.js'

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-turbo-empty-output-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function taskOf(def: Record<string, unknown>): Promise<{
  todos: string[]
  task: { inputs: { files: string[] }; outputs?: unknown; cache?: unknown }
}> {
  await writeFile(path.join(root, 'turbo.json'), JSON.stringify({ tasks: { check: def } }))
  const dir = path.join(root, 'packages', 'a')
  await mkdir(dir, { recursive: true })
  const metas: PackageMeta[] = [
    {
      name: 'a',
      dir,
      packageJson: { name: 'a', scripts: { check: 'bob check' } } as never,
      configPath: null,
    },
  ]
  const m = await mapTurboWorkspace(root, metas, {
    splice: ownSplice,
    persistentTodo: 'P',
    tracked: trackedKinds(['packages/a/package.json', 'packages/a/src/a.ts']),
  })
  return m.projects[0]!.tasks[0]! as never
}

describe('turbo-map: a glob naming the package directory itself', () => {
  for (const g of ['', '.', './', '**', '**/*', './**'])
    it(`output ${JSON.stringify(g)} is every file in the package, as \`*/**\` and \`*\``, async () => {
      const t = await taskOf({ outputs: [g] })
      expect(t.task.cache).toBe(true)
      const files = (t.task.outputs as { files: string[] }).files
      expect(files.slice(0, 2)).toEqual(['*', '*/**'])
      // The manifest stays, as for any output over it.
      expect(files).toContain('!package.json')
    })

  for (const g of ['', '.', './'])
    it(`input ${JSON.stringify(g)} is every package file`, async () => {
      const files = (await taskOf({ inputs: [g], outputs: [] })).task.inputs.files
      expect(files).toContain('**/*')
      expect(files).not.toContain('.')
      expect(files).not.toContain('./')
    })
})
