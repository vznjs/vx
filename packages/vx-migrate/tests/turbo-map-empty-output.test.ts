// Turbo joins an output to the package directory and collects files: `""`
// (graphql-hive's `check:build` writes `"outputs": [""]`) selects nothing
// there. It mapped to `"."`, which core refuses as naming the project
// directory, so `vx lock` refused every config the migration wrote.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { PackageMeta } from '../src/packages.js'
import { mapTurboWorkspace } from '../src/turbo/turbo-map.js'
import { ownSplice } from './helpers/turbo-own.js'

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-turbo-empty-output-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function outputsOf(outputs: string[]): Promise<unknown[]> {
  await writeFile(path.join(root, 'turbo.json'), JSON.stringify({ tasks: { check: { outputs } } }))
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
  const m = await mapTurboWorkspace(root, metas, { splice: ownSplice, persistentTodo: 'P' })
  return (m.projects[0]!.tasks[0]!.task as { outputs: { files: unknown[] } }).outputs.files
}

describe('turbo-map: an output naming the package directory itself', () => {
  it('`""` maps to no output, as Turbo collects no file for it', async () => {
    expect(await outputsOf([''])).toEqual([])
  })

  it('`"."` and `"./"` beside a real output keep only the real one', async () => {
    const files = await outputsOf(['.', './', 'dist/**'])
    expect(files).not.toContain('.')
    expect(files).toContain('dist/**')
  })
})
