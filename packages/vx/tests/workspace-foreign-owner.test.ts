// A `package.json` planted in a shared directory above a checkout
// (`/tmp/package.json` listing `*`) claimed it, and `vx info` in the
// checkout ran the planter's `vx.workspace.ts` as the user (Security,
// 2026-10-13; git's `safe.directory` case). The root walk now stops at a
// manifest another user owns, root aside; inside git it never goes above
// the top-level at all (workspace-git-root.test.ts).
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { findManifestRoot } from '../src/workspace/workspace.js'
import { skipAsRoot } from './helpers/nonroot-gate.js'

let shared: string

beforeEach(async () => {
  shared = await realpath(await mkdtemp(path.join(os.tmpdir(), 'vx-foreign-')))
  await writeFile(
    path.join(shared, 'package.json'),
    JSON.stringify({ name: 'planted', private: true, workspaces: ['*'] }),
  )
  await mkdir(path.join(shared, 'repo'))
  await writeFile(path.join(shared, 'repo', 'package.json'), JSON.stringify({ name: 'repo' }))
  await mkdir(path.join(shared, 'loose'))
})

afterEach(async () => {
  await rm(shared, { recursive: true, force: true })
})

const found = (dir: string, uid?: number): Promise<string> =>
  findManifestRoot(path.join(shared, dir), new Map(), uid).then(
    (r) => path.relative(shared, r) || '.',
    (err: Error) => `refused: ${err.message.slice(0, err.message.indexOf(' belongs'))}`,
  )

// Files this user writes are its own, so "another user" is a uid that is
// not this one; root owns everything it writes and trusts every owner.
it.skipIf(skipAsRoot('workspace foreign owner'))(
  "the walk stops above the start at another user's manifest, and names it when nothing is left",
  async () => {
    const other = process.getuid!() + 1
    expect({
      own: [await found('repo'), await found('loose')],
      other: [await found('repo', other), await found('loose', other)],
    }).toEqual({
      own: ['.', '.'],
      other: ['repo', `refused: ${path.join(shared, 'package.json')}`],
    })
  },
)
