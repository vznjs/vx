// How vx finds a workspace is a 1.0 contract surface (docs/design/
// versioning-1.0.md): which directories are projects (a vx.config in them,
// none under a nested workspace) and which config file names load, in
// which precedence. A
// repo that works today must be found the same way tomorrow. Each case
// below builds a fixture, asks the real discovery (`findProjectConfigs`,
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
  findProjectConfigs,
  loadProjectConfig,
  loadWorkspaceConfig,
} from '../src/workspace/index.js'
import { relPosix } from '../src/util/index.js'

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

async function projects(root: string): Promise<string[]> {
  const { configs: found } = await findProjectConfigs(root)
  return found.map((p) => relPosix(root, p.configPath)).sort()
}

/** The first config file `findProjectConfigs` picks in `root`, by basename. */
async function firstConfig(root: string): Promise<string | null> {
  const {
    configs: [found],
  } = await findProjectConfigs(root)
  return found === undefined ? null : path.basename(found.configPath)
}

const CONFIG = (v: number): string =>
  `export default { tasks: { t${v}: { exec: { command: 'true' } } } }\n`
const WS_CONFIG = (v: number): string => `export default { run: { concurrency: ${v} } }\n`

it('each discovery case answers as tests/contract/discovery.json records', async () => {
  const live: Record<string, unknown> = {}
  // Outside git: every directory but node_modules and vx's own `.vx`, a
  // dot-directory too, as git lists one (`.github/actions/x`).
  live['projects: a vx.config in any directory'] = await projects(
    fixture({
      'vx.config.ts': CONFIG(0),
      'packages/a/vx.config.ts': CONFIG(1),
      'packages/a/nested/vx.config.mjs': CONFIG(2),
      'apps/c/package.json': pkg('c'),
      'tools/gen/vx.config.js': CONFIG(3),
      '.hidden/vx.config.ts': CONFIG(4),
      'node_modules/dep/vx.config.ts': CONFIG(5),
      '.vx/cache/x/vx.config.ts': CONFIG(8),
      'inner/.vx/workspace.ts': WS_CONFIG(1),
      'inner/vx.config.ts': CONFIG(6),
      'inner/p/vx.config.ts': CONFIG(7),
    }),
  )

  const names = ['vx.config.ts', 'vx.config.mts', 'vx.config.js', 'vx.config.mjs']
  for (const [i, file] of names.entries()) {
    const root = fixture({
      [`packages/a/${file}`]: CONFIG(i),
      // Every later name beside it: the one found is the precedence.
      ...Object.fromEntries(
        names.slice(i + 1).map((f, j) => [`packages/a/${f}`, CONFIG(i + j + 1)]),
      ),
    })
    live[`project config: ${names.slice(i).join(' + ')}`] = await firstConfig(root)
  }

  const wsNames = ['.vx/workspace.ts', '.vx/workspace.mts', '.vx/workspace.js', '.vx/workspace.mjs']
  for (const [i, file] of wsNames.entries()) {
    const root = fixture({
      'package.json': pkg('root', { workspaces: ['packages/*'] }),
      [file]: WS_CONFIG(i + 1),
      ...Object.fromEntries(wsNames.slice(i + 1).map((f, j) => [f, WS_CONFIG(i + j + 2)])),
    })
    const config = await loadWorkspaceConfig(root)
    const read = config?.run?.concurrency
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
      ...Object.fromEntries(
        files.map((f, i) => [`packages/a/${f}`, f.endsWith('.mjs') ? CONFIG(i) : CJS(i)]),
      ),
    })
    const first = await firstConfig(root)
    const config =
      first === null ? null : await loadProjectConfig(path.join(root, 'packages/a', first))
    live[`project config: ${files.join(' + ')}`] =
      first === null ? null : [first, Object.keys(config?.tasks ?? {})]
  }
  for (const files of [
    ['.vx/workspace.cts', '.vx/workspace.cjs'],
    ['.vx/workspace.cjs'],
    ['.vx/workspace.mjs', '.vx/workspace.cts'],
  ]) {
    const root = fixture({
      'package.json': pkg('root', { workspaces: ['packages/*'] }),
      ...Object.fromEntries(
        files.map((f, i) => [
          f,
          f.endsWith('.mjs')
            ? WS_CONFIG(i + 1)
            : `module.exports = { run: { concurrency: ${i + 1} } }\n`,
        ]),
      ),
    })
    const read = (await loadWorkspaceConfig(root))?.run?.concurrency
    live[`workspace config: ${files.join(' + ')}`] =
      typeof read === 'number' ? files[read - 1] : null
  }

  const text = JSON.stringify(live, null, 2) + '\n'
  if (process.env['VX_UPDATE_CONTRACT'] === '1' && process.env['CI'] !== 'true') {
    writeFileSync(RECORD, text)
  }
  expect(text).toBe(readFileSync(RECORD, 'utf8'))
}, 30_000)
