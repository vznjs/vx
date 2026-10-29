// pnpm's `ignoredOptionalDependencies` drops an optional dependency from
// the install and from pnpm-lock.yaml, workspace packages included. c's
// `optionalDependencies: { b: 'workspace:*' }` under `ignoredOptionalDependencies:
// [b]` was then a dependency the lockfile lacked, and the run refused with
// "out of date" though `pnpm install` writes the same file. The lockfile
// is the shape pnpm 10.28 wrote (the list after `packages`).
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import type { DiscoverContext } from '@vzn/vx'
import { pnpm } from '../src/index.js'

const LOCK = (ignored: string): string => `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .: {}

  packages/b: {}

  packages/c: {}

packages: {}

ignoredOptionalDependencies:
  - ${ignored}
`

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-pnpm-ignored-optional-'))
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'root' }))
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n')
  for (const name of ['b', 'c']) await mkdir(path.join(root, 'packages', name), { recursive: true })
  await writeFile(path.join(root, 'packages/b/package.json'), JSON.stringify({ name: '@s/b' }))
  await writeFile(
    path.join(root, 'packages/c/package.json'),
    JSON.stringify({ name: 'c', optionalDependencies: { '@s/b': 'workspace:*' } }),
  )
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const discover = async () => {
  const ctx: DiscoverContext = {
    workspaceRoot: root,
    cacheDir: path.join(root, '.vx', 'cache'),
    projects: [],
    warn: () => {},
    worktreeChanges: async () => null,
  }
  return (await pnpm().discover!(ctx)).map((e) => path.relative(root, e.dir))
}

it('pnpm(): an optional dependency the install ignores is no stale lockfile', async () => {
  await writeFile(path.join(root, 'pnpm-lock.yaml'), LOCK("'@s/b'"))
  expect(await discover()).toEqual(['packages/b', 'packages/c'])
  // pnpm matches the names as patterns.
  await writeFile(path.join(root, 'pnpm-lock.yaml'), LOCK("'@s/*'"))
  expect(await discover()).toEqual(['packages/b', 'packages/c'])
  // CONTROL: another name ignored, and the same name under dependencies, refuse.
  await writeFile(path.join(root, 'pnpm-lock.yaml'), LOCK('fsevents'))
  await expect(discover()).rejects.toThrow("does not list packages/c's dependency on @s/b")
  await writeFile(path.join(root, 'pnpm-lock.yaml'), LOCK("'@s/b'"))
  await writeFile(
    path.join(root, 'packages/c/package.json'),
    JSON.stringify({ name: 'c', dependencies: { '@s/b': 'workspace:*' } }),
  )
  await expect(discover()).rejects.toThrow("does not list packages/c's dependency on @s/b")
})

it('pnpm(): the ignored list is read from a CRLF lockfile too', async () => {
  // A Windows checkout writes CRLF: the list's block, found by its `\n`
  // heading alone, read as none, and the run refused.
  await writeFile(path.join(root, 'pnpm-lock.yaml'), LOCK("'@s/b'").replace(/\n/g, '\r\n'))
  expect(await discover()).toEqual(['packages/b', 'packages/c'])
})
