// The `.env` probes were written inline, a shell line in every package's
// cache.inputs.runtime: create-turbo's own `inputs: [..., ".env*"]` put it
// in each config. The preset names them, with why they exist.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { quoteTsLiteral, type ProjectMeta } from '@vzn/vx'
import { DOTENV_PROBE, DOTENV_PROBE_TOP } from '../src/dotenv-probe.js'
import { migrateTurbo } from '../src/migrate-turbo.js'

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-migrate-dotenv-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('migrateTurbo: the .env probes', () => {
  it('are preset exports each config names', async () => {
    await writeFile(
      path.join(root, 'turbo.json'),
      JSON.stringify({
        tasks: {
          build: { inputs: ['$TURBO_DEFAULT$', '.env*'], outputs: [] },
          test: { inputs: ['config/.env', '$TURBO_ROOT$/.env'], outputs: [] },
        },
      }),
    )
    const dir = path.join(root, 'packages', 'a')
    await mkdir(dir, { recursive: true })
    const scripts = { build: 'tsc', test: 'vitest' }
    const metas: ProjectMeta[] = [
      { name: 'a', dir, packageJson: { name: 'a', scripts } as never, configPath: null },
    ]
    const p = await migrateTurbo(root, metas)
    const project = p.projects[0]!
    const runtime = (name: string) => {
      const t = project.tasks.find((x) => x.name === name)!.task as {
        cache: { inputs: { runtime?: unknown; workspaceRuntime?: unknown } }
      }
      return [t.cache.inputs.runtime, t.cache.inputs.workspaceRuntime]
    }
    const preset = p.extraFiles.find((f) => f.relPath === 'vx-preset.ts')!.contents
    expect({
      build: runtime('build'),
      test: runtime('test'),
      imports: project.importLines,
      exports: preset.split('\n').filter((l) => l.startsWith('export const')),
    }).toEqual({
      build: [[{ raw: 'dotenvFiles' }], undefined],
      test: [[{ raw: 'dotenvFilesDeep' }], [{ raw: 'dotenvFilesDeep' }]],
      imports: ["import { dotenvFiles, dotenvFilesDeep } from '../../vx-preset.js'"],
      exports: [
        `export const dotenvFiles = ${quoteTsLiteral(DOTENV_PROBE_TOP)}`,
        `export const dotenvFilesDeep = ${quoteTsLiteral(DOTENV_PROBE)}`,
      ],
    })
  })
})
