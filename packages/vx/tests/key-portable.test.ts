// One commit keys alike wherever and however it is checked out: a clone at
// another path (with a space), another HOME, TZ and locale, a umask, file
// times a checkout moved, a rebuilt index, and the same bytes still
// uncommitted. A real change still moves exactly the keys that read it. A
// probe of each case found no drift (hardening, 2026-11-24); this holds it.
import { realpathSync } from 'node:fs'
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, expect, it } from 'bun:test'
import { addProject, git, makeWorkspace } from './helpers/workspace.js'
import { vx } from './helpers/vx.js'

const LIB = `export default { tasks: {
  build: { exec: { command: 'mkdir -p dist && cat src/*.ts > dist/out.js' }, inputs: { files: ['src/**', 'package.json'] }, outputs: { files: ['dist/**'] }, cache: true },
  envy: { exec: { command: 'echo $FOO' }, inputs: { files: ['src/a.ts'], env: ['FOO'] }, outputs: { files: [] }, cache: true },
} }
`
const APP = `export default { tasks: {
  build: { dependsOn: ['lib#build'], exec: { command: 'mkdir -p dist && cat src/*.ts > dist/out.js' }, inputs: { files: ['src/**'], workspaceFiles: ['package.json'] }, outputs: { files: ['dist/**'] }, cache: true },
} }
`

let tmp = ''
let origin = ''
beforeAll(async () => {
  tmp = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'vx-key-portable-')))
  origin = await makeWorkspace({ dir: tmp, prefix: 'origin-', edges: { app: ['lib'] } })
  await addProject(origin, 'lib', {
    config: LIB,
    files: { 'src/a.ts': 'export const a = 1\n', 'src/run.sh': '#!/bin/sh\necho hi\n' },
  })
  await addProject(origin, 'app', { config: APP, files: { 'src/b.ts': 'export const b = 2\n' } })
  await writeFile(path.join(origin, '.gitignore'), 'dist\n*.log\n')
  expect((await vx(origin, ['lock'])).code).toBe(0)
  git(origin, 'add', '-A')
  git(origin, 'commit', '-q', '-m', 'init')
})
afterAll(() => rm(tmp, { recursive: true, force: true }))

/** Each task's key, by id, as `--dry` plans it. */
async function keys(cwd: string, env: Record<string, string | undefined> = {}): Promise<string> {
  const r = await vx(cwd, ['run', 'build', 'envy', '--all', '--dry', '--format', 'json'], {
    env: { FOO: 'x', ...env },
  })
  expect([r.code, r.err]).toEqual([0, ''])
  const plan = JSON.parse(r.out) as { tasks: { id: string; hash: string }[] }
  return plan.tasks
    .map((t) => `${t.id}=${t.hash}`)
    .sort()
    .join(' ')
}

const clone = (name: string, umask = '022'): string => {
  const to = path.join(tmp, name)
  const r = Bun.spawnSync({
    cmd: ['sh', '-c', `umask ${umask} && git clone -q "$0" "$1"`, origin, to],
  })
  expect(r.exitCode).toBe(0)
  return to
}

it('a commit keys alike in every checkout, and a change moves only its readers', async () => {
  const base = await keys(origin)
  const spaced = clone('c 2 dir')
  const home = path.join(tmp, 'home2')
  const strict = clone('umask', '077')
  const touched = clone('touched')
  for (const f of ['packages/lib/src/a.ts', 'packages/app/src/b.ts', 'package.json']) {
    const at = new Date('2001-01-01')
    await utimes(path.join(touched, f), at, at)
  }
  const reindexed = clone('reindexed')
  await rm(path.join(reindexed, '.git', 'index'))
  git(reindexed, 'reset', '-q')
  const fresh = clone('fresh')
  await rm(path.join(fresh, '.git'), { recursive: true, force: true })
  git(fresh, 'init', '-q')

  expect({
    spaced: await keys(spaced),
    home: await keys(spaced, { HOME: home, TZ: 'Asia/Kathmandu', LANG: 'tr_TR.UTF-8' }),
    umask: await keys(strict),
    touched: await keys(touched),
    reindexed: await keys(reindexed),
    uncommitted: await keys(fresh),
  }).toEqual({
    spaced: base,
    home: base,
    umask: base,
    touched: base,
    reindexed: base,
    uncommitted: base,
  })

  // A real change moves the keys that read it, and only those.
  const moved = (after: string): string[] => {
    const before = new Map(base.split(' ').map((kv) => kv.split('=') as [string, string]))
    return after
      .split(' ')
      .map((kv) => kv.split('=') as [string, string])
      .filter(([id, h]) => before.get(id) !== h)
      .map(([id]) => id)
  }
  const env = moved(await keys(spaced, { FOO: 'y' }))
  await writeFile(path.join(spaced, 'packages/lib/src/new.ts'), 'n\n')
  const untracked = moved(await keys(spaced))
  await rm(path.join(spaced, 'packages/lib/src/new.ts'))
  await writeFile(path.join(spaced, 'packages/lib/src/x.log'), 'ignored\n')
  const ignored = moved(await keys(spaced))
  const pkg = path.join(spaced, 'package.json')
  await writeFile(pkg, (await Bun.file(pkg).text()).replace('{', '{"x":1,'))
  const rootPkg = moved(await keys(spaced))
  expect({ env, untracked, ignored, rootPkg }).toEqual({
    env: ['lib#envy'],
    untracked: ['app#build', 'lib#build'],
    ignored: [],
    rootPkg: ['app#build'],
  })
}, 120_000)
