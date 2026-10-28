// Turbo and Nx run a script as `<pm> run <name>`, so the hooks around it
// run only where the manager runs them: Yarn 2+ never does, nor npm
// under `ignore-scripts=true` or pnpm under `enable-pre-post-scripts=false`
// (D-31, D-33). turbo() and nx() folded `prebuild` into `build` whatever
// the manager, so a Berry repo's build ran its `rm -rf` hook under vx alone.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { PackageMeta } from '../src/packages.js'
import { mapNxWorkspace, type NxGraph } from '../src/nx/nx-map.js'
import { mapTurboWorkspace } from '../src/turbo/turbo-map.js'

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-adoption-hooks-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const scripts = { prebuild: 'echo PRE', build: 'echo BUILD', postbuild: 'echo POST' }

async function member(rootFiles: Record<string, string>): Promise<PackageMeta> {
  for (const [f, text] of Object.entries(rootFiles)) await writeFile(path.join(root, f), text)
  const dir = path.join(root, 'packages', 'a')
  await mkdir(dir, { recursive: true })
  const packageJson = { name: 'a', scripts }
  await writeFile(path.join(dir, 'package.json'), JSON.stringify(packageJson))
  return { name: 'a', dir, packageJson: packageJson as never, configPath: null }
}

async function turboCommand(rootFiles: Record<string, string>): Promise<unknown> {
  const meta = await member(rootFiles)
  await writeFile(path.join(root, 'turbo.json'), JSON.stringify({ tasks: { build: {} } }))
  const m = await mapTurboWorkspace(root, [meta], {
    splice: (_k, v) => v,
    persistentTodo: 'PERSIST',
  })
  return (m.projects[0]!.tasks[0]!.task!['exec'] as { command: unknown }).command
}

async function nxCommand(rootFiles: Record<string, string>): Promise<unknown> {
  const meta = await member(rootFiles)
  const nodes = {
    a: {
      data: {
        root: 'packages/a',
        targets: { build: { executor: 'nx:run-script', options: { script: 'build' } } },
      },
    },
  }
  const m = await mapNxWorkspace(root, [meta], { nodes, dependencies: {} } as NxGraph, {
    cacheable: new Set(),
  })
  const t = m.projects[0]!.tasks.find((x) => x.name === 'build')!
  return (t.task!['exec'] as { command: unknown }).command
}

const berry = {
  'package.json': JSON.stringify({ name: 'ws', packageManager: 'yarn@4.5.0' }),
  '.yarnrc.yml': 'nodeLinker: node-modules\n',
}
const pnpmOff = {
  'package.json': JSON.stringify({ name: 'ws', packageManager: 'pnpm@10.0.0' }),
  '.npmrc': 'enable-pre-post-scripts=false\n',
}
const npm = { 'package.json': JSON.stringify({ name: 'ws' }), 'package-lock.json': '{}' }

describe.each([
  ['turbo()', turboCommand],
  ['nx()', nxCommand],
])('%s', (_, command) => {
  it('folds no hooks where the manager runs none', async () => {
    expect(await command(berry)).toBe('echo BUILD')
  })
  it('folds no hooks under pnpm enable-pre-post-scripts=false', async () => {
    expect(await command(pnpmOff)).toBe('echo BUILD')
  })
  it('CONTROL: npm runs them, folded', async () => {
    expect(await command(npm)).toMatch(/PRE[\s\S]*BUILD[\s\S]*POST/)
  })
})
