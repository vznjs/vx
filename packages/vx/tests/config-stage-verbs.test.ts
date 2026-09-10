// The plugin `config` stage shapes the workspace config before anything is
// derived from it — `cacheDir` included. Every verb that opens the cache
// must open the directory the RUN used, so the stage applies to all of
// them, not only to `vx run`. Subprocess-driven so the dispatcher wiring is
// the one a user hits.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { PLUGIN_IMPORT, pluginSource } from './helpers/plugin.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const TIMEOUT = 30_000

// A `config` plugin that moves the cache: the shape a plugin reading the
// location from its own environment (a CI cache mount) takes.
const WORKSPACE = `${PLUGIN_IMPORT}
  export default {
    plugins: [
      ${pluginSource(
        'mover',
        `{ config(ws) {
          ws.cacheDir = '.vx/moved'
        },
      }`,
      )},
    ],
  }
`

const APP_CONFIG = `
  export default {
    tasks: {
      build: {
        exec: { command: 'mkdir -p dist && echo built > dist/out.txt' },
        cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] } },
      },
    },
  }
`

async function vx(
  root: string,
  args: string[],
): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn([process.execPath, BIN, ...args], {
    cwd: root,
    env: { ...process.env, NO_COLOR: '1' },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, out, err }
}

describe('the `config` stage reaches every verb that opens the cache', () => {
  let root: string
  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'vx-config-stage-'))
    await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'r', private: true }))
    await writeFile(path.join(root, 'vx.workspace.mjs'), WORKSPACE)
    const app = path.join(root, 'packages', 'app')
    await mkdir(path.join(app, 'src'), { recursive: true })
    await writeFile(path.join(app, 'package.json'), JSON.stringify({ name: 'app' }))
    await writeFile(path.join(app, 'vx.config.mjs'), APP_CONFIG)
    await writeFile(path.join(app, 'src', 'index.js'), 'export {}\n')
    await Bun.spawn(['git', 'init', '-q'], { cwd: root }).exited
    const r = await vx(root, ['run', 'build', '--all'])
    expect(`${r.code}\n${r.err}${r.out}`).toStartWith('0\n')
    expect(existsSync(path.join(root, '.vx', 'moved', 'cache.db'))).toBe(true)
    expect(existsSync(path.join(root, '.vx', 'cache'))).toBe(false)
  })
  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it(
    '`vx last` and `vx why` read the run the stage placed',
    async () => {
      const last = await vx(root, ['last'])
      expect(last.code).toBe(0)
      expect(last.out).toContain('app#build')
      const why = await vx(root, ['why', 'app#build'])
      expect(why.code).toBe(0)
      expect(why.out).toContain('first recorded run')
    },
    TIMEOUT,
  )

  it(
    '`vx info` names the moved directory and counts its runs',
    async () => {
      const r = await vx(root, ['info'])
      expect(r.code).toBe(0)
      expect(r.out).toMatch(/^cache dir: +\S+\/\.vx\/moved$/m)
      expect(r.out).toMatch(/^cache entries: +1 /m)
    },
    TIMEOUT,
  )

  it(
    '`vx cache prune` prunes the moved directory and never creates the default one',
    async () => {
      const r = await vx(root, ['cache', 'prune', '--max-size', '1B'])
      expect(`${r.code}\n${r.err}`).toBe('0\n')
      expect(r.out).toContain('Pruned 1 entry')
      expect(existsSync(path.join(root, '.vx', 'cache'))).toBe(false)
    },
    TIMEOUT,
  )
})
