// An installed package that ships a vx.config is not a project of the
// workspace that installed it. The walk outside git already skips every
// `node_modules`; in git, a repo whose .gitignore does not (yet) name
// node_modules listed the install's configs as projects.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, expect, it } from 'bun:test'
import { findProjectConfigs } from '../src/workspace/workspace.js'
import { relPosix } from '../src/util/index.js'

const BASE = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'vx-disc-nm-')))
afterAll(() => rmSync(BASE, { recursive: true, force: true }))

const CONFIG = "export default { tasks: { t: { exec: { command: 'true' } } } }\n"

function write(root: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    writeFileSync(path.join(root, rel), text)
  }
}

const git = (cwd: string, ...args: string[]): void => {
  const p = Bun.spawnSync(['git', '-c', 'commit.gpgsign=false', ...args], { cwd })
  if (p.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${p.stderr.toString()}`)
}

it('in git, a config under node_modules is no project, tracked or untracked', async () => {
  const root = path.join(BASE, 'repo')
  write(root, {
    '.vx/workspace.mjs': 'export default {}\n',
    'packages/a/vx.config.mjs': CONFIG,
    // Committed, as a vendored install is.
    'node_modules/vendored/vx.config.mjs': CONFIG,
  })
  git(root, 'init', '-q')
  git(root, '-c', 'user.email=a@b', '-c', 'user.name=a', 'add', '-A')
  git(root, '-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-qm', 'init')
  // Installed after, with no .gitignore naming node_modules.
  write(root, {
    'node_modules/dep/vx.config.mjs': CONFIG,
    'node_modules/@scope/dep/vx.config.ts': CONFIG,
    'packages/a/node_modules/dep2/vx.config.mjs': CONFIG,
  })
  const { configs } = await findProjectConfigs(root)
  expect(configs.map((c) => relPosix(root, c.configPath))).toEqual(['packages/a/vx.config.mjs'])
})
