// `vx cache clean` through the real binary: what a dry run leaves, what it
// says it would reap, and the exit outside a workspace. A sweep of
// `cli/cache.ts` (E-9) found each unheld: the dry-run flag could stop
// reaching the cache (a dry run that deletes), the orphan wording could
// swap, and a prune with no workspace could exit 0.

import { realpathSync } from 'node:fs'
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { storedKeys } from './helpers/stored-artifact.js'
import { addProject, makeWorkspace } from './helpers/workspace.js'
import { vx } from './helpers/vx.js'

const TIMEOUT = 30_000

describe('vx cache clean', () => {
  let root = ''
  let cacheDir = ''
  beforeEach(async () => {
    root = realpathSync(await makeWorkspace({ prefix: 'vx-prune-verb-' }))
    await addProject(root, 'app', {
      config: `export default { tasks: { build: {
        exec: { command: 'mkdir -p dist && echo built > dist/out.txt' },
        inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] }, cache: true,
      } } }\n`,
    })
    await Bun.write(path.join(root, 'packages', 'app', 'src', 'i.txt'), 'x\n')
    cacheDir = path.join(root, '.vx', 'cache')
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  /** The keys with an artifact in the cache directory, inline or as a file. */
  const artifacts = async (): Promise<string[]> => storedKeys(cacheDir)

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

      const dry = await vx(root, ['cache', 'clean', '--max-size', '1B', '--dry'])
      expect({ code: dry.code, err: dry.err }).toEqual({ code: 0, err: '' })
      expect(dry.out).toMatch(
        /^› vx cache clean {2}would free [\d.]+ K?B \(dry run\)\n\n {2}1 entry · 1 orphaned artifact\n$/,
      )
      expect(await artifacts()).toEqual([...saved, 'ab'.repeat(8)].sort())

      const real = await vx(root, ['cache', 'clean', '--max-size', '1B'])
      expect({ code: real.code, err: real.err }).toEqual({ code: 0, err: '' })
      expect(real.out).toMatch(
        /^✓ vx cache clean {2}freed [\d.]+ K?B\n\n {2}1 entry · 1 orphaned artifact\n$/,
      )
      expect(await artifacts()).toEqual([])
    },
    TIMEOUT,
  )

  // nx#35329: a cache directory several workspaces share grew without bound.
  it(
    'evicts from a cache directory outside the workspace, named by --cache-dir',
    async () => {
      const outside = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'vx-prune-shared-')))
      try {
        const flag = ['--cache-dir', outside]
        expect((await vx(root, ['run', 'build', '--all', ...flag])).code).toBe(0)
        expect(await storedKeys(outside)).toHaveLength(1)
        const r = await vx(root, ['cache', 'clean', '--max-size', '1B', ...flag])
        expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: '' })
        expect(await storedKeys(outside)).toEqual([])
      } finally {
        await rm(outside, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

  // A refusal the clean did not draw itself (a workspace config that throws)
  // was labelled `vx cache`, the first word typed.
  it(
    'a workspace config that throws is refused as vx cache clean, its code kept',
    async () => {
      await writeFile(path.join(root, '.vx', 'workspace.ts'), 'throw new Error("boom")\n')
      const r = await vx(root, ['cache', 'clean'])
      expect({ code: r.code, out: r.out }).toEqual({ code: 1, out: '' })
      expect(r.err).toStartWith('✗ vx cache clean  config refused\n')
      const json = await vx(root, ['cache', 'clean', '--format', 'json'])
      expect(JSON.parse(json.out).error.code).toBe('VX_E_CONFIG')
    },
    TIMEOUT,
  )

  it(
    'outside a workspace it exits 1 naming why',
    async () => {
      const bare = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'vx-prune-bare-')))
      try {
        const r = await vx(bare, ['cache', 'clean', '--max-size', '1G'])
        expect({ code: r.code, out: r.out }).toEqual({ code: 1, out: '' })
        expect(r.err).toStartWith('✗ vx cache clean  no .vx/workspace.ts in ')
        // Drawn as every verb draws it, the fix on its own line: it read
        // `… — run \`vx init\` to create one`, the JSON document's wording.
        const show = await vx(bare, ['show'])
        expect(r.err).toBe(show.err.replace('vx show', 'vx cache clean'))
        expect(r.err).toContain('fix  vx init')
      } finally {
        await rm(bare, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )
})
