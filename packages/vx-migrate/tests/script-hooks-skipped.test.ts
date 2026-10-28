// A `pre` / `post` hook folds into a mapped command only where the package
// manager runs it. Yarn 2+ runs none, pnpm none under
// `enablePrePostScripts: false`, npm none under `ignore-scripts=true`; the
// scripts migrator already asked `runsScriptHooks`, turbo() and nx() did
// not, so `prebuild: rm -rf src` ran before a build Turbo or Nx never
// preceded with it.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { PackageMeta } from '../src/packages.js'
import { mapNxWorkspace, type NxGraph } from '../src/nx/nx-map.js'
import { mapTurboWorkspace } from '../src/turbo/turbo-map.js'

let root: string

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-hooks-skipped-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const SCRIPTS = { prebuild: 'rm -rf src', build: 'tsc' }

async function setup(manager: string, files: Record<string, string>): Promise<PackageMeta> {
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({
      name: 'r',
      private: true,
      packageManager: manager,
      workspaces: ['packages/*'],
    }),
  )
  for (const [f, text] of Object.entries(files)) await writeFile(path.join(root, f), text)
  const dir = path.join(root, 'packages', 'a')
  await mkdir(dir, { recursive: true })
  const packageJson = { name: 'a', scripts: SCRIPTS }
  await writeFile(path.join(dir, 'package.json'), JSON.stringify(packageJson))
  return { name: 'a', dir, packageJson: packageJson as never, configPath: null }
}

async function turbo(a: PackageMeta): Promise<unknown> {
  await writeFile(
    path.join(root, 'turbo.json'),
    JSON.stringify({ tasks: { build: { outputs: [] } } }),
  )
  const m = await mapTurboWorkspace(root, [a], {
    splice: (_k: string, v: readonly string[]) => v,
    persistentTodo: 'PERSIST',
  })
  return (
    m.projects[0]!.tasks.find((t) => t.name === 'build')!.task!['exec'] as { command: string }
  ).command
}

async function nx(a: PackageMeta): Promise<unknown> {
  const m = await mapNxWorkspace(
    root,
    [a],
    {
      nodes: {
        a: {
          data: {
            root: 'packages/a',
            targets: { build: { executor: 'nx:run-script', options: { script: 'build' } } },
          },
        },
      },
      dependencies: {},
    } as NxGraph,
    { cacheable: new Set<string>() },
  )
  return (
    m.projects[0]!.tasks.find((t) => t.name === 'build')!.task!['exec'] as { command: string }
  ).command
}

const CASES: [string, string, Record<string, string>][] = [
  ['Yarn 4 (node-modules linker)', 'yarn@4.5.0', { '.yarnrc.yml': 'nodeLinker: node-modules\n' }],
  [
    'pnpm with enablePrePostScripts: false',
    'pnpm@10.0.0',
    { 'pnpm-workspace.yaml': 'packages:\n  - packages/*\nenablePrePostScripts: false\n' },
  ],
  ['npm with ignore-scripts=true', 'npm@10.0.0', { '.npmrc': 'ignore-scripts=true\n' }],
]

describe('a hook the manager skips is not folded', () => {
  for (const [label, manager, files] of CASES) {
    it(`turbo(): ${label}`, async () => {
      expect(await turbo(await setup(manager, files))).toBe('tsc')
    })
    it(`nx(): ${label}`, async () => {
      expect(await nx(await setup(manager, files))).toBe('tsc')
    })
  }

  it('CONTROL: npm runs the hook, so both fold it', async () => {
    const a = await setup('npm@10.0.0', {})
    for (const command of [await turbo(a), await nx(a)]) expect(command).toContain('rm -rf src')
  })
})
