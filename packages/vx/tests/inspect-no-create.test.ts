// A reading verb makes nothing on disk (item 900). `vx last --cache-dir
// .vx/cahce` created the typo's directory, a `.gitignore` and a database,
// then said "no recorded runs yet"; so did `why`, `info` and a dry prune,
// and on a fresh workspace each of them created `.vx` before any run.

import { existsSync, realpathSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { addProject, makeWorkspace } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const TIMEOUT = 30_000

const VERBS = [
  ['last'],
  ['info'],
  ['why', 'app#build'],
  ['cache', 'prune', '--older-than', '1d', '--dry-run'],
]

async function vx(cwd: string, args: string[]): Promise<{ code: number; err: string }> {
  const proc = Bun.spawn([process.execPath, BIN, ...args], {
    cwd,
    stdout: 'ignore',
    stderr: 'pipe',
    env: { ...process.env, NO_COLOR: '1' },
  })
  const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited])
  return { code, err: err.trim() }
}

describe('a reading verb makes nothing on disk', () => {
  let root = ''
  beforeEach(async () => {
    // Canonical: the verb names the directory as its cwd resolves it, and
    // macOS's temp dir is a symlink (/var -> /private/var).
    root = realpathSync(await makeWorkspace({ prefix: 'vx-inspect-' }))
    await addProject(root, 'app', {
      config: `export default { tasks: { build: { exec: { command: 'true' } } } }\n`,
    })
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it(
    'on a workspace that never ran, no verb creates the cache directory',
    async () => {
      for (const args of VERBS) {
        await vx(root, args)
        expect({ args, made: existsSync(path.join(root, '.vx')) }).toEqual({ args, made: false })
      }
      // The positive: a run does make it, so the check above can see one.
      expect((await vx(root, ['run', 'build', '--all'])).code).toBe(0)
      expect(existsSync(path.join(root, '.vx', 'cache', 'cache.db'))).toBe(true)
    },
    TIMEOUT,
  )

  it(
    'a --cache-dir that is not there is refused by name and not created',
    async () => {
      const typo = path.join(root, '.vx', 'cahce')
      for (const args of VERBS) {
        const r = await vx(root, [...args, '--cache-dir', '.vx/cahce'])
        expect({ args, code: r.code, err: r.err, made: existsSync(typo) }).toEqual({
          args,
          code: 1,
          err: `vx: --cache-dir .vx/cahce: no such directory (${typo})`,
          made: false,
        })
      }
    },
    TIMEOUT,
  )
})
