// How vx finds a workspace is a 1.0 contract surface (docs/design/
// versioning-1.0.md): which manifests make a root and list its projects,
// which root a run from inside a member resolves to, and which config file
// names load, in which precedence. A repo that works today must be found
// the same way tomorrow. Each case below builds a fixture, asks the real
// discovery (`findWorkspaceRoot`, `loadWorkspace`, `listProjects`,
// `loadWorkspaceConfig`), and `tests/contract/discovery.json` records the
// answer. A change is a reviewed diff of that file, and a changed answer is
// a break the break law sees.
//
// Regenerate after a deliberate change, then review the diff:
//   VX_UPDATE_CONTRACT=1 bun test tests/contract-discovery.test.ts

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, expect, it } from 'bun:test'
import {
  findWorkspaceRoot,
  listProjects,
  loadProjectConfig,
  loadWorkspace,
  loadWorkspaceConfig,
} from '../src/workspace/index.js'

const RECORD = path.join(import.meta.dir, 'contract', 'discovery.json')
// A canonical root: macOS's temp dir is a symlink, and a root compared as a path must not be one.
const BASE = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'vx-discovery-')))
afterAll(() => rmSync(BASE, { recursive: true, force: true }))

let n = 0
/** A fixture root holding `files` (path → contents); every `package.json` without one gets `{name}`. */
function fixture(files: Record<string, string>): string {
  const root = path.join(BASE, String(n++))
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    writeFileSync(path.join(root, rel), text)
  }
  return root
}
const pkg = (name: string, extra: object = {}): string => JSON.stringify({ name, ...extra })
const MEMBERS = {
  'packages/a/package.json': pkg('a'),
  'packages/a/src/x.ts': '',
  'packages/b/package.json': pkg('b'),
  'apps/c/package.json': pkg('c'),
  'packages/a/nested/package.json': pkg('nested'),
}

async function projects(root: string): Promise<string[]> {
  const found = await listProjects(await loadWorkspace(root))
  return found.map((p) => `${p.name} ${path.relative(root, p.dir) || '.'}`).sort()
}

const LAYOUTS: Record<string, Record<string, string>> = {
  'pnpm-workspace.yaml': {
    'package.json': pkg('root'),
    'pnpm-workspace.yaml': 'packages:\n  - "packages/*"\n',
    ...MEMBERS,
  },
  'package.json workspaces': {
    'package.json': pkg('root', { workspaces: ['packages/*', 'apps/*'] }),
    ...MEMBERS,
  },
  'package.json workspaces.packages': {
    'package.json': pkg('root', { workspaces: { packages: ['apps/*'] } }),
    ...MEMBERS,
  },
  'a negated glob': {
    'package.json': pkg('root', { workspaces: ['packages/*', '!packages/b'] }),
    ...MEMBERS,
  },
  'a recursive glob': {
    'package.json': pkg('root', { workspaces: ['packages/**'] }),
    ...MEMBERS,
  },
  'pnpm-workspace.yaml beside package.json workspaces': {
    'package.json': pkg('root', { workspaces: ['apps/*'] }),
    'pnpm-workspace.yaml': 'packages:\n  - "packages/*"\n',
    ...MEMBERS,
  },
  'package.json without workspaces': { 'package.json': pkg('root'), ...MEMBERS },
}

const CONFIG = (v: number): string =>
  `export default { tasks: { t${v}: { exec: { command: 'true' } } } }\n`
const WS_CONFIG = (v: number): string => `export default { concurrency: ${v} }\n`

it('each discovery case answers as tests/contract/discovery.json records', async () => {
  const live: Record<string, unknown> = {}
  for (const [name, files] of Object.entries(LAYOUTS)) {
    const root = fixture(files)
    live[`projects: ${name}`] = await projects(root)
    const found = async (from: string): Promise<string> =>
      path.relative(root, await findWorkspaceRoot(path.join(root, from))) || '.'
    live[`root from packages/a/src: ${name}`] = await found('packages/a/src')
    live[`root from apps/c: ${name}`] = await found('apps/c')
  }

  const names = ['vx.config.ts', 'vx.config.mts', 'vx.config.js', 'vx.config.mjs']
  for (const [i, file] of names.entries()) {
    const root = fixture({
      'package.json': pkg('root', { workspaces: ['packages/*'] }),
      'packages/a/package.json': pkg('a'),
      [`packages/a/${file}`]: CONFIG(i),
      // Every later name beside it: the one found is the precedence.
      ...Object.fromEntries(
        names.slice(i + 1).map((f, j) => [`packages/a/${f}`, CONFIG(i + j + 1)]),
      ),
    })
    const [meta] = await listProjects(await loadWorkspace(root))
    live[`project config: ${names.slice(i).join(' + ')}`] =
      meta?.configPath == null ? null : path.basename(meta.configPath)
  }

  const wsNames = ['vx.workspace.ts', 'vx.workspace.mts', 'vx.workspace.js', 'vx.workspace.mjs']
  for (const [i, file] of wsNames.entries()) {
    const root = fixture({
      'package.json': pkg('root', { workspaces: ['packages/*'] }),
      [file]: WS_CONFIG(i + 1),
      ...Object.fromEntries(wsNames.slice(i + 1).map((f, j) => [f, WS_CONFIG(i + j + 2)])),
    })
    const config = await loadWorkspaceConfig(root)
    const read = config?.concurrency
    live[`workspace config: ${wsNames.slice(i).join(' + ')}`] =
      typeof read === 'number' ? wsNames[read - 1] : null
  }

  // D-86: the CommonJS names, after the ESM ones (`module.exports`).
  const CJS = (v: number): string =>
    `module.exports = { tasks: { t${v}: { exec: { command: 'true' } } } }\n`
  for (const files of [
    ['vx.config.cts', 'vx.config.cjs'],
    ['vx.config.cjs'],
    ['vx.config.mjs', 'vx.config.cts'],
  ]) {
    const root = fixture({
      'package.json': pkg('root', { workspaces: ['packages/*'] }),
      'packages/a/package.json': pkg('a'),
      ...Object.fromEntries(
        files.map((f, i) => [`packages/a/${f}`, f.endsWith('.mjs') ? CONFIG(i) : CJS(i)]),
      ),
    })
    const [meta] = await listProjects(await loadWorkspace(root))
    const config = meta?.configPath == null ? null : await loadProjectConfig(meta.configPath)
    live[`project config: ${files.join(' + ')}`] =
      meta?.configPath == null
        ? null
        : [path.basename(meta.configPath), Object.keys(config?.tasks ?? {})]
  }
  for (const files of [
    ['vx.workspace.cts', 'vx.workspace.cjs'],
    ['vx.workspace.cjs'],
    ['vx.workspace.mjs', 'vx.workspace.cts'],
  ]) {
    const root = fixture({
      'package.json': pkg('root', { workspaces: ['packages/*'] }),
      ...Object.fromEntries(
        files.map((f, i) => [
          f,
          f.endsWith('.mjs') ? WS_CONFIG(i + 1) : `module.exports = { concurrency: ${i + 1} }\n`,
        ]),
      ),
    })
    const read = (await loadWorkspaceConfig(root))?.concurrency
    live[`workspace config: ${files.join(' + ')}`] =
      typeof read === 'number' ? files[read - 1] : null
  }

  const text = JSON.stringify(live, null, 2) + '\n'
  if (process.env['VX_UPDATE_CONTRACT'] === '1' && process.env['CI'] !== 'true') {
    writeFileSync(RECORD, text)
  }
  expect(text).toBe(readFileSync(RECORD, 'utf8'))
}, 30_000)
