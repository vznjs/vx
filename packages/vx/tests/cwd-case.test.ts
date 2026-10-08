// A run from a directory typed in another case than the disk holds it
// (`cd Packages/App` for `packages/app` on a case-insensitive file system):
// the workspace root kept the typed spelling, the members came from the
// glob scan in the disk's, and the cwd matched no member.

import { realpathSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { findCwdProject } from '../src/cli/select.js'
import { gitInit } from './helpers/workspace.js'

let root = ''

const config = (marker: string, dependsOn = '') => `export default { tasks: { build: {
  exec: { command: 'touch ${marker}' }${dependsOn} } } }\n`

beforeAll(async () => {
  root = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'vx-cwd-case-')))
  gitInit(root)
  // `workspaces` in package.json, not pnpm-workspace.yaml: the root walk
  // must CLAIM the typed member, which pnpm's nearest-file rule skips.
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'root', private: true, workspaces: ['packages/*'] }),
  )
  await writeFile(path.join(root, 'vx.config.mjs'), config('ran-root'))
  for (const [name, extra] of [
    ['lib', ''],
    ['app', `, dependsOn: ['^build']`],
  ] as const) {
    const dir = path.join(root, 'packages', name)
    await mkdir(dir, { recursive: true })
    const pkg = { name, version: '0.0.0', dependencies: name === 'app' ? { lib: '*' } : {} }
    await writeFile(path.join(dir, 'package.json'), JSON.stringify(pkg))
    await writeFile(path.join(dir, 'vx.config.mjs'), config(`../../ran-${name}`, extra))
  }
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

it('a cwd typed in another case is placed in the member the disk holds', async () => {
  // Linux cannot fold case, so the typed directory does not exist here:
  // the placement reads only its ancestors, which is what it shares with
  // a case-insensitive file system. Without the fold it placed the run in
  // the root project.
  expect(await findCwdProject(path.join(root, 'Packages', 'App'))).toBe('app')
  // CONTROL: the disk's spelling.
  expect(await findCwdProject(path.join(root, 'packages', 'app'))).toBe('app')
})

describe.skipIf(process.platform !== 'darwin')('case-insensitive file system', () => {
  it('vx run from Packages/App runs app and its deps, not the root project', async () => {
    const vx = Bun.spawnSync(
      [process.execPath, path.resolve(import.meta.dir, '../src/bin.ts'), 'run', 'build'],
      {
        cwd: path.join(root, 'Packages', 'App'),
        env: { ...process.env, NO_COLOR: '1' },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    const stderr = vx.exitCode === 0 ? '' : vx.stderr.toString()
    expect({ exitCode: vx.exitCode, stderr }).toEqual({ exitCode: 0, stderr: '' })
    // A root that kept the typed spelling claimed no member: the run was
    // the root's task, or `Packages/App` stood alone without `lib`.
    expect((await readdir(root)).filter((f) => f.startsWith('ran-')).sort()).toEqual([
      'ran-app',
      'ran-lib',
    ])
  })
})
