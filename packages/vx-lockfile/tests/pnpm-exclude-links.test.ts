// pnpm's `excludeLinksFromLockfile: true` leaves every `link:` dependency
// out of pnpm-lock.yaml, so the lockfile no longer says which workspace
// package a project links. Read as it was, a's `"c": "link:../c"` was a
// dependency the lockfile lacked, and the run refused with "out of date"
// though `pnpm install` writes the same file; and a's key never saw c's
// own dependencies. The lockfile is the one pnpm 10.28 wrote for a →
// b (`workspace:*`) and a → c (`link:../c`), c → is-odd.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { DiscoverContext } from '@vzn/vx'
import { pnpm } from '../src/index.js'
import { importerDigests, parseLockfile } from '../src/pnpm.js'

const lockfile = (exclude: boolean, isOdd: string): string => `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: ${exclude}

importers:

  .: {}

  packages/a:
    dependencies:
      b:
        specifier: workspace:*
        version: link:../b
${
  exclude
    ? ''
    : `      c:
        specifier: link:../c
        version: link:../c
`
}
  packages/b: {}

  packages/c:
    dependencies:
      is-odd:
        specifier: ${isOdd}
        version: ${isOdd}

packages:

  is-odd@${isOdd}:
    resolution: {integrity: sha512-${isOdd}}

snapshots:

  is-odd@${isOdd}: {}
`

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-pnpm-exclude-links-'))
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'root' }))
  await writeFile(
    path.join(root, 'pnpm-workspace.yaml'),
    'packages:\n  - packages/*\nexcludeLinksFromLockfile: true\n',
  )
  const manifests: Record<string, Record<string, unknown>> = {
    a: { name: 'a', dependencies: { b: 'workspace:*', c: 'link:../c' } },
    b: { name: 'b' },
    c: { name: 'c', dependencies: { 'is-odd': '3.0.1' } },
  }
  for (const [name, pkg] of Object.entries(manifests)) {
    await mkdir(path.join(root, 'packages', name), { recursive: true })
    await writeFile(path.join(root, 'packages', name, 'package.json'), JSON.stringify(pkg))
  }
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
  const rel = (dir: string) => path.relative(root, dir) || '.'
  return (await pnpm().discover!(ctx)).map((e) => ({
    dir: rel(e.dir),
    deps: (e.deps ?? []).map(rel),
  }))
}

describe('pnpm(): excludeLinksFromLockfile', () => {
  it('a link: dependency on a workspace package is an edge, not a stale lockfile', async () => {
    await writeFile(path.join(root, 'pnpm-lock.yaml'), lockfile(true, '3.0.1'))
    expect(await discover()).toEqual([
      { dir: 'packages/a', deps: ['packages/b', 'packages/c'] },
      { dir: 'packages/b', deps: [] },
      { dir: 'packages/c', deps: [] },
    ])
    // CONTROL: a workspace: dependency the file still records, gone, refuses.
    await writeFile(
      path.join(root, 'packages/b/package.json'),
      JSON.stringify({ name: 'b', dependencies: { c: 'workspace:*' } }),
    )
    await expect(discover()).rejects.toThrow("does not list packages/b's dependency on c")
  })

  it('reads the setting from a CRLF lockfile, as from an LF one', async () => {
    // A Windows checkout (`core.autocrlf`) writes CRLF: the setting's block
    // read by its `\n` heading alone was not found, and the run refused a
    // lockfile `pnpm install` writes unchanged.
    await writeFile(
      path.join(root, 'pnpm-lock.yaml'),
      lockfile(true, '3.0.1').replace(/\n/g, '\r\n'),
    )
    expect(await discover()).toEqual([
      { dir: 'packages/a', deps: ['packages/b', 'packages/c'] },
      { dir: 'packages/b', deps: [] },
      { dir: 'packages/c', deps: [] },
    ])
  })

  it("a bump in a linked package's dependencies re-keys the project linking it", () => {
    const digests = (exclude: boolean, isOdd: string) =>
      importerDigests(parseLockfile(lockfile(exclude, isOdd)))
    const [before, after] = [digests(true, '3.0.1'), digests(true, '3.0.2')]
    expect(after.get('packages/a')).not.toBe(before.get('packages/a'))
    expect(after.get('packages/c')).not.toBe(before.get('packages/c'))
    // CONTROL: a lockfile that records its links keys each project by its own reach.
    const [kept, bumped] = [digests(false, '3.0.1'), digests(false, '3.0.2')]
    expect(bumped.get('packages/a')).not.toBe(kept.get('packages/a'))
    expect(bumped.get('packages/b')).toBe(kept.get('packages/b'))
  })
})
