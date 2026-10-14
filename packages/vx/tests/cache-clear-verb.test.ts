// `vx cache clear` through the real binary: it deletes the workspace's
// `.vx/cache` and the store its index names (`~/.vx/<id>/cache`), and
// nothing else in `.vx`. Before it, a zero prune bound was refused and the
// docs said to delete the store by hand (M, 2026-10-14).

import { existsSync, readdirSync, realpathSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { addProject, makeWorkspace } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const TIMEOUT = 30_000

describe('vx cache clear', () => {
  let root = ''
  let home = ''
  const vx = async (args: string[], env: Record<string, string> = {}) => {
    const proc = Bun.spawn([process.execPath, BIN, ...args], {
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, NO_COLOR: '1', HOME: home, VX_CACHE_DIR: '', ...env },
    })
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    return { code, out, err }
  }
  /** The repo's store under the fake home: `~/.vx/<id>/cache`. */
  const store = (): string => {
    const vxHome = path.join(home, '.vx')
    const [id] = readdirSync(vxHome)
    return path.join(vxHome, id!, 'cache')
  }

  beforeEach(async () => {
    home = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'vx-clear-home-')))
    root = realpathSync(await makeWorkspace({ prefix: 'vx-clear-', git: 'commit' }))
    await addProject(root, 'app', {
      config: `export default { tasks: { build: {
        exec: { command: 'mkdir -p dist && echo built > dist/out.txt' },
        cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] } },
      } } }\n`,
      files: { 'src/i.txt': 'x\n' },
    })
    await Bun.write(path.join(root, '.vx', 'sentinel.json'), '{}')
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true })
  })

  it(
    'a dry run deletes nothing; the real one deletes .vx/cache and the store, and nothing else',
    async () => {
      expect((await vx(['run', 'build', '--all'])).code).toBe(0)
      const dotVx = readdirSync(path.join(root, '.vx')).sort()
      expect(dotVx).toContain('cache')
      expect(readdirSync(store()).length).toBeGreaterThan(0)
      const st = store()

      const dry = await vx(['cache', 'clear', '--dry-run', '--format', 'json'])
      expect({ code: dry.code, err: dry.err }).toEqual({ code: 0, err: '' })
      const plan = JSON.parse(dry.out) as { dryRun: boolean; cleared: string[]; bytesFreed: number }
      expect([plan.dryRun, plan.cleared, plan.bytesFreed > 0]).toEqual([
        true,
        ['.vx/cache', st],
        true,
      ])
      expect([existsSync(path.join(root, '.vx', 'cache')), existsSync(st)]).toEqual([true, true])

      const real = await vx(['cache', 'clear'])
      expect({ code: real.code, err: real.err }).toEqual({ code: 0, err: '' })
      expect(real.out).toMatch(
        new RegExp(`^Cleared \\.vx/cache and ${st.replace(/[.]/g, '\\.')} \\(.+ freed\\)\\n$`),
      )
      expect([existsSync(path.join(root, '.vx', 'cache')), existsSync(st)]).toEqual([false, false])
      // The workspace config, the lock and .vx/.gitignore stay.
      expect(readdirSync(path.join(root, '.vx')).sort()).toEqual(dotVx.filter((e) => e !== 'cache'))

      // The next run misses and saves again.
      const again = await vx(['run', 'build', '--all'])
      expect(again.code).toBe(0)
      expect(again.out).not.toContain('cache hit')
      expect(existsSync(st)).toBe(true)
    },
    TIMEOUT,
  )

  it(
    'a workspace that never ran has nothing to clear',
    async () => {
      const r = await vx(['cache', 'clear'])
      expect(r).toEqual({ code: 0, out: 'Nothing to clear: no cache here\n', err: '' })
    },
    TIMEOUT,
  )

  it(
    'refuses a cache.dir that holds the workspace config',
    async () => {
      await Bun.write(path.join(root, '.vx', 'cache.db'), '')
      const r = await vx(['cache', 'clear', '--cache-dir', '.vx'])
      expect(r.code).toBe(1)
      expect(r.err).toContain('holds the workspace config and lock')
      expect(existsSync(path.join(root, '.vx', 'sentinel.json'))).toBe(true)
    },
    TIMEOUT,
  )
})
