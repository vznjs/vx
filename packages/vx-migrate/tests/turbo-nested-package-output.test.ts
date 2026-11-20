// trpc's `examples-minimal-react#build` outputs `client/dist/**` and
// `server/dist/**`, the builds of its nested `client` and `server`
// packages. Written into `outputs.files`, the path lay in another project,
// which core refuses: init wrote no lock.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { PackageMeta } from '../src/packages.js'
import { migrateTurbo } from '../src/migrate-turbo.js'

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-migrate-nested-out-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('migrateTurbo: an output inside a nested package', () => {
  it('is named from the workspace root; the package keeps its own outputs', async () => {
    await writeFile(
      path.join(root, 'turbo.json'),
      JSON.stringify({
        tasks: {
          build: { outputs: ['dist/**'] },
          'app#build': { outputs: ['client/dist/**', 'dist/**', '!client/dist/cache/**'] },
        },
      }),
    )
    const app = path.join(root, 'app')
    const client = path.join(app, 'client')
    await mkdir(client, { recursive: true })
    const meta = (name: string, dir: string): PackageMeta => ({
      name,
      dir,
      packageJson: { name, scripts: { build: 'tsc' } } as never,
      configPath: null,
    })
    const plan = await migrateTurbo(root, [meta('app', app), meta('client', client)])
    const outputs = (name: string) =>
      (
        plan.projects.find((p) => p.name === name)!.tasks.find((t) => t.name === 'build')!.task as {
          outputs: unknown
        }
      ).outputs
    expect(outputs('app')).toEqual({
      files: ['dist/**'],
      workspaceFiles: ['app/client/dist/**', '!app/client/dist/cache/**'],
    })
  })
})
