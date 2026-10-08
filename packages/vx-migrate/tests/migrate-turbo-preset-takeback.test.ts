// opencode's root depends on `@opencode-ai/plugin`, whose `build` outputs
// `dist/**`; Turbo hashes the package into every task (G-133), and the
// written configs read it as `...globalInputs`. The take-back pass saw the
// spread as no glob, so no `!packages/plugin/dist/**` was written and core
// refused to load the configs: a task's key must not read another's outputs.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { ProjectMeta } from '@vzn/vx'
import { migrateTurbo } from '../src/migrate-turbo.js'

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-migrate-takeback-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('migrateTurbo: a root dependency with outputs', () => {
  it("takes its outputs back after the preset spread in every other task's inputs", async () => {
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'ws', private: true, devDependencies: { lib: 'workspace:*' } }),
    )
    await writeFile(
      path.join(root, 'turbo.json'),
      JSON.stringify({ tasks: { build: { dependsOn: ['^build'], outputs: ['dist/**'] } } }),
    )
    const metas: ProjectMeta[] = []
    for (const name of ['lib', 'app']) {
      const dir = path.join(root, 'packages', name)
      await mkdir(dir, { recursive: true })
      const packageJson = { name, scripts: { build: 'tsc' } }
      metas.push({ name, dir, packageJson: packageJson as never, configPath: null })
    }
    const p = await migrateTurbo(root, metas)
    const ws = (name: string) =>
      (
        p.projects.find((x) => x.name === name)!.tasks.find((t) => t.name === 'build')!.task as {
          cache: { inputs: { workspaceFiles: unknown[] } }
        }
      ).cache.inputs.workspaceFiles
    expect(ws('app')).toEqual([{ raw: '...globalInputs' }, '!packages/lib/dist/**'])
    expect(p.extraFiles.find((f) => f.relPath === 'vx-preset.ts')!.contents).toContain(
      "export const globalInputs = ['packages/lib/**']",
    )
  })
})
