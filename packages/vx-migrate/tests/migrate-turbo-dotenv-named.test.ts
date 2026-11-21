// The `.env` probes were written inline, a shell line in every package's
// inputs.runtime: create-turbo's own `inputs: [..., ".env*"]` put it
// in each config. Each config names the ones it uses at its top.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { quoteTsLiteral } from '@vzn/vx'
import type { PackageMeta } from '../src/packages.js'
import { DOTENV_PROBE, DOTENV_PROBE_TOP, dotenvGlobsProbe } from '../src/dotenv-probe.js'
import { migrateTurbo } from '../src/migrate-turbo.js'

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-migrate-dotenv-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('migrateTurbo: the .env probes', () => {
  it('are named once at the top of the config that uses them', async () => {
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
    const metas: PackageMeta[] = [
      { name: 'a', dir, packageJson: { name: 'a', scripts } as never, configPath: null },
    ]
    const p = await migrateTurbo(root, metas)
    const project = p.projects[0]!
    const runtime = (name: string) => {
      const t = project.tasks.find((x) => x.name === name)!.task as {
        inputs: { runtime?: unknown; workspaceRuntime?: unknown }
      }
      return [t.inputs.runtime, t.inputs.workspaceRuntime]
    }
    expect({
      build: runtime('build'),
      test: runtime('test'),
      decls: project.importLines,
      extraFiles: p.extraFiles,
    }).toEqual({
      build: [[{ raw: 'dotenvFiles' }], undefined],
      test: [[{ raw: 'dotenvFilesDeep' }], [{ raw: 'dotenvRootFiles' }]],
      decls: [
        `const dotenvFiles = ${quoteTsLiteral(DOTENV_PROBE_TOP)}`,
        `const dotenvFilesDeep = ${quoteTsLiteral(DOTENV_PROBE)}`,
        `const dotenvRootFiles = ${quoteTsLiteral(dotenvGlobsProbe(['.env'])!)}`,
      ],
      extraFiles: [],
    })
  })
})
