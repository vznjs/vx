// A project moved and linked back (`mv b real/b && ln -s real/b b`) left
// git's index listing `b/vx.config.mjs`, which the link let a stat find:
// `vx lock` locked `b` and `real/b` over one directory, and a run ran both
// tasks into the same `dist`. Git says the tracked file is deleted, as it
// never looks beyond a symlink; discovery agrees.
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, expect, it } from 'bun:test'
import { findProjectConfigs } from '../src/workspace/workspace.js'
import { relPosix } from '../src/util/index.js'

const BASE = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'vx-disc-links-')))
afterAll(() => rmSync(BASE, { recursive: true, force: true }))

const CONFIG = "export default { tasks: { t: { exec: { command: 'true' } } } }\n"

function write(root: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    writeFileSync(path.join(root, rel), text)
  }
}

const git = (cwd: string, ...args: string[]): void => {
  const p = Bun.spawnSync(
    ['git', '-c', 'commit.gpgsign=false', '-c', 'user.email=a@b', '-c', 'user.name=a', ...args],
    { cwd },
  )
  if (p.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${p.stderr.toString()}`)
}

it('a tracked config behind a symlinked directory is no project: its real directory is', async () => {
  const root = path.join(BASE, 'moved')
  write(root, {
    '.vx/workspace.mjs': 'export default {}\n',
    'b/vx.config.mjs': CONFIG,
    'c/.vx/workspace.mjs': 'export default {}\n',
    'c/vx.config.mjs': CONFIG,
  })
  git(root, 'init', '-q')
  git(root, 'add', '-A')
  git(root, 'commit', '-qm', 'init')
  mkdirSync(path.join(root, 'real'))
  for (const d of ['b', 'c']) {
    renameSync(path.join(root, d), path.join(root, 'real', d))
    symlinkSync(`real/${d}`, path.join(root, d))
  }
  const found = await findProjectConfigs(root)
  expect(found.configs.map((c) => relPosix(root, c.configPath))).toEqual(['real/b/vx.config.mjs'])
  expect(found.nestedWorkspaces).toEqual([path.join(root, 'real/c')])
})
