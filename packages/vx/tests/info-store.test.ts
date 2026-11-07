// `vx info`'s `cache store` names the store the next run opens. It named
// the one the index last recorded: after HOME moved, info pointed at the
// old home's store and counted its entries while a run opened another.

import { existsSync, readdirSync, realpathSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { addProject, makeWorkspace } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, 'helpers', 'vx-locked.ts')
const TIMEOUT = 30_000

describe('vx info names the store a run opens', () => {
  let root = ''
  let homes: string[] = []
  const vx = async (args: string[], home: string) => {
    const proc = Bun.spawn([process.execPath, BIN, ...args], {
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, NO_COLOR: '1', HOME: home, VX_CACHE_DIR: '' },
    })
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    return { code, out, err }
  }

  beforeEach(async () => {
    homes = [
      realpathSync(await mkdtemp(path.join(os.tmpdir(), 'vx-info-home-a-'))),
      realpathSync(await mkdtemp(path.join(os.tmpdir(), 'vx-info-home-b-'))),
    ]
    root = realpathSync(await makeWorkspace({ prefix: 'vx-info-store-', git: 'commit' }))
    await addProject(root, 'app', {
      config: `export default { tasks: { build: {
        exec: { command: 'mkdir -p dist && echo built > dist/out.txt' },
        inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] }, cache: true,
      } } }\n`,
      files: { 'src/i.txt': 'x\n' },
    })
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
    for (const h of homes) await rm(h, { recursive: true, force: true })
  })

  it(
    'after HOME moves, info names the new home store, empty, and makes nothing',
    async () => {
      const [before, after] = homes as [string, string]
      expect((await vx(['run', 'build', '--all'], before)).code).toBe(0)
      const [id] = readdirSync(path.join(before, '.vx'))
      const info = await vx(['info', '--format', 'json'], after)
      expect({ code: info.code, err: info.err }).toEqual({ code: 0, err: '' })
      const facts = JSON.parse(info.out) as { cacheStore: string | null; cacheEntries: number }
      expect(facts.cacheStore).toBe(path.join(after, '.vx', id!, 'cache'))
      expect(existsSync(path.join(after, '.vx'))).toBe(false)
      // The control: under the home the index recorded, the same store.
      const same = JSON.parse((await vx(['info', '--format', 'json'], before)).out) as {
        cacheStore: string | null
      }
      expect(same.cacheStore).toBe(path.join(before, '.vx', id!, 'cache'))
    },
    TIMEOUT,
  )
})
