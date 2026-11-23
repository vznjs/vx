// The adopted tool's run-wide settings in the `.vx/workspace.ts` a migration
// writes. Native Turbo migration wrote neither turbo.json's `concurrency`
// nor its `boundaries`, nor named `cacheDir`, and native Nx migration none of the ESLint
// module boundaries `nx()` checks live: once migrated, a repo ran on every
// core and checked no boundary, with no word said.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { WorkspaceConfig } from '@vzn/vx/config'
import { turboBoundaryRules } from '../src/dependency-rules.js'
import { turbo } from '../src/index.js'

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-migrate-ws-rules-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const migrate = async (): Promise<string> => {
  const proc = Bun.spawn([process.execPath, '--no-install', BIN, '--no-install'], {
    cwd: root,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const out = await new Response(proc.stdout).text()
  const err = await new Response(proc.stderr).text()
  expect({ code: await proc.exited, err }).toEqual({ code: 0, err: '' })
  return out
}

/** The written workspace file's `run` and `cache` fields, evaluated (its plugin imports are not installed here). */
const fields = async (): Promise<Pick<WorkspaceConfig, 'run' | 'cache'>> => {
  const ws = await readFile(path.join(root, '.vx/workspace.ts'), 'utf8')
  const lines = [...ws.matchAll(/^ {2}(run|cache): .*,$/gm)].map((m) => m[0])
  const file = path.join(root, `fields-${Bun.hash(ws)}.mjs`)
  await writeFile(file, `export default {\n${lines.join('\n')}\n}\n`)
  return ((await import(file)) as { default: Pick<WorkspaceConfig, 'run' | 'cache'> }).default
}

const BOUNDARIES = {
  tags: {
    web: { dependencies: { deny: ['internal'] } },
    lib: { dependencies: { allow: ['lib', 'shared'] } },
    internal: { dependents: { deny: ['public'], allow: ['ops'] } },
  },
}

describe('turbo.json boundaries', () => {
  it('maps dependencies and dependents.deny; names dependents.allow', () => {
    expect(turboBoundaryRules({ boundaries: BOUNDARIES })).toEqual({
      rules: [
        { from: 'tag:web', deny: ['tag:internal'] },
        { from: 'tag:lib', allow: ['tag:lib', 'tag:shared'] },
        { from: 'tag:public', deny: ['tag:internal'] },
      ],
      gaps: [
        `turbo.json boundaries.tags.internal.dependents.allow ["ops"]: vx rules say what a project may depend on, not who may depend on it — add deny: ['tag:internal'] to the rule of each other tag`,
      ],
    })
    // CONTROL: none, no tags, or a list Turbo refuses (its indexes are no tags).
    expect([
      turboBoundaryRules({}),
      turboBoundaryRules({ boundaries: {} }),
      turboBoundaryRules({ boundaries: { tags: [{ dependencies: { deny: ['x'] } }] } }),
    ]).toEqual([
      { rules: [], gaps: [] },
      { rules: [], gaps: [] },
      { rules: [], gaps: [] },
    ])
  })
})

describe('turbo(): live', () => {
  it('applies boundaries, unless the workspace sets them; leaves the cache dir to vx', async () => {
    await writeFile(
      path.join(root, 'turbo.json'),
      JSON.stringify({ boundaries: BOUNDARIES, cacheDir: '.cache/turbo', tasks: {} }),
    )
    const staged = async (ws: WorkspaceConfig) => {
      await turbo().config!(ws, { workspaceRoot: root, warn: () => {}, setBranch: () => {} })
      return ws
    }
    expect(await staged({})).toEqual({
      run: {
        rules: {
          dependencies: [
            { from: 'tag:web', deny: ['tag:internal'] },
            { from: 'tag:lib', allow: ['tag:lib', 'tag:shared'] },
            { from: 'tag:public', deny: ['tag:internal'] },
          ],
        },
      },
    })
    const own: WorkspaceConfig = { run: { rules: { dependencies: [{ from: 'a', deny: ['b'] }] } } }
    expect(await staged(structuredClone(own))).toEqual(own)
  })
})

describe('vx-migrate from turbo.json', () => {
  const turboRepo = async (json: Record<string, unknown>) => {
    await writeFile(
      path.join(root, 'package.json'),
      '{"name":"r","private":true,"workspaces":["packages/*"]}\n',
    )
    await mkdir(path.join(root, 'packages', 'a'), { recursive: true })
    await writeFile(
      path.join(root, 'packages', 'a', 'package.json'),
      '{"name":"a","scripts":{"build":"tsc"}}\n',
    )
    await writeFile(
      path.join(root, 'turbo.json'),
      JSON.stringify({ tasks: { build: { outputs: ['dist/**'] } }, ...json }),
    )
  }

  it('writes concurrency and boundaries into the workspace file; names the rest', async () => {
    await turboRepo({
      concurrency: '50%',
      cacheDir: '.cache/turbo',
      cacheMaxAge: '7d',
      cacheMaxSize: '5GB',
      experimentalObservability: { otel: { enabled: true } },
      boundaries: BOUNDARIES,
    })
    const out = await migrate()
    const ws = await readFile(path.join(root, '.vx/workspace.ts'), 'utf8')
    expect(await fields()).toEqual({
      run: {
        concurrency: '50%',
        rules: {
          dependencies: [
            { from: 'tag:web', deny: ['tag:internal'] },
            { from: 'tag:lib', allow: ['tag:lib', 'tag:shared'] },
            { from: 'tag:public', deny: ['tag:internal'] },
          ],
        },
      },
    })
    expect(ws).not.toContain('undefined')
    expect(out).toContain('turbo.json `cacheDir: ".cache/turbo"`: vx keeps its cache in a store')
    expect(out).toContain('dependents.allow ["ops"]')
    expect(out).toContain(
      'turbo.json `cacheMaxAge: "7d"` and `cacheMaxSize: "5GB"`: vx evicts on demand — run `vx cache clean --older-than 7d --max-size 5GB`',
    )
    expect(out).toContain('turbo.json `experimentalObservability`')
    expect(out).not.toContain('to .vx/workspace.ts')
  })

  it('a plain count; CONTROL: none set writes no field', async () => {
    await turboRepo({ concurrency: '4', cacheMaxAge: '1w' })
    // `vx cache clean` takes no week: the note puts no value of Turbo's in its command.
    expect(await migrate()).toContain(
      'turbo.json `cacheMaxAge: "1w"`: vx evicts on demand — run `vx cache clean --older-than <duration> --max-size <size>`',
    )
    expect(await fields()).toEqual({ run: { concurrency: 4 } })
    await rm(path.join(root, '.vx'), { recursive: true })
    await rm(path.join(root, 'packages/a/vx.config.ts'))
    await turboRepo({})
    await migrate()
    const ws = await readFile(path.join(root, '.vx/workspace.ts'), 'utf8')
    expect(ws).not.toMatch(/run:|cache:/)
  })

  it('names each one where the workspace file is already there', async () => {
    await turboRepo({ concurrency: '4', boundaries: BOUNDARIES })
    await Bun.write(
      path.join(root, '.vx/workspace.mjs'),
      'export default { plugins: [] } // mine\n',
    )
    const out = await migrate()
    expect(out).toContain(
      'turbo.json `concurrency: "4"`: add `run: { concurrency: 4 }` to .vx/workspace.ts',
    )
    expect(out).toContain(
      "turbo.json `boundaries`: add `run: { rules: { dependencies: [{ from: 'tag:web'",
    )
    expect(await readFile(path.join(root, '.vx/workspace.mjs'), 'utf8')).toBe(
      'export default { plugins: [] } // mine\n',
    )
  })
})

describe('vx-migrate from an Nx graph', () => {
  it('writes the ESLint module boundaries nx() checks live', async () => {
    await mkdir(path.join(root, '.nx', 'workspace-data'), { recursive: true })
    await writeFile(path.join(root, 'nx.json'), '{}')
    await writeFile(
      path.join(root, 'package.json'),
      '{"name":"r","private":true,"workspaces":["libs/*"]}\n',
    )
    await mkdir(path.join(root, 'libs', 'a'), { recursive: true })
    await writeFile(path.join(root, 'libs', 'a', 'package.json'), '{"name":"a"}\n')
    await writeFile(
      path.join(root, '.nx', 'workspace-data', 'project-graph.json'),
      JSON.stringify({
        nodes: {
          a: { name: 'a', data: { root: 'libs/a', targets: { build: { command: 'tsc' } } } },
        },
        dependencies: {},
      }),
    )
    await writeFile(
      path.join(root, '.eslintrc.json'),
      JSON.stringify({
        rules: {
          '@nx/enforce-module-boundaries': [
            'error',
            {
              depConstraints: [{ sourceTag: 'scope:app', onlyDependOnLibsWithTags: ['scope:lib'] }],
            },
          ],
        },
      }),
    )
    await migrate()
    expect((await fields()).run).toEqual({
      rules: { dependencies: [{ from: 'tag:scope:app', allow: ['tag:scope:lib'] }] },
    })
  })
})
