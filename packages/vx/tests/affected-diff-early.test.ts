// `--affected` starts its git work before the workspace config and
// discovery, not after them and the config load: the merge base, the diff
// and the whole-tree walk need only the root and the ref, so they overlap
// what the main thread does meanwhile (and stay once per run). A
// 1,000-project warm run waited on them after discovery.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, setDefaultTimeout } from 'bun:test'
import { localWorkspaceSource } from './helpers/local-workspace.js'
import { pluginSource } from './helpers/plugin.js'

const BIN = path.join(import.meta.dir, '..', 'src', 'bin.ts')

setDefaultTimeout(30_000)

function git(cwd: string, ...args: string[]): void {
  const p = Bun.spawnSync({
    cmd: ['git', '-c', 'commit.gpgsign=false', ...args],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (p.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${p.stderr.toString()}`)
}

let root: string
let shimDir: string

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-affected-early-'))
  shimDir = await mkdtemp(path.join(os.tmpdir(), 'vx-affected-early-shim-'))
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'r', workspaces: ['pkgs/*'] }),
  )
  // Its discover hook writes to the git shim's log, so the log orders the
  // stage against each git call; it first lets a merge-base already
  // spawned reach the log (the shim's own start is the race).
  await Bun.write(
    path.join(root, '.vx/workspace.mjs'),
    localWorkspaceSource([
      pluginSource(
        'org/order-log',
        `{ async discover() {
  const log = process.env.VX_TEST_ORDER_LOG
  if (!log) return []
  const fs = await import('node:fs')
  // A spawn already made reaches the log within the shim's start; the
  // bound only ends the wait when none was made.
  const asked = () => {
    const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : ''
    return calls.includes('merge-base ') && calls.includes(' ls-files -s -v ')
  }
  for (let i = 0; i < 300 && !asked(); i++) await Bun.sleep(10)
  fs.appendFileSync(log, 'DISCOVER\\n')
  return []
} }`,
      ),
    ]),
  )
  for (const name of ['app', 'lib']) {
    await mkdir(path.join(root, 'pkgs', name, 'src'), { recursive: true })
    await writeFile(path.join(root, 'pkgs', name, 'package.json'), JSON.stringify({ name }))
    await writeFile(
      path.join(root, 'pkgs', name, 'vx.config.mjs'),
      `export default { tasks: { build: { exec: { command: 'true' }, inputs: { files: ['src/**'] }, outputs: { files: [] }, cache: true } } }\n`,
    )
    await writeFile(path.join(root, 'pkgs', name, 'src', 'a.txt'), '1\n')
  }
  await writeFile(path.join(root, '.gitignore'), '.vx/cache/\n')
  expect(Bun.spawnSync([process.execPath, BIN, 'lock'], { cwd: root }).exitCode).toBe(0)
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'config', 'user.email', 'test@vx.local')
  git(root, 'config', 'user.name', 'vx test')
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'one')
  git(root, 'checkout', '-q', '-b', 'feat')
  await writeFile(path.join(root, 'pkgs/app/src/a.txt'), '2\n')
  git(root, 'commit', '-q', '-am', 'two')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  await rm(shimDir, { recursive: true, force: true })
})

it('--affected spawns merge-base and the whole-tree walk before the discover stage', async () => {
  const log = path.join(shimDir, 'order.log')
  await writeFile(
    path.join(shimDir, 'git'),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexec '${Bun.which('git')}' "$@"\n`,
    { mode: 0o755 },
  )
  const p = Bun.spawnSync({
    cmd: [process.execPath, BIN, 'run', 'build', '--affected=main', '--dry=json'],
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      CI: '',
      GITHUB_ACTIONS: '',
      NO_COLOR: '1',
      VX_TEST_ORDER_LOG: log,
      PATH: `${shimDir}:${process.env['PATH']}`,
    },
  })
  expect({ code: p.exitCode, stderr: p.stderr.toString() }).toEqual({ code: 0, stderr: '' })
  const tasks = (JSON.parse(p.stdout.toString()) as { tasks: { id: string }[] }).tasks
  expect(tasks.map((t) => t.id)).toEqual(['app#build'])
  const calls = (await Bun.file(log).text()).trim().split('\n')
  const discover = calls.indexOf('DISCOVER')
  const mergeBase = calls.findIndex((c) => c.startsWith('merge-base ') && c.includes('main'))
  const walk = calls.findIndex((c) => c.endsWith(' ls-files -s -v -z -- .'))
  expect(discover).toBeGreaterThanOrEqual(0)
  expect({ mergeBase: mergeBase >= 0, walk: walk >= 0 }).toEqual({ mergeBase: true, walk: true })
  expect({ mergeBase: mergeBase < discover, walk: walk < discover }).toEqual({
    mergeBase: true,
    walk: true,
  })
  // Once per run: the run reuses the walk and the diff selection made.
  expect(calls.filter((c) => c.endsWith(' ls-files -s -v -z -- .'))).toHaveLength(1)
  expect(calls.filter((c) => /^(-c \S+ )*diff /.test(c))).toHaveLength(1)
})
