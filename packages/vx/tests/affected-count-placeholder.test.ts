// A `^build` edge into a project with no build plans a placeholder node there
// (cacheStatus `group`, nothing runs). The footer's `N affected` counted that
// project, so a Turbo repo whose shared config package has no build said
// `2 affected` while one project ran (bug hunt round 2, 2026-10-15).
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { localWorkspaceSource } from './helpers/local-workspace.js'
import { edgesSource } from './helpers/plugin.js'

const CLI = path.join(import.meta.dir, 'helpers', 'vx-locked.ts')
let root: string

async function write(p: string, content: string): Promise<void> {
  await mkdir(path.dirname(p), { recursive: true })
  await writeFile(p, content)
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-affected-count-'))
  await write(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'r', workspaces: ['pkgs/*'] }),
  )
  await write(
    path.join(root, '.vx/workspace.mjs'),
    localWorkspaceSource([edgesSource({ app: ['config'] })]),
  )
  await write(path.join(root, 'pkgs/config/package.json'), JSON.stringify({ name: 'config' }))
  await write(path.join(root, 'pkgs/config/vx.config.mjs'), `export default { tasks: {} }\n`)
  await write(path.join(root, 'pkgs/app/package.json'), JSON.stringify({ name: 'app' }))
  await write(
    path.join(root, 'pkgs/app/vx.config.mjs'),
    `export default {
  tasks: { build: { dependsOn: ['^build'], exec: { command: 'true' } } },
}
`,
  )
  Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

it('a project reached by ^build with no build is not counted as affected', () => {
  const p = Bun.spawnSync({
    cmd: ['bun', CLI, 'run', 'build', '--all'],
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, CI: '', GITHUB_ACTIONS: '', NO_COLOR: '1' },
  })
  const out = new TextDecoder().decode(p.stdout) + new TextDecoder().decode(p.stderr)
  expect(p.exitCode).toBe(0)
  expect(out).toContain('1 affected · 2 total')
}, 60_000)
