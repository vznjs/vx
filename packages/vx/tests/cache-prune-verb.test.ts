// `vx cache prune` through the real binary: what a dry run leaves, what it
// says it would reap, and the exit outside a workspace. A sweep of
// `cli/cache.ts` (E-9) found each unheld: the dry-run flag could stop
// reaching the cache (a dry run that deletes), the orphan wording could
// swap, and a prune with no workspace could exit 0.

import { realpathSync } from 'node:fs'
import { mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { addProject, makeWorkspace } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const TIMEOUT = 30_000

async function vx(
  cwd: string,
  args: string[],
): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn([process.execPath, BIN, ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, NO_COLOR: '1' },
  })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, out, err }
}

describe('vx cache prune', () => {
  let root = ''
  let cacheDir = ''
  beforeEach(async () => {
    root = realpathSync(await makeWorkspace({ prefix: 'vx-prune-verb-' }))
    await addProject(root, 'app', {
      config: `export default { tasks: { build: {
        exec: { command: 'mkdir -p dist && echo built > dist/out.txt' },
        cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] } },
      } } }\n`,
    })
    await Bun.write(path.join(root, 'packages', 'app', 'src', 'i.txt'), 'x\n')
    cacheDir = path.join(root, '.vx', 'cache')
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  /** The artifacts in the cache directory, as `<hash>.tar.zst` names. */
  const artifacts = async (): Promise<string[]> =>
    (await readdir(cacheDir)).filter((n) => n.endsWith('.tar.zst')).sort()

  it(
    'a dry run deletes nothing and says what it would reap; the real one reaps it',
    async () => {
      expect((await vx(root, ['run', 'build', '--all'])).code).toBe(0)
      const saved = await artifacts()
      expect(saved).toHaveLength(1)
      // An artifact the index has no row for, older than the in-flight grace.
      const orphan = path.join(cacheDir, `${'ab'.repeat(8)}.tar.zst`)
      await writeFile(orphan, 'orphan')
      const old = new Date(Date.now() - 2 * 60 * 60 * 1000)
      await utimes(orphan, old, old)

      const dry = await vx(root, ['cache', 'prune', '--max-size', '1B', '--dry-run'])
      expect({ code: dry.code, err: dry.err }).toEqual({ code: 0, err: '' })
      expect(dry.out).toMatch(
        /^Would prune 1 entry \(\d+ B\), would reap 1 orphaned artifact \(6 B\)\n$/,
      )
      expect(await artifacts()).toEqual([...saved, path.basename(orphan)].sort())

      const real = await vx(root, ['cache', 'prune', '--max-size', '1B'])
      expect({ code: real.code, err: real.err }).toEqual({ code: 0, err: '' })
      expect(real.out).toMatch(
        /^Pruned 1 entry \(\d+ B freed\), reaped 1 orphaned artifact \(6 B\)\n$/,
      )
      expect(await artifacts()).toEqual([])
    },
    TIMEOUT,
  )

  it(
    'outside a workspace it exits 1 naming why',
    async () => {
      const bare = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'vx-prune-bare-')))
      try {
        const r = await vx(bare, ['cache', 'prune', '--max-size', '1G'])
        expect({ code: r.code, out: r.out }).toEqual({ code: 1, out: '' })
        expect(r.err).toStartWith('vx cache prune: Could not find a workspace root')
      } finally {
        await rm(bare, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )
})
