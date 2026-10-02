// A `workspaceFiles` glob reaches into a nested repository: an edit to a
// file there re-keys the task. The quickstart listed the opposite as a
// known limit ("stops at a git submodule's edge").
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
}
let root: string | undefined

afterAll(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
})

function sh(cwd: string, ...cmd: string[]): string {
  const r = Bun.spawnSync({ cmd, cwd, env: ENV, stdout: 'pipe', stderr: 'pipe' })
  expect({ cmd, code: r.exitCode }).toEqual({ cmd, code: 0 })
  return r.stdout.toString()
}

describe('a workspaceFiles glob over a nested repository', () => {
  it('an edit inside it is a miss', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'vx-wsf-nested-'))
    await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'r', private: true }))
    const app = path.join(root, 'packages', 'app')
    await mkdir(app, { recursive: true })
    await writeFile(path.join(app, 'package.json'), JSON.stringify({ name: 'app' }))
    await writeFile(
      path.join(app, 'vx.config.mjs'),
      `export default {
  tasks: {
    w: {
      exec: { command: 'true' },
      cache: { inputs: { files: [], workspaceFiles: ['vendor/**'] }, outputs: { files: [] } },
    },
  },
}
`,
    )
    const vendor = path.join(root, 'vendor')
    await mkdir(vendor)
    await writeFile(path.join(vendor, 'lib.txt'), 'v1\n')
    sh(vendor, 'git', 'init', '-q')
    sh(vendor, 'git', 'add', '-A')
    sh(vendor, 'git', 'commit', '-qm', 'v')
    sh(root, 'git', 'init', '-q')

    const run = (): string =>
      sh(root!, process.execPath, BIN, 'run', 'app#w', '--output-logs=hash-only').trim()
    const first = run()
    const hit = run()
    await writeFile(path.join(vendor, 'lib.txt'), 'v2\n')
    const edited = run()
    expect([first.split(' ')[0], hit.split(' ')[0], edited.split(' ')[0]]).toEqual([
      'success',
      'up-to-date',
      'success',
    ])
    expect(edited.split(' ').at(-1)).not.toBe(hit.split(' ').at(-1))
  })
})
