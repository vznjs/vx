// `--affected` (`configImportOwners`) and `vx watch` (`configImports`) walk a
// config's imports by one rule: every specifier Bun loads from a local file.
// The watch walk kept `./` and `../` alone, deaf to a tsconfig alias the
// other followed; both dropped `'..'` and package.json `#imports`.
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, test } from 'bun:test'
import { configImportOwners, configImports } from '../src/workspace/config-imports.js'

const roots: string[] = []
afterEach(async () => {
  for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true })
})

async function workspace(files: Record<string, string>): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'vx-cis-')))
  roots.push(root)
  for (const [rel, body] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true })
    await writeFile(path.join(root, rel), body)
  }
  return root
}

async function owners(root: string, configRel: string, changed: string): Promise<string[]> {
  const configPath = path.join(root, configRel)
  const found = await configImportOwners({
    workspaceRoot: root,
    projects: [{ name: 'app', dir: path.dirname(configPath), configPath }] as never,
    changed: [changed],
    skip: new Set(),
  })
  return [...found]
}

const config = (spec: string) => `import { cmd } from '${spec}'
export default { tasks: { build: { exec: { command: cmd } } } }
`

test('configImports follows a tsconfig paths alias, as configImportOwners does', async () => {
  const root = await workspace({
    'tsconfig.json': JSON.stringify({
      compilerOptions: { baseUrl: '.', paths: { '@shared/*': ['./shared/*'] } },
    }),
    'shared/preset.mjs': `export const cmd = 'echo hi'\n`,
    'app/vx.config.mjs': config('@shared/preset.mjs'),
  })
  expect(await owners(root, 'app/vx.config.mjs', 'shared/preset.mjs')).toEqual(['app'])
  expect(await configImports(path.join(root, 'app/vx.config.mjs'))).toEqual([
    path.join(root, 'shared/preset.mjs'),
  ])
})

test("a config's '..' import is an edge for --affected and vx watch", async () => {
  const root = await workspace({
    'packages/index.mjs': `export const cmd = 'echo hi'\n`,
    'packages/app/vx.config.mjs': config('..'),
  })
  expect(await owners(root, 'packages/app/vx.config.mjs', 'packages/index.mjs')).toEqual(['app'])
  expect(await configImports(path.join(root, 'packages/app/vx.config.mjs'))).toEqual([
    path.join(root, 'packages/index.mjs'),
  ])
})

test('a `#imports` specifier is an edge for --affected and vx watch', async () => {
  const root = await workspace({
    'package.json': JSON.stringify({ name: 'root', imports: { '#shared/*': './shared/*' } }),
    'shared/preset.mjs': `export const cmd = 'echo hi'\n`,
    'apps/web/vx.config.mjs': config('#shared/preset.mjs'),
  })
  expect(await owners(root, 'apps/web/vx.config.mjs', 'shared/preset.mjs')).toEqual(['app'])
  expect(await configImports(path.join(root, 'apps/web/vx.config.mjs'))).toEqual([
    path.join(root, 'shared/preset.mjs'),
  ])
  // CONTROL: an unrelated change selects nothing.
  expect(await owners(root, 'apps/web/vx.config.mjs', 'package.json')).toEqual([])
})

test('a `#imports` target the change deleted still reaches its importer', async () => {
  const root = await workspace({
    'package.json': JSON.stringify({ name: 'root', imports: { '#shared/*': './shared/*' } }),
    'apps/web/vx.config.mjs': config('#shared/preset.mjs'),
  })
  expect(await owners(root, 'apps/web/vx.config.mjs', 'shared/preset.mjs')).toEqual(['app'])
  expect(await configImports(path.join(root, 'apps/web/vx.config.mjs'))).toContain(
    path.join(root, 'shared/preset.mjs'),
  )
})

test('a `#imports` entry naming a package is no local edge', async () => {
  const root = await workspace({
    'package.json': JSON.stringify({ name: 'root', imports: { '#dep': 'some-pkg' } }),
    'apps/web/vx.config.mjs': config('#dep'),
  })
  expect(await configImports(path.join(root, 'apps/web/vx.config.mjs'))).toEqual([])
})
